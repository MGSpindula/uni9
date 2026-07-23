// Pure route search over NavigationGraph topology.
// Traffic is an optional read-only constraint: omit it to validate structural
// reachability without actors, reservations or a running world.
export class Pathfinder {

    constructor(graph, traffic = null, metrics = null) {

        this.graph = graph;
        this.traffic = traffic;
        this.metrics = metrics;

    }

    planClosestPath(
        startId,
        position,
        agent = null,
        {
            maxDetourFactor = 3,
            avoidFirstStepTo = null
        } = {}
    ) {

        const destination =
            this.findClosestNode(
                position
            );

        if (
            !destination ||
            destination.blocked
        ) {

            return {
                status:
                    "unreachable",

                nodeIds:
                    []
            };

        }

        const directPlan =
            this.findShortestPath(
                startId,
                destination.id,
                {
                    agent,

                    avoidOccupied:
                        false,

                    avoidFirstStepTo
                }
            );

        if (!directPlan) {

            return {
                status:
                    "unreachable",

                nodeIds:
                    []
            };

        }

        const availablePlan =
            this.findShortestPath(
                startId,
                destination.id,
                {
                    agent,

                    avoidOccupied:
                        true,

                    avoidFirstStepTo
                }
            );

        const directContainsOccupiedNode =
            directPlan.nodeIds
                .slice(1)
                .some(nodeId =>
                    this.traffic
                        ?.isNodeOccupiedByOther(
                            nodeId,
                            agent
                        )
                );

        /*
         * Um nó ocupado nunca pode permanecer
         * no path criado.
         */
        if (
            directContainsOccupiedNode
        ) {

            if (availablePlan) {

                return {
                    status:
                        "ready",

                    nodeIds:
                        availablePlan.nodeIds,

                    cost:
                        availablePlan.cost,

                    destinationId:
                        destination.id
                };

            }

            /*
             * Não cria uma rota parcial em direção
             * ao nó ocupado.
             *
             * O controller preserva a intenção e
             * tentará planejar novamente quando o
             * estado do tráfego mudar.
             */
            return {
                status:
                    "unreachable",

                nodeIds:
                    [],

                destinationId:
                    destination.id,

                blockedByOccupiedNode:
                    true
            };

        }

        const maximumDetour =
            directPlan.cost === 0

                ? 0
                : directPlan.cost *
                maxDetourFactor;

        if (
            availablePlan &&
            availablePlan.cost <=
            maximumDetour
        ) {

            return {
                status:
                    "ready",

                nodeIds:
                    availablePlan.nodeIds,

                cost:
                    availablePlan.cost,

                destinationId:
                    destination.id
            };

        }

        const unavailable =
            this.findFirstUnavailableResource(
                directPlan.nodeIds,
                agent
            );

        if (!unavailable) {

            return {
                status:
                    "ready",

                nodeIds:
                    directPlan.nodeIds,

                cost:
                    directPlan.cost,

                destinationId:
                    destination.id
            };

        }

        /*
         * O trecho ativo termina ANTES do recurso
         * indisponível.
         *
         * A implementação anterior usava
         * index + 2, incluindo o nó bloqueado.
         */
        const safeNodeIds =
            directPlan.nodeIds.slice(
                0,
                unavailable.index + 1
            );

        return {
            status:
                "waiting",

            nodeIds:
                safeNodeIds,

            fullNodeIds:
                directPlan.nodeIds,

            waitingFor:
                unavailable.resource,

            destinationId:
                destination.id,

            cost:
                directPlan.cost
        };

    }

    findClosestNode(position) {

        const nodes = [...this.graph.nodes.values()];
        if (nodes.length === 0) return null;

        const closest = nodes.reduce((closestNode, node) =>
            node.position.distanceToSquared(position) <
                closestNode.position.distanceToSquared(position)
                ? node
                : closestNode
        );
        const radius = this.graph.selectionRadius;

        return closest.position.distanceToSquared(position) <= radius * radius
            ? closest
            : null;

    }

