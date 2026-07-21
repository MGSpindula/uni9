import * as THREE from "three";
import { Entity } from "../core/Entity";
import { EntityState } from "../core/EntityState";
import { Navigation } from "../navigation/Navigation";
import { AnimationController } from "./AnimationController";
import { Locomotion } from "./Locomotion";
import { AnimationPresets } from "../core/AnimationPresets";
import { Tween } from "../core/Tween";

export class Character extends Entity {

    constructor(name = "Character") {

        super(name);

        // All characters share the same movement contract. PlayerController and
        // NPC behavior only differ in where their commands come from.
        this.object3D = new THREE.Group();
        this.visual = null;
        this.forwardHelper = null;

        this.navigation = new Navigation();
        this.navigationPriority = 0;
        this.traversalType = "flat";
        this.locomotion = new Locomotion(this.object3D);
        this.animation = null;
        this.grounding = null;

        this.waypointReachedHandler = null;
        this.waypointArrivalGuard = null;
        this.segmentRequestedHandler = null;
        this.localPointRequestedHandler = null;
        this.localConnectionRequestedHandler = null;
        this.departureRequestedHandler = null;
        this.navigationCancelledHandler = null;
        this.movementGuard = null;

        // Keep a wider base circle so contacts are predicted sooner and actors
        // separate without vibrating while trying to occupy the same lane.
        this.collisionRadius = 0.42;
        // Actors whose roots differ more than this are on separate vertical
        // layers and must not block or push one another in the XZ circle solver.
        this.collisionHeight = 1.2;
        // Navigation owns two different things: the current route and the
        // actor's intent. A route may be cancelled/rebuilt by traffic or
        // collision recovery without silently discarding the requested target.
        // Autonomous controllers may opt into "replaceable" so their behavior
        // can abandon a failed task and choose another one after a timeout.
        this.navigationIntentPolicy = "persistent";
        this.navigationCapabilities = {
            maxSlope: THREE.MathUtils.degToRad(35),
            stairs: true
        };

    }

    // -----------------------------
    // Visual setup
    // -----------------------------

    setVisual(visual, { floorOffset = 0 } = {}) {

        if (this.visual) this.object3D.remove(this.visual);

        this.visual = visual;
        this.visual.position.y = floorOffset;
        this.object3D.add(this.visual);
        this.animation = new AnimationController(this.visual);

    }

    // -----------------------------
    // Navigation commands
    // -----------------------------

    followWaypoints(waypoints, options = {}) {

        if (waypoints.length === 0) {

            this.stop();
            return;

        }

        this.navigation.setWaypoints(waypoints, options);
        this.setState(EntityState.WALKING);

    }

    setWaypointReachedHandler(handler) {

        this.waypointReachedHandler = handler;

    }

    setWaypointArrivalGuard(handler) {

        this.waypointArrivalGuard = handler;

    }

    setSegmentRequestedHandler(handler) {

        this.segmentRequestedHandler = handler;

    }

    setLocalPointRequestedHandler(handler) {

        this.localPointRequestedHandler = handler;

    }

    setGrounding(grounding) {

        this.grounding = grounding;

    }

    addForwardHelper({
        height = 2,
        length = 0.9,
        color = 0xffff00
    } = {}) {

        if (this.forwardHelper) {

            this.object3D.remove(this.forwardHelper);

        }

        // Locomotion rotates object3D with lookAt(), whose local forward axis
        // for a regular Object3D is +Z. Keep this helper on the root so visual
        // animation never changes the direction it is reporting.
        this.forwardHelper = new THREE.ArrowHelper(
            new THREE.Vector3(0, 0, 1),
            new THREE.Vector3(0, height, 0),
            length,
            color,
            0.28,
            0.16
        );
        this.forwardHelper.name = `${this.name}:ForwardHelper`;
        this.forwardHelper.line.raycast = () => {};
        this.forwardHelper.cone.raycast = () => {};
        this.object3D.add(this.forwardHelper);

        return this.forwardHelper;

    }

    setLocalConnectionRequestedHandler(handler) {

        this.localConnectionRequestedHandler = handler;

    }

    setDepartureRequestedHandler(handler) {

        this.departureRequestedHandler = handler;

    }

    setNavigationCancelledHandler(handler) {

        this.navigationCancelledHandler = handler;

    }

    pause() {

        this.navigation.pause();
        this.setState(EntityState.WAITING);

    }

    resume() {

        if (!this.navigation.hasPath()) return;

        this.navigation.resume();
        this.setState(EntityState.WALKING);

    }

