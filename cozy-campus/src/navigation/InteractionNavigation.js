import { NavigationNodeMode } from "./NavigationNodeMode";

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
        const usesCurrentConnection =
            access?.nodeIds?.length === 2 &&
            currentIds.every(id => access.nodeIds.includes(id));

        if (!usesCurrentConnection) return null;

        const waypoints = [{
            id: null,
            position: this.connector.getPortalPosition(accessPoint, access),
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
            this.graph.clearActiveLaneCurve(actor);

            const traversal = actor.navigation.getTraversalState();

            if (traversal.currentNodeId) {

                this.graph.releaseNode(traversal.currentNodeId, actor);
                this.owner.retryFreedDwellSpot(
                    traversal.currentNodeId,
                    actor
                );

            }

            // A dwell spot is a separate resource from its navigation node.
            // Leaving the graph for a chair, item or other interaction must
            // release both; otherwise the helper keeps showing a ghost owner.
            this.owner.releaseDwellOccupancy(actor);
            this.owner.releaseDwellReservation(actor);

            if (traversal.currentConnection) {

                this.graph.releaseConnection(
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

            this.owner.traffic.completeInteractionDeparture(
                actor,
                waypoint.connectionEntry?.originKey
            );
            this.owner.leaveInteractionPoint(context);
            this.owner.refresh();
            return true;

        }

        if (!waypoint.interactionPoint) return false;

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
                    actor.resume();

                }
            );

        }

        if (interaction?.point === waypoint.interactionPoint) {

            context.pendingInteraction = null;
            // Character already completed the point's smooth arrivalDirection
            // alignment before this interaction callback was allowed to run.
            interaction.onArrive?.();
            context.activeInteraction = {
                target: waypoint.interactionPoint.entity,
                point: waypoint.interactionPoint
            };

        }

        this.owner.refresh();
        return true;

    }

}