    findShortestPath(startId, destinationId, {
        agent = null,
        avoidOccupied = true,
        avoidFirstStepTo = null
    } = {}) {

        const result = this.findAllShortestPaths(startId, {
            agent,
            avoidOccupied,
            avoidFirstStepTo
        });

        if (!result.distances.has(destinationId)) return null;

        const nodeIds = [];
        let currentId = destinationId;

        while (currentId !== null) {
            nodeIds.push(currentId);
            currentId = result.parents.get(currentId) ?? null;
        }

        return {
            nodeIds: nodeIds.reverse(),
            cost: result.distances.get(destinationId)
        };

    }

    findPreferredPath(
        startId,
        destinationId,
        agent = null,
        {
            maxDetourFactor = 3,
            avoidFirstStepTo = null
        } = {}
    ) {

        const direct =
            this.findShortestPath(
                startId,
                destinationId,
                {
                    agent,
                    avoidOccupied:
                        false,

                    avoidFirstStepTo
                }
            );

        if (!direct) {

            return null;

        }

        const available =
            this.findShortestPath(
                startId,
                destinationId,
                {
                    agent,
                    avoidOccupied:
                        true,

                    avoidFirstStepTo
                }
            );

        /*
         * Verifica se a rota direta contém
         * algum nó fisicamente ocupado.
         *
         * O primeiro nó é ignorado, pois ele
         * pode ser o nó atualmente ocupado pelo
         * próprio actor.
         */
        const directContainsOccupiedNode =
            direct.nodeIds
                .slice(1)
                .some(nodeId =>
                    this.traffic
                        ?.isNodeOccupiedByOther(
                            nodeId,
                            agent
                        )
                );

        /*
         * Se a rota direta atravessa um nó
         * ocupado, ela nunca é usada como
         * fallback.
         *
         * Se houver outra rota, ela será usada
         * mesmo que seja significativamente
         * mais longa.
         */
        if (
            directContainsOccupiedNode
        ) {

            return available ??
                null;

        }

        /*
         * Se nenhum nó está fisicamente ocupado,
         * mantém-se a política normal de desvio.
         *
         * Isso permite que uma reserva temporária
         * ou uma lane cheia ainda resulte em espera
         * quando o desvio seria desproporcional.
         */
        if (!available) {

            return direct;

        }

        const maximumDetour =
            direct.cost === 0

                ? 0
                : direct.cost *
                maxDetourFactor;

        return available.cost <=
            maximumDetour

            ? available
            : direct;

    }

    findNearestAvailablePath(startId, agent = null) {

        const result = this.findAllShortestPaths(startId, {
            agent,
            avoidOccupied: true
        });
        const candidates = [...result.distances.keys()]
            .map(id => this.graph.requireNode(id))
            .filter(node =>
                !node.blocked &&
                (!this.traffic || this.traffic.isNodeAvailable(node.id, agent))
            );

        if (candidates.length === 0) return null;

        const destination = candidates.reduce((nearest, node) =>
            result.distances.get(node.id) < result.distances.get(nearest.id)
                ? node
                : nearest
        );

        return this.findShortestPath(startId, destination.id, {
            agent,
            avoidOccupied: true
        });

    }

