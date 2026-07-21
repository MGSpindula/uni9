// Planejamento puro em relação ao ator: escolhe origem, destino e sequência
// topológica, mas nunca move o ator nem cria/libera reservas.
export class RoutePlanner {

    constructor(navigation) {

        this.navigation = navigation;
        this.graph = navigation.graph;
        this.connector = navigation.connector;

    }

    findInteractionRouteCandidate(context, point) {

        return this.getOrigins(context)
            .sort((first, second) => first.accessCost - second.accessCost)
            .map(origin => ({
                origin,
                route: this.connector.createRoute(
                    point,
                    origin.id,
                    context.actor,
                    {
                        avoidFirstStepTo:
                            this.navigation.getAvoidFirstStepTo(context, origin.id)
                    }
                )
            }))
            .find(candidate => candidate.route) ?? null;

    }

    findInteractionPreflight(context, point) {

        const accessPoint = point.via ?? point;
        const access = this.connector.connect(accessPoint);

        if (!access) return null;

        const traversal = context.actor.navigation.getTraversalState();
        let originIds = [];

        if (context.interactionPoint) {

            const currentAccess = this.connector.connect(
                context.interactionPoint.via ?? context.interactionPoint
            );

            originIds = currentAccess?.nodeIds ?? [];

        } else if (traversal.currentNodeId) {

            originIds = [traversal.currentNodeId];

        } else if (traversal.currentConnection) {

            originIds = [
                traversal.currentConnection.fromId,
                traversal.currentConnection.toId
            ];

        }

        const candidates = [];

        for (const originId of originIds) {

            if (this.graph.isNodeBlocked(originId)) continue;

            const route = this.connector.createRoute(
                point,
                originId,
                context.actor,
                {
                    avoidFirstStepTo:
                        this.navigation.getAvoidFirstStepTo(context, originId)
                }
            );

            if (route) candidates.push({ originId, route });

        }

        if (candidates.length === 0) return null;

        const selected = candidates.reduce((best, candidate) =>
            candidate.route.cost < best.route.cost ? candidate : best
        );
        const graphNodeIds = this.navigation.getGraphWaypointIds(
            selected.route.waypoints
        );

        return {
            originId: selected.originId,
            nextNodeId: graphNodeIds[1] ?? null,
            requiresUTurn: selected.route.requiresUTurn
        };

    }

    findBestPlan(context, position, maxDetourFactor = 3) {

        const candidates = this.getOrigins(context)
            .map(origin => {

                const avoidFirstStepTo = this.navigation.getAvoidFirstStepTo(
                    context,
                    origin.id
                );
                let plan = this.navigation.pathfinder.planClosestPath(
                    origin.id,
                    position,
                    context.actor,
                    { maxDetourFactor, avoidFirstStepTo }
                );

                if (plan.status === "unreachable" && avoidFirstStepTo) {

                    plan = this.navigation.pathfinder.planClosestPath(
                        origin.id,
                        position,
                        context.actor,
                        { maxDetourFactor }
                    );

                }

                return {
                    originId: origin.id,
                    accessCost: origin.accessCost,
                    plan,
                    requiresUTurn:
                        plan.nodeIds[1] === avoidFirstStepTo
                };

            })
            .filter(candidate => candidate.plan.status !== "unreachable");

        if (candidates.length === 0) return null;

        return candidates.reduce((best, current) =>
            current.accessCost + current.plan.cost <
                best.accessCost + best.plan.cost ? current : best
        );

    }

    getOrigins(context) {

        const { actor, interactionPoint } = context;

        if (interactionPoint) {

            const accessPoint = interactionPoint.via ?? interactionPoint;
            const connection = this.connector.connect(accessPoint);

            if (!connection) return [];

            return connection.nodeIds
                // Occupancy is temporary and must not force an interaction
                // exit through the opposite endpoint. Planning keeps the
                // intended endpoint and traffic waits at approach if needed.
                .filter(id => !this.graph.isNodeBlocked(id))
                .map(id => ({
                    id,
                    accessCost: Math.sqrt(
                        this.navigation.routeGeometry.getPlanarDistanceSquared(
                            connection.projectedPosition,
                            this.graph.requireNode(id).position
                        )
                    )
                }));

        }

        const traversal = actor.navigation.getTraversalState();

        if (traversal.currentNodeId) {
            return [{ id: traversal.currentNodeId, accessCost: 0 }];
        }

        if (!traversal.currentConnection) return [];

        return [
            traversal.currentConnection.fromId,
            traversal.currentConnection.toId
        ]
            .filter(id =>
                this.navigation.trafficState.isNodeAvailable(id, actor)
            )
            .map(id => ({
                id,
                accessCost: Math.sqrt(
                    this.navigation.routeGeometry.getPlanarDistanceSquared(
                        actor.object3D.position,
                        this.graph.requireNode(id).position
                    )
                )
            }));

    }

    resolveInteractionExitTraversal(context, originId, nodeIds) {

        const unchanged = {
            exitNodeId: originId,
            nodeIds,
            skippedOrigin: false
        };

        if (!context.interactionPoint ||
            nodeIds.length < 2 ||
            nodeIds[0] !== originId) return unchanged;

        const accessPoint = context.interactionPoint.via ??
            context.interactionPoint;
        const access = this.connector.connect(accessPoint, { silent: true });
        const segmentNodeIds = access?.segmentNodeIds ?? access?.nodeIds;
        const nextNodeId = nodeIds[1];
        const crossesAccessSegment = segmentNodeIds?.length === 2 &&
            segmentNodeIds.includes(originId) &&
            segmentNodeIds.includes(nextNodeId);

        if (!crossesAccessSegment) return unchanged;

        // The generated approach portal already lies inside this connection.
        // Going to originId first and immediately traversing the same segment
        // back to nextNodeId would mean portal -> lane start -> portal -> lane
        // end. Treat the approach portal as the physical start of this first
        // connection and proceed directly to its intended endpoint instead.
        return {
            exitNodeId: nextNodeId,
            nodeIds: nodeIds.slice(1),
            skippedOrigin: true
        };

    }

}
