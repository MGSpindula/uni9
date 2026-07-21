import {
    EntityState
} from "../core/EntityState";
import { WaitReason } from "./WaitReason";

export class InteractionNavigation {

    constructor(owner) {

        this.owner = owner;
        this.graph = owner.graph;
        this.connector = owner.connector;

    }

    beginRoute(context, point, onArrive) {

        context.pendingPosition = null;
        context.destinationId = null;
        context.pendingInteraction = { point, onArrive };
        context.retryElapsed = 0;
        context.blockedElapsed = null;
        context.recoveryPending = false;
    }

    createDirectConnectionRoute(actor, point) {

        const traversal = actor.navigation.getTraversalState();
        if (!traversal.currentConnection) return null;

        const accessPoint = point.via ?? point;
        const access = this.connector.connect(accessPoint);
        const currentIds = [
            traversal.currentConnection.fromId,
            traversal.currentConnection.toId
        ];
        const segmentNodeIds = access?.segmentNodeIds ?? access?.nodeIds;
        const usesCurrentConnection =
            segmentNodeIds?.length === 2 &&
            currentIds.every(id => segmentNodeIds.includes(id));

        if (!usesCurrentConnection) return null;

        // A direct approach from the current segment must remain on the lane
        // the actor already owns. Choosing by proximity could make it cross to
        // the opposite side immediately before the interaction anchor.
        const laneIndex = this.owner.trafficState.getConnectionLaneIndex(
            traversal.currentConnection.fromId,
            traversal.currentConnection.toId,
            actor
        );

        const waypoints = [{
            id: null,
            position: this.connector.getPortalPosition(
                accessPoint,
                access,
                laneIndex
            ),
            // This actor already occupies the connection, so this is observed
            // authority rather than a lane prediction.
            authorizedLaneIndex: laneIndex,
            leavingGraph: true,
            departureRequest: { connection: true }
        }];

        if (accessPoint !== point) {

            waypoints.push({
                id: null,
                position: accessPoint.getWorldPosition(),
                interactionPoint: accessPoint
            });

        }

        waypoints.push({
            id: null,
            position: point.getWorldPosition(),
            interactionPoint: point
        });

        return { waypoints };

    }

    handleWaypoint(context, waypoint) {

        const { actor } = context;

        if (waypoint.leavingGraph) {

            context.traversingInteractionCurve = false;
            this.owner.routeGeometry.clearActiveLaneCurve(actor);

            const traversal = actor.navigation.getTraversalState();

            if (traversal.currentNodeId) {

                this.owner.trafficState.releaseNode(
                    traversal.currentNodeId,
                    actor
                );
                // The portal is already outside the graph node. Keeping the
                // old id here made debug and recovery believe that the actor
                // was simultaneously at the node and at the InteractionPoint.
                actor.navigation.setCurrentNode(null);

            }

            if (traversal.currentConnection) {

                this.owner.trafficState.releaseConnection(
                    traversal.currentConnection.fromId,
                    traversal.currentConnection.toId,
                    actor
                );
                actor.navigation.leaveConnection();

            }

            if (waypoint.departureRequest?.originId) {

                this.owner.traffic.completeNodeDeparture(
                    actor,
                    waypoint.departureRequest.originId
                );

            }

            this.owner.refresh();
            return true;

        }

        if (waypoint.leavingInteraction) {

            context.traversingInteractionCurve = false;

            if (waypoint.graphEntryNodeId) {

                const nodeId = waypoint.graphEntryNodeId;

                // Ambient points connect directly to one graph node. They do
                // not have a lane callback that would normally set this
                // ownership, so entering the portal must do it explicitly.
                this.owner.traffic.claimPhysicalArrival(nodeId, actor);

                if (!this.owner.trafficState.isNodeAvailable(nodeId, actor) ||
                    !this.owner.trafficState.occupyNode(nodeId, actor)) {

                    this.owner.traffic.setWaitReason(
                        actor,
                        nodeId,
                        WaitReason.NODE_OCCUPIED
                    );
                    // Keep this waypoint current until the node is truly
                    // available; CharacterNavigationSystem forwards this
                    // explicit result to Character as a rejected arrival.
                    return "waiting";

                }

                actor.navigation.setCurrentNode(nodeId);
                this.owner.traffic.completeNodeArrival(nodeId, actor);
                this.owner.traffic.clearWaitReason(actor);

            }

            this.owner.traffic.completeInteractionDeparture(
                actor,
                waypoint.connectionEntry?.originKey
            );
            this.owner.completeInteractionExit(context);
            this.owner.refresh();
            return true;

        }

        if (!waypoint.interactionPoint) return false;

        if (waypoint.interactionExitPoint) {

            // Reaching approach during an exit is not a new interaction. The
            // actor now occupies this physical staging point, but continues to
            // own action/seat until leavingInteraction is really crossed.
            this.connector.occupyPoint(waypoint.interactionPoint, actor);
            context.interactionExitPoint = waypoint.interactionPoint;
            this.owner.refresh();
            return true;

        }

        if (waypoint.interactionPoint) {

            const traversal =
                actor.navigation
                    .getTraversalState();

            if (traversal.currentNodeId) {

                this.owner.trafficState.releaseNode(
                    traversal.currentNodeId,
                    actor
                );

                actor.navigation
                    .setCurrentNode(null);

            }

            if (traversal.currentConnection) {

                this.owner.trafficState.releaseConnection(
                    traversal.currentConnection.fromId,
                    traversal.currentConnection.toId,
                    actor
                );

                actor.navigation
                    .leaveConnection();

            }

        }

        if (context.interactionPoint !== waypoint.interactionPoint) {

            this.owner.leaveInteractionPoint(context);
            this.connector.occupyPoint(waypoint.interactionPoint, actor);
            context.interactionPoint = waypoint.interactionPoint;

        }

        const interaction = context.pendingInteraction;

        if (!context.preparingInteraction &&
            interaction?.point.via === waypoint.interactionPoint) {

            context.preparingInteraction = true;
            actor.pause();
                interaction.point.entity?.prepareInteraction(
                    actor,
                    waypoint.interactionPoint,
                    interaction.point,
                    () => {

                        context.preparingInteraction = false;
                        // The authored entry animation may move object3D from
                        // approach to action. Its root transform is now the
                        // source of truth, so Locomotion must project that
                        // position onto the action segment instead of resuming
                        // with the old approach arc distance and walking back.
                        actor.locomotion.resetCurve();
                        context.recoveryElapsed = 0;
                        context.recoveryPosition.copy(actor.object3D.position);
                        actor.resume();

                    }
                );

        }

        if (
            interaction?.point ===
            waypoint.interactionPoint
        ) {

            const entered =
                interaction.onArrive?.();

            context.pendingInteraction =
                null;

            if (entered === false) {

                this.owner
                    .leaveInteractionPoint(
                        context
                    );

                actor.cancel();

                this.owner.refresh();

                return true;

            }

            context.activeInteraction = {
                target:
                    waypoint
                        .interactionPoint
                        .entity,

                point:
                    waypoint
                        .interactionPoint
            };

            actor.setState(
                EntityState.IDLE
            );

            if (context.deferredCommand) {

                // A command issued during the entry animation begins only
                // after the original action is fully established. Replacing
                // the route here is safe because Character checks revisions.
                this.owner.executeDeferredCommand(context);

            }

        }

        this.owner.refresh();
        return true;

    }

}