    findAllShortestPaths(
        startId,
        {
            agent = null,
            avoidOccupied = true,
            avoidFirstStepTo = null
        } = {}
    ) {

        this.metrics?.increment(
            "routesCalculated"
        );

        this.graph.requireNode(
            startId
        );

        const distances =
            new Map([
                [
                    startId,
                    0
                ]
            ]);

        const parents =
            new Map([
                [
                    startId,
                    null
                ]
            ]);

        const unvisited =
            new Set([
                startId
            ]);

        while (
            unvisited.size > 0
        ) {

            const currentId =
                [...unvisited]
                    .reduce(
                        (
                            closestId,
                            id
                        ) =>
                            distances.get(id) <
                                distances.get(
                                    closestId
                                )

                                ? id
                                : closestId
                    );

            unvisited.delete(
                currentId
            );

            const current =
                this.graph.requireNode(
                    currentId
                );

            for (
                const [
                    neighborId,
                    connection
                ] of current.connections
            ) {

                const neighbor =
                    this.graph.requireNode(
                        neighborId
                    );

                if (
                    currentId === startId &&
                    neighborId ===
                    avoidFirstStepTo
                ) {

                    continue;

                }

                if (
                    connection.blocked ||
                    neighbor.blocked
                ) {

                    continue;

                }

                if (
                    !this.canAgentTraverseConnection(
                        connection,
                        agent
                    )
                ) {

                    continue;

                }

                if (
                    avoidOccupied &&
                    this.traffic
                ) {

                    /*
                     * Lane cheia retira esta
                     * conexão da rota disponível.
                     */
                    if (
                        !this.traffic
                            .isConnectionAvailable(
                                currentId,
                                neighborId,
                                agent
                            )
                    ) {

                        continue;

                    }

                    /*
                     * Uma reserva de nó não
                     * remove o nó do traçado.
                     *
                     * Apenas bloqueios
                     * topológicos ou físicos
                     * excepcionais fazem isso.
                     */
                    if (
                        !this.traffic
                            .isNodeTraversableForPlanning(
                                neighbor.id,
                                agent
                            )
                    ) {

                        continue;

                    }

                }

                const cost =
                    distances.get(
                        currentId
                    ) +
                    current.position
                        .distanceTo(
                            neighbor.position
                        );

                if (
                    cost >=
                    (
                        distances.get(
                            neighborId
                        ) ??
                        Infinity
                    )
                ) {

                    continue;

                }

                distances.set(
                    neighborId,
                    cost
                );

                parents.set(
                    neighborId,
                    currentId
                );

                unvisited.add(
                    neighborId
                );

            }

        }

        return {
            distances,
            parents
        };

    }

    findFirstUnavailableResource(
        nodeIds,
        agent
    ) {

        if (!this.traffic) {

            return null;

        }

        for (
            let index = 0;
            index <
            nodeIds.length - 1;
            index++
        ) {

            const fromId =
                nodeIds[index];

            const toId =
                nodeIds[index + 1];

            if (
                !this.traffic
                    .isConnectionAvailable(
                        fromId,
                        toId,
                        agent
                    )
            ) {

                return {
                    index,

                    resource: {
                        type:
                            "connection",

                        fromId,
                        toId
                    }
                };

            }

            /*
             * Aqui usamos isNodeAvailable().
             *
             * Uma reserva não impede planejar,
             * mas impede executar a entrada
             * naquele momento.
             */
            if (
                this.traffic
                    .isNodeOccupiedByOther(
                        toId,
                        agent
                    )
            ) {

                return {
                    index,

                    resource: {
                        type:
                            "occupied-node",

                        id:
                            toId
                    }
                };

            }

            /*
             * Reservas continuam sendo recursos
             * temporariamente indisponíveis.
             *
             * Elas não removem o nó da topologia, mas
             * impedem que o ator prossiga até a entrada.
             */
            if (
                !this.traffic
                    .isNodeAvailable(
                        toId,
                        agent
                    )
            ) {

                return {
                    index,

                    resource: {
                        type:
                            "node",

                        id:
                            toId
                    }
                };

            }

        }

        return null;

    }

    canAgentTraverseConnection(connection, agent = null) {

        if (!agent) return true;

        const capabilities = agent.navigationCapabilities ?? {};
        const traversal = connection.metadata.traversal ?? "flat";

        if (traversal === "stairs" && capabilities.stairs === false) {
            return false;
        }
        if (traversal === "slope" &&
            Number.isFinite(capabilities.maxSlope) &&
            connection.metadata.slopeAngle > capabilities.maxSlope) {
            return false;
        }

        return true;

    }

}
