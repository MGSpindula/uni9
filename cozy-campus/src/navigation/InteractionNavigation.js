import {
    EntityState
} from "../core/EntityState";
import { WaitReason } from "./WaitReason";

export class InteractionNavigation {

    constructor(owner) {

        this.owner = owner;
        this.graph = owner.graph;
        this.connector = owner.connector;
        this.interactionTraffic = owner.interactionTraffic;

    }

    beginRoute(context, point, onArrive) {

        context.intent.position = null;
        context.intent.destinationId = null;
        context.intent.interaction = { point, onArrive };
        context.wait.retryElapsed = 0;
        context.wait.blockedElapsed = null;
        context.recovery.pending = false;
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

            context.traversal.interactionCurve = false;
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

            context.traversal.interactionCurve = false;

            if (waypoint.graphEntryNodeId) {

                const nodeId = waypoint.graphEntryNodeId;

                const crossing = actor.navigation.getNextWaypoint() !== null;

                if (
                    !this.owner.traffic
                        .claimPhysicalArrival(
                            nodeId,
                            actor,
                            {
                                waypoint,

                                entry:
                                    waypoint.nodeEntry ??
                                    null
                            }
                        )
                ) {

                    return "waiting";

                }

                if (
                    !this.owner.traffic
                        .canCrossNode(
                            nodeId,
                            actor
                        ) ||
                    !this.owner.traffic
                        .occupyGrantedNode(
                            nodeId,
                            actor,
                            {
                                crossing
                            }
                        )
                ) {

                    return "waiting";

                }

                actor.navigation.setCurrentNode(nodeId);
                this.owner.traffic.completeNodeArrival(nodeId, actor);
                this.owner.traffic.clearWaitReason(actor);

            }

            this.owner.traffic
                .completeInteractionDeparture(
                    actor,

                    waypoint.connectionEntry
                        ?.originKey ??
                    waypoint.nodeEntry
                        ?.originKey
                );
            this.owner.completeInteractionExit(context);
            this.owner.refresh();
            return true;

        }

        if (!waypoint.interactionPoint) return false;

        if (
            waypoint.interactionExitPoint
        ) {

            /*
             * O ApproachPoint já foi reservado durante
             * beginInteractionExit(). occupyPoint()
             * converte a reserva em ocupação.
             */
            const occupied =
                this.interactionTraffic
                    .occupyPoint(
                        waypoint.interactionPoint,
                        actor
                    );

            if (!occupied) {

                return "waiting";

            }

            context.traversal
                .interactionExitPoint =
                waypoint.interactionPoint;

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

        if (
            context.traversal
                .interactionPoint !==
            waypoint.interactionPoint
        ) {

            this.owner
                .leaveInteractionPoint(
                    context
                );

            const occupied =
                this.interactionTraffic
                    .occupyPoint(
                        waypoint.interactionPoint,
                        actor
                    );

            if (!occupied) {

                return "waiting";

            }

            context.traversal
                .interactionPoint =
                waypoint.interactionPoint;

        }

        const interaction = context.intent.interaction;

        if (!context.interaction.entering &&
            interaction?.point.via === waypoint.interactionPoint) {

            context.interaction.entering = true;
            actor.pause();
            interaction.point.entity?.prepareInteraction(
                actor,
                waypoint.interactionPoint,
                interaction.point,
                () => {

                    context.interaction.entering = false;
                    // The authored entry animation may move object3D from
                    // approach to action. Its root transform is now the
                    // source of truth, so Locomotion must project that
                    // position onto the action segment instead of resuming
                    // with the old approach arc distance and walking back.
                    actor.locomotion.resetCurve();
                    context.recovery.elapsed = 0;
                    context.recovery.position.copy(actor.object3D.position);
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

            context.intent.interaction =
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

            context.interaction.active = {
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

            if (context.intent.deferredCommand) {

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