    cancel() {

        this.navigation.cancel();
        this.navigationCancelledHandler?.(
            this.navigation.getTraversalState()
        );
        this.setState(EntityState.IDLE);

    }

    stop() {

        this.cancel();

    }

    setMovementGuard(handler) {

        this.movementGuard = handler;

    }

    // -----------------------------
    // Navigation presentation hooks
    // -----------------------------

    onTrafficWaitStarted(wait) {

        // Future animation hook. Examples by reason:
        // QUEUE_HEAD / ENDPOINT_WAIT: stop and glance at the passing actor;
        // LANE_FULL: hesitate and inspect the other lane;
        // HARD_BLOCKED: react as if the route is unavailable.
        // Animate `visual`; navigation continues owning object3D.
        void wait;

    }

    onTrafficWaitTimeout(wait) {

        // Called once per prolonged-wait interval. This is where a Character
        // may later play "look around", "ask for passage" or one deliberate
        // step-aside animation. Base Character never moves object3D, cancels
        // the route or discards the actor's intent here.
        void wait;

    }

    onTrafficWaitEnded(wait) {

        // Future animation hook: finish the yielding pose before walk resumes.
        void wait;

    }

    onNodeEvacuationStarted(event) {

        // Emergency node clearance. Navigation may use the opposite (left)
        // lane when both normal claims would otherwise trap this actor on the
        // junction. A future animation can glance back or signal passage here.
        void event;

    }

    onTrafficReservationYielded(event) {

        // This actor had only reserved a lane; an actor physically occupying
        // the node needed it to leave. Keep the route and retry naturally.
        // Future presentation may add a short hesitation on `visual`.
        void event;

    }

    // -----------------------------
    // Lifecycle
    // -----------------------------

    update(delta) {

        super.update(delta);
        this.updateMovement(delta);
        this.grounding?.update(this);
        this.animation?.update(delta, this.locomotion.getMotionState());

    }

    updateMovement(delta) {

        this.locomotion.beginFrame();

        let waypoint = this.navigation.getCurrentWaypoint();

        // A movement guard may only brake locomotion. It cannot replace the
        // authored Navigation curve with an improvised sidestep.
        const movementAllowed = this.movementGuard?.(
            waypoint?.position ?? null,
            delta
        );

        if (movementAllowed === false) {

            this.setState(EntityState.WAITING);
            return;

        }

        if (this.navigation.isPaused()) return;

        // Re-read after the guard in case another system paused navigation.
        waypoint = this.navigation.getCurrentWaypoint();

        if (!waypoint || !this.prepareTraversalTo(waypoint)) return;

        const movementOptions = {
            // Facing always follows the authored route unless the waypoint
            // explicitly preserves an interaction pose.
            rotate: !waypoint.preserveFacing,
            // Every ordinary walk is surface-following: route owns XZ and
            // Grounding owns Y. Only explicit jump/fly waypoints are airborne.
            //
            // Use { airborne: true } when Navigation must control XYZ itself,
            // for example during a jump, flight, fall or authored traversal
            // that intentionally leaves the ground. Do NOT use it for slopes,
            // stairs or hills: those remain attached to walkable geometry and
            // must let CharacterGrounding determine their physical height.
            followSurface: waypoint.airborne !== true
        };
        const reached = waypoint.routeCurve
            ? this.locomotion.moveAlongCurve(
                waypoint.routeCurve,
                delta,
                {
                    ...movementOptions,
                    startDistance: waypoint.curveStartDistance,
                    stopDistance: waypoint.curveStopDistance,
                    finishCurve: waypoint.routeCurveFinal !== false
                }
            )
            : this.locomotion.moveTo(
                waypoint.position,
                delta,
                movementOptions
            );

        if (this.isState(EntityState.WAITING) &&
            this.locomotion.getMotionState().moving) {

            this.setState(EntityState.WALKING);

        }

        if (!reached) {

            if (this.locomotion.isBlockedBySlope()) {

                this.pause();

            }

            return;

        }

        // Position and facing are both part of arriving at authored animation
        // marks such as approach and terminal interaction points. The callback runs only
        // after the smooth locomotion rotation has also finished.
        if (waypoint.arrivalDirection &&
            !this.locomotion.alignToDirection(
                waypoint.arrivalDirection,
                delta
            )) return;

        const traversalBeforeArrival = this.navigation.getTraversalState();
        const completedConnection = waypoint.id
            ? traversalBeforeArrival.currentConnection
            : null;
        const canAcceptArrival = this.waypointArrivalGuard?.(
            waypoint,
            completedConnection,
        ) ?? true;

        if (!canAcceptArrival) return;

        if (waypoint.id) this.navigation.reachNode(waypoint.id);

        const completedRouteRevision = this.navigation.getRouteRevision();

        const waypointAccepted = this.waypointReachedHandler?.(
            waypoint,
            completedConnection,
            { afterArrival: true }
        );

        // Arrival ownership can change while the actor is on the connection.
        // Keep this waypoint current until its node can actually be occupied.
        if (waypointAccepted === false) return;

        // The callback is allowed to create a follow-up route. Advancing here
        // would skip its first waypoint, possibly asking NavigationGraph for a
        // connection between non-neighbouring nodes.
        if (this.navigation.getRouteRevision() !== completedRouteRevision) {

            return;

        }

        const result = this.navigation.advance();

        if (result.finished) {

            // A waypoint callback may promote arrival to STOPPING or begin an interaction.
            // Do not overwrite that more specific state with generic IDLE.
            if (this.isState(EntityState.WALKING)) {

                this.setState(
                    result.shouldWait
                        ? EntityState.WAITING
                        : EntityState.IDLE
                );

            }

        } else if (waypoint.id) {

            // advance() has selected a different waypoint. Prepare that next
            // segment now, without recursively preparing the completed node.
            const nextWaypoint = this.navigation.getCurrentWaypoint();

            if (nextWaypoint && nextWaypoint !== waypoint) {

                this.prepareTraversalTo(nextWaypoint);

            }

        }

    }

