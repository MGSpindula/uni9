import * as THREE from "three";
import { Entity } from "../core/Entity";
import { EntityState } from "../core/EntityState";
import { Navigation } from "../navigation/Navigation";
import { AnimationController } from "./AnimationController";
import { Locomotion } from "./Locomotion";

export class Character extends Entity {

    constructor(name = "Character") {

        super(name);

        // All characters share the same movement contract. PlayerController and
        // NPC behavior only differ in where their commands come from.
        this.object3D = new THREE.Group();
        this.visual = null;

        this.navigation = new Navigation();
        this.locomotion = new Locomotion(this.object3D);
        this.animation = null;

        this.waypointReachedHandler = null;
        this.segmentRequestedHandler = null;
        this.localPointRequestedHandler = null;
        this.localConnectionRequestedHandler = null;
        this.navigationCancelledHandler = null;

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

    setSegmentRequestedHandler(handler) {

        this.segmentRequestedHandler = handler;

    }

    setLocalPointRequestedHandler(handler) {

        this.localPointRequestedHandler = handler;

    }

    setLocalConnectionRequestedHandler(handler) {

        this.localConnectionRequestedHandler = handler;

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

    // -----------------------------
    // Lifecycle
    // -----------------------------

    update(delta) {

        super.update(delta);
        this.updateMovement(delta);
        this.animation?.update(delta);

    }

    updateMovement(delta) {

        if (this.navigation.isPaused()) return;

        const waypoint = this.navigation.getCurrentWaypoint();

        if (!waypoint || !this.prepareTraversalTo(waypoint)) return;

        const reached = this.locomotion.moveTo(waypoint.position, delta);

        if (!reached) return;

        const completedConnection = waypoint.id
            ? this.navigation.reachNode(waypoint.id)
            : null;

        this.waypointReachedHandler?.(waypoint, completedConnection);

        const result = this.navigation.advance();

        if (result.finished) {

            // A waypoint callback may promote arrival to STOPPING/DWELLING.
            // Do not overwrite that more specific state with generic IDLE.
            if (this.isState(EntityState.WALKING)) {

                this.setState(
                    result.shouldWait
                        ? EntityState.WAITING
                        : EntityState.IDLE
                );

            }

        }

    }

    prepareTraversalTo(waypoint) {

        if (waypoint.connectionEntry) {

            const allowed = this.localConnectionRequestedHandler?.(
                waypoint.connectionEntry
            ) ?? true;

            if (!allowed) {

                this.pause();
                return false;

            }

        }

        if (waypoint.interactionPoint) {

            const allowed = this.localPointRequestedHandler?.(
                waypoint.interactionPoint
            ) ?? true;

            if (!allowed) {

                this.pause();
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
            waypoint.id
        ) ?? true;

        if (!allowed) {

            this.pause();
            return false;

        }

        this.navigation.beginConnection(
            traversal.currentNodeId,
            waypoint.id
        );

        return true;

    }

    onStateChanged(previous, current) {

        this.animation?.play(current);

    }

}
