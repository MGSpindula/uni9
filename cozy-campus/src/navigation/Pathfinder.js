// Pure route search over NavigationGraph topology.
// Traffic is an optional read-only constraint: omit it to validate structural
// reachability without actors, reservations or a running world.
export class Pathfinder {

    constructor(
        graph,
        traffic = null,
        metrics = null
    ) {

        if (!graph) {

            throw new TypeError(
                "Pathfinder requires a NavigationGraph."
            );

        }

        this.graph =
            graph;

        this.traffic =
            traffic;

        this.metrics =
            metrics;

        /*
         * NavigationTrafficSystem é atribuído depois de sua construção.
         *
         * Ele determina se o movimento concreto pretendido por uma rota
         * conflita com movimentos fisicamente ativos num junction.
         */
        this.movementAdvisor =
            null;

    }

    setMovementAdvisor(
        advisor
    ) {

        this.movementAdvisor =
            advisor;

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

        /*
         * directPlan é propositalmente estrutural.
         *
         * Ele representa o caminho geometricamente mais curto antes de
         * considerar lanes cheias, ocupação física e movimentos ativos.
         */
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

        /*
         * availablePlan considera:
         *
         * - lanes sem capacidade;
         * - nós com ocupação física comum;
         * - collisionBlocks;
         * - movimentos de junction incompatíveis.
         */
        const availablePlan =
            this.findMovementAwarePath(
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
            this.pathContainsOccupiedNode(
                directPlan.nodeIds,
                agent
            );

        const movementConflictNodeIds =
            this.getMovementConflictNodeIds(
                directPlan.nodeIds,
                agent
            );

        const directContainsMovementConflict =
            movementConflictNodeIds.size > 0;

        /*
         * Ocupação física comum e movimentos ativos incompatíveis são
         * restrições fortes.
         *
         * Nesses casos, a rota direta nunca retorna como fallback somente
         * porque o desvio disponível é mais longo.
         */
        if (
            directContainsOccupiedNode ||
            directContainsMovementConflict
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

            return {
                status:
                    "unreachable",

                nodeIds:
                    [],

                destinationId:
                    destination.id,

                blockedByOccupiedNode:
                    directContainsOccupiedNode,

                blockedByMovement:
                    directContainsMovementConflict,

                blockedNodeIds:
                    [
                        ...movementConflictNodeIds
                    ]
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
         * O trecho ativo termina antes do recurso indisponível.
         *
         * Para:
         *
         * A -> B -> C
         *
         * com B indisponível, o resultado é [A], nunca [A, B].
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

    findClosestNode(
        position
    ) {

        const nodes =
            [
                ...this.graph.nodes.values()
            ];

        if (
            nodes.length === 0
        ) {

            return null;

        }

        const closest =
            nodes.reduce(
                (
                    closestNode,
                    node
                ) =>
                    node.position
                        .distanceToSquared(
                            position
                        ) <
                        closestNode.position
                            .distanceToSquared(
                                position
                            )

                        ? node
                        : closestNode
            );

        const radius =
            this.graph.selectionRadius;

        return closest.position
            .distanceToSquared(
                position
            ) <=
            radius * radius

            ? closest
            : null;

    }

    findShortestPath(
        startId,
        destinationId,
        {
            agent = null,
            avoidOccupied = true,
            avoidFirstStepTo = null,
            avoidNodeIds = null
        } = {}
    ) {

        const result =
            this.findAllShortestPaths(
                startId,
                {
                    agent,
                    avoidOccupied,
                    avoidFirstStepTo,
                    avoidNodeIds
                }
            );

        if (
            !result.distances.has(
                destinationId
            )
        ) {

            return null;

        }

        const nodeIds =
            [];

        let currentId =
            destinationId;

        while (
            currentId !== null
        ) {

            nodeIds.push(
                currentId
            );

            currentId =
                result.parents.get(
                    currentId
                ) ??
                null;

        }

        return {
            nodeIds:
                nodeIds.reverse(),

            cost:
                result.distances.get(
                    destinationId
                )
        };

    }

    findMovementAwarePath(
        startId,
        destinationId,
        {
            agent = null,
            avoidOccupied = true,
            avoidFirstStepTo = null,

            avoidNodeIds:
            initialAvoidNodeIds =
            null
        } = {}
    ) {

        const avoidNodeIds =
            new Set(
                initialAvoidNodeIds ??
                []
            );

        /*
         * O algoritmo:
         *
         * 1. encontra um caminho topológico;
         * 2. constrói os movimentos pretendidos nos junctions;
         * 3. identifica movimentos ativos incompatíveis;
         * 4. exclui os junctions conflitantes;
         * 5. procura novamente.
         *
         * A cada repetição ao menos um novo nó precisa ser excluído.
         * Portanto, graph.nodes.size é um limite seguro.
         */
        const maximumAttempts =
            Math.max(
                1,
                this.graph.nodes.size
            );

        for (
            let attempt = 0;
            attempt < maximumAttempts;
            attempt++
        ) {

            const path =
                this.findShortestPath(
                    startId,
                    destinationId,
                    {
                        agent,
                        avoidOccupied,
                        avoidFirstStepTo,
                        avoidNodeIds
                    }
                );

            if (
                !path ||
                !this.movementAdvisor ||
                !agent
            ) {

                return path;

            }

            const conflicts =
                this.getMovementConflictNodeIds(
                    path.nodeIds,
                    agent
                );

            if (
                conflicts.size === 0
            ) {

                return path;

            }

            let changed =
                false;

            for (
                const nodeId of
                conflicts
            ) {

                /*
                 * O ator pode já ocupar o nó inicial.
                 *
                 * O ponto inicial não pode ser retirado de sua própria
                 * pesquisa de rota.
                 */
                if (
                    nodeId === startId
                ) {

                    continue;

                }

                if (
                    !avoidNodeIds.has(
                        nodeId
                    )
                ) {

                    avoidNodeIds.add(
                        nodeId
                    );

                    changed =
                        true;

                }

            }

            /*
             * Evita loop caso o advisor retorne apenas o próprio startId ou
             * repita exatamente os mesmos conflitos.
             */
            if (!changed) {

                return null;

            }

        }

        return null;

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
            this.findMovementAwarePath(
                startId,
                destinationId,
                {
                    agent,

                    avoidOccupied:
                        true,

                    avoidFirstStepTo
                }
            );

        const directContainsOccupiedNode =
            this.pathContainsOccupiedNode(
                direct.nodeIds,
                agent
            );

        const directContainsMovementConflict =
            this.getMovementConflictNodeIds(
                direct.nodeIds,
                agent
            ).size > 0;

        /*
         * Um corpo comum dentro do nó e um movement ativo incompatível são
         * restrições físicas.
         *
         * A rota direta não pode ser restaurada por maxDetourFactor.
         */
        if (
            directContainsOccupiedNode ||
            directContainsMovementConflict
        ) {

            return available ??
                null;

        }

        /*
         * Reserva de nó ou lane temporariamente cheia são restrições suaves.
         *
         * Se não existir um desvio razoável, preservamos a rota direta para
         * que a camada de execução aguarde no endpoint.
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

    findNearestAvailablePath(
        startId,
        agent = null
    ) {

        /*
         * O primeiro levantamento serve para ordenar os destinos potenciais
         * pela distância topológica.
         */
        const result =
            this.findAllShortestPaths(
                startId,
                {
                    agent,

                    avoidOccupied:
                        true
                }
            );

        const candidates =
            [
                ...result.distances.keys()
            ]
                .map(id =>
                    this.graph.requireNode(
                        id
                    )
                )
                .filter(node =>
                    !node.blocked &&
                    (
                        !this.traffic ||
                        this.traffic
                            .isNodeAvailable(
                                node.id,
                                agent
                            )
                    )
                )
                .sort(
                    (
                        first,
                        second
                    ) =>
                        result.distances.get(
                            first.id
                        ) -
                        result.distances.get(
                            second.id
                        )
                );

        /*
         * Recovery também precisa respeitar movements incompatíveis.
         *
         * Sem isso, findNearestAvailablePath poderia reconstruir uma rota
         * através do mesmo junction que produziu a colisão.
         */
        for (
            const destination of
            candidates
        ) {

            const path =
                this.findMovementAwarePath(
                    startId,
                    destination.id,
                    {
                        agent,

                        avoidOccupied:
                            true
                    }
                );

            if (path) {

                return path;

            }

        }

        return null;

    }

    findAllShortestPaths(
        startId,
        {
            agent = null,
            avoidOccupied = true,
            avoidFirstStepTo = null,
            avoidNodeIds = null
        } = {}
    ) {

        this.metrics?.increment(
            "routesCalculated"
        );

        this.graph.requireNode(
            startId
        );

        const excludedNodeIds =
            avoidNodeIds instanceof Set

                ? avoidNodeIds
                : new Set(
                    avoidNodeIds ??
                    []
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
                [
                    ...unvisited
                ].reduce(
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
                    excludedNodeIds.has(
                        neighborId
                    ) &&
                    neighborId !== startId
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
                     * Uma lane cheia remove a conexão da rota disponível.
                     *
                     * Reservations de lane já contam para laneCapacity dentro
                     * de NavigationTrafficState.
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
                     * Reservas de nó continuam traçáveis.
                     *
                     * Neste ponto são eliminados apenas:
                     *
                     * - bloqueios topológicos;
                     * - collisionBlocks;
                     * - ocupantes sem movementId;
                     * - outras indisponibilidades físicas excepcionais.
                     *
                     * Crossings com movementId são analisados somente depois
                     * que a rota inteira é conhecida.
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

    pathContainsOccupiedNode(
        nodeIds,
        agent
    ) {

        if (!this.traffic) {

            return false;

        }

        /*
         * O primeiro nó pode pertencer ao próprio agente.
         *
         * Occupants que possuem activeMovement não devem aparecer como uma
         * ocupação comum. Eles são analisados pelo movementAdvisor.
         */
        return nodeIds
            .slice(1)
            .some(nodeId =>
                this.traffic
                    .isNodeOccupiedByOther(
                        nodeId,
                        agent
                    )
            );

    }

    getMovementConflictNodeIds(
        nodeIds,
        agent
    ) {

        if (
            !this.movementAdvisor ||
            !agent ||
            nodeIds.length < 3
        ) {

            return new Set();

        }

        const conflicts =
            this.movementAdvisor
                .getPlanningConflictNodeIds(
                    nodeIds,
                    agent
                );

        /*
         * Exige um Set como contrato externo, mas aceita iteráveis para tornar
         * o Pathfinder mais resistente durante a migração.
         */
        return conflicts instanceof Set

            ? conflicts
            : new Set(
                conflicts ??
                []
            );

    }

    findFirstUnavailableResource(
        nodeIds,
        agent
    ) {

        if (!this.traffic) {

            return null;

        }

        const movementConflictNodeIds =
            this.getMovementConflictNodeIds(
                nodeIds,
                agent
            );

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
             * Para a rota:
             *
             * A -> B -> C
             *
             * um conflito de movement em B pertence ao índice da transição
             * A -> B. Assim, o caminho seguro termina em A.
             */
            if (
                movementConflictNodeIds.has(
                    toId
                )
            ) {

                return {
                    index,

                    resource: {
                        type:
                            "node-movement",

                        id:
                            toId
                    }
                };

            }

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
             * Reservas continuam sendo restrições temporárias de execução.
             *
             * Elas não retiram o nó da pesquisa topológica, mas fazem o ator
             * aguardar antes de sua entrada.
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

    canAgentTraverseConnection(
        connection,
        agent = null
    ) {

        if (!agent) {

            return true;

        }

        const capabilities =
            agent.navigationCapabilities ??
            {};

        const traversal =
            connection.metadata
                .traversal ??
            "flat";

        if (
            traversal === "stairs" &&
            capabilities.stairs === false
        ) {

            return false;

        }

        if (
            traversal === "slope" &&
            Number.isFinite(
                capabilities.maxSlope
            ) &&
            connection.metadata.slopeAngle >
            capabilities.maxSlope
        ) {

            return false;

        }

        return true;

    }

}