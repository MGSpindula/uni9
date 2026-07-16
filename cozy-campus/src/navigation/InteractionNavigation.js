import { NavigationNodeMode } from "./NavigationNodeMode";

export class InteractionNavigation {

    constructor(owner) {

        this.owner = owner;
        this.graph = owner.graph;
        this.connector = owner.connector;

    }

    beginRoute(context, point, onArrive) {

        context.pendingPosition = null;
        context.nodeMode = NavigationNodeMode.TRANSIT;
        context.destinationId = null;
        context.pendingInteraction = { point, onArrive };
        context.retryElapsed = 0;
        context.blockedElapsed = null;
        context.recoveryPending = false;
        this.owner.cancelPendingParking(context);

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
            position: access.projectedPosition.clone(),
            leavingGraph: true
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

            const traversal = actor.navigation.getTraversalState();

            if (traversal.currentNodeId) {

                this.graph.releaseNode(traversal.currentNodeId, actor);

            }

            if (traversal.currentConnection) {

                this.graph.releaseConnection(
                    traversal.currentConnection.fromId,
                    traversal.currentConnection.toId,
                    actor
                );
                actor.navigation.leaveConnection();

            }

            this.owner.refresh();
            return true;

        }

        if (waypoint.leavingInteraction) {

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
            actor.object3D.rotation.y =
                waypoint.interactionPoint.getWorldRotationY();
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