    prepareTraversalTo(waypoint) {

        if (waypoint.departureDirection &&
            !waypoint.departureDirectionApplied) {

            // Departure poses are authored as the exact opposite of entry.
            // Apply this to the logical root before Locomotion or any Bézier
            // sample can reuse the old facing. A future animation may hide the
            // instantaneous logical turn on the visual/bone layer.
            const direction = waypoint.departureDirection;

            this.object3D.lookAt(
                this.object3D.position.x + direction.x,
                this.object3D.position.y,
                this.object3D.position.z + direction.z
            );
            waypoint.departureDirectionApplied = true;

        }

        if (waypoint.departureRequest) {

            const allowed = this.departureRequestedHandler?.(
                waypoint.departureRequest,
                waypoint
            ) ?? true;

            if (!allowed) {

                this.pauseIfRouteUnchanged(waypoint);
                return false;

            }

        }

        if (waypoint.connectionEntry) {

            const allowed = this.localConnectionRequestedHandler?.(
                waypoint.connectionEntry,
                waypoint
            ) ?? true;

            if (!allowed) {

                this.pauseIfRouteUnchanged(waypoint);
                return false;

            }

        }

        if (waypoint.interactionPoint) {

            waypoint.preserveFacing ??=
                waypoint.interactionPoint.metadata.preserveFacing === true;

            if (!waypoint.preserveFacing) {

                waypoint.arrivalDirection ??=
                    waypoint.interactionPoint.getWorldDirection();

            }

            const allowed = this.localPointRequestedHandler?.(
                waypoint.interactionPoint
            ) ?? true;

            if (!allowed) {

                this.pauseIfRouteUnchanged(waypoint);
                return false;

            }

        }

        if (!waypoint.id) return true;

        const traversal = this.navigation.getTraversalState();

        if (traversal.currentNodeId === waypoint.id) return true;

        if (traversal.currentConnection) {

            const isEndpoint =
                traversal.currentConnection.fromId === waypoint.id ||
                traversal.currentConnection.toId === waypoint.id;

            if (isEndpoint) return true;

        }

        if (!traversal.currentNodeId) return false;

        const allowed = this.segmentRequestedHandler?.(
            traversal.currentNodeId,
            waypoint.id,
            waypoint
        ) ?? true;

        if (!allowed) {

            this.pauseIfRouteUnchanged(waypoint);
            return false;

        }

        this.navigation.beginConnection(
            traversal.currentNodeId,
            waypoint.id
        );

        return true;

    }

    pauseIfRouteUnchanged(requestedWaypoint) {

        // Traffic handlers return false both for a real wait and after they
        // insert curve samples before the requested waypoint. Only the former
        // should pause navigation.
        if (this.navigation.getCurrentWaypoint() === requestedWaypoint) {

            this.pause();

        }

    }

    onStateChanged(previous, current) {

        this.animation?.play(current);

    }

}
