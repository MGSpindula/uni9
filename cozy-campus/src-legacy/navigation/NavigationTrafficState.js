// Runtime ownership for navigation resources.
//
// NavigationGraph describes what exists. This class describes who is using
// it right now. Keeping actor references here lets the same graph be loaded,
// validated and path-found without creating a single Character.
export class NavigationTrafficState {

    constructor(graph) {

        this.graph = graph;
        this.nodeStates = new Map();
        this.connectionStates = new Map();

    }

    getNodeState(id) {

        this.graph.requireNode(id);

        if (!this.nodeStates.has(id)) {

            this.nodeStates.set(id, {
                occupants: new Set(),
                reservations: new Set(),
                transitReservations: new Set(),
                // Temporary operational occupation created by a physical
                // collision near this node. External routes must avoid it
                // until the encounter has actually cleared.
                collisionBlocks: new Set(),
                // A crossing actor is passing through the junction; it is not
                // performing an action there. Compatible crossings may
                // overlap while an ordinary occupant still blocks the node.
                crossingAgents: new Set()
            });

        }

        return this.nodeStates.get(id);

    }

    getConnectionState(fromId, toId) {

        const connection = this.graph.requireConnection(fromId, toId);

        if (!this.connectionStates.has(connection)) {

            this.connectionStates.set(connection, {
                occupants: new Set(),
                reservations: new Set(),
                lanes: Array.from(
                    { length: connection.laneCount },
                    (_, index) => ({
                        index,
                        occupants: new Set(),
                        reservations: new Set(),
                        directions: new Map()
                    })
                )
            });

        }

        return this.connectionStates.get(connection);

    }

    isNodeAvailable(id, agent = null) {

        const node = this.graph.requireNode(id);
        const state = this.getNodeState(id);

        if (node.blocked) return false;
        if (this.isCollisionBlockedFor(state, agent)) return false;

        for (const occupant of state.occupants) {

            if (occupant !== agent &&
                !state.crossingAgents.has(occupant)) {
                return false;
            }

        }

        for (const reservation of state.reservations) {
            if (reservation !== agent) return false;
        }
        for (const reservation of state.transitReservations) {
            if (reservation !== agent) return false;
        }

        if (!node.exclusive) return true;

        return this.isResourceAvailable(node, state, agent);

    }

    isNodePassable(id) {

        const node = this.graph.requireNode(id);
        const state = this.getNodeState(id);

        if (node.blocked) return false;
        if (state.collisionBlocks.size > 0) return false;

        for (const occupant of state.occupants) {
            if (!state.crossingAgents.has(occupant)) return false;
        }

        if (state.reservations.size > 0) return false;

        return !node.exclusive || state.occupants.size === 0;

    }

    isNodePhysicallyAvailable(id, agent = null) {

        const node = this.graph.requireNode(id);
        const state = this.getNodeState(id);

        if (node.blocked) return false;

        if (this.isCollisionBlockedFor(state, agent)) return false;

        return ![...state.occupants].some(candidate =>
            candidate !== agent &&
            !state.crossingAgents.has(candidate)
        );

    }

    isNodeTraversableForPlanning(
        id,
        agent = null
    ) {

        const node =
            this.graph.requireNode(
                id
            );

        const state =
            this.getNodeState(
                id
            );

        /*
         * Bloqueio estrutural remove o nó
         * completamente do grafo disponível.
         */
        if (node.blocked) {

            return false;

        }

        /*
         * Uma colisão física ativa próxima ao nó
         * também impede que novas rotas o escolham.
         */
        if (
            this.isCollisionBlockedFor(
                state,
                agent
            )
        ) {

            return false;

        }

        /*
         * Qualquer ocupação física por outro ator
         * remove o nó de um NOVO planejamento.
         *
         * crossingAgents não são exceção aqui.
         * Eles podem ter sido autorizados antes,
         * mas enquanto seus corpos estiverem no nó,
         * nenhum novo path deve atravessá-lo.
         */
        for (
            const occupant of
            state.occupants
        ) {

            if (
                occupant !== agent
            ) {

                return false;

            }

        }

        /*
         * Reservas não removem o nó do traçado.
         *
         * Elas apenas impedem a admissão quando
         * o ator chegar ao endpoint.
         */
        return true;

    }

    isNodeOccupiedByOther(
        id,
        agent = null
    ) {

        const state =
            this.getNodeState(
                id
            );

        for (
            const occupant of
            state.occupants
        ) {

            if (
                occupant !== agent
            ) {

                return true;

            }

        }

        return false;

    }

    isConnectionAvailable(fromId, toId, agent = null) {

        return this.findAvailableLaneIndex(fromId, toId, agent) !== null;

    }

    isResourceAvailable(resource, state, agent = null) {

        if (resource.blocked) return false;

        const users = new Set([
            ...state.occupants,
            ...state.reservations
        ]);

        if (agent) users.delete(agent);

        return users.size < resource.capacity;

    }

    isLaneBelowCapacity(
        connection,
        lane,
        agent = null
    ) {

        /*
         * Uma reserva já representa uma vaga
         * comprometida.
         *
         * Por isso, ocupantes e reservas contam
         * igualmente para o limite da lane.
         */
        const users =
            new Set([
                ...lane.occupants,
                ...lane.reservations
            ]);

        /*
         * Um ator que já possui a lane não deve
         * contar contra si mesmo durante uma
         * revalidação.
         */
        if (agent) {

            users.delete(
                agent
            );

        }

        const capacity =
            connection.laneCapacity ??
            2;

        return users.size <
            capacity;

    }

    reserveNode(id, agent) {

        if (!this.isNodeAvailable(id, agent)) return false;

        const node = this.graph.requireNode(id);
        const state = this.getNodeState(id);

        return this.reserveResource(node, state, agent);

    }

    reserveNodeForTransit(
        id,
        agent,
        isCompatibleReservation =
            () => false
    ) {

        const node =
            this.graph.requireNode(id);

        const state =
            this.getNodeState(id);

        if (node.blocked) {

            return false;

        }

        if (
            this.isCollisionBlockedFor(
                state,
                agent
            )
        ) {

            return false;

        }

        /*
         * O próprio ator já possui admissão.
         */
        if (
            state.reservations.has(agent) ||
            state.transitReservations.has(agent) ||
            state.occupants.has(agent)
        ) {

            return true;

        }

        /*
         * Reservas comuns representam posse
         * exclusiva do nó.
         *
         * Elas não participam do sistema de
         * travessias compatíveis.
         */
        for (
            const candidate of
            state.reservations
        ) {

            if (
                candidate !== agent
            ) {

                return false;

            }

        }

        /*
         * Um ator parado ou apenas ocupando o nó
         * impede nova entrada.
         *
         * Um crossingAgent pode coexistir quando
         * seu caminho não conflita com o novo.
         */
        for (
            const candidate of
            state.occupants
        ) {

            if (
                candidate === agent
            ) {

                continue;

            }

            if (
                !state.crossingAgents.has(
                    candidate
                )
            ) {

                return false;

            }

            if (
                !isCompatibleReservation(
                    candidate
                )
            ) {

                return false;

            }

        }

        /*
         * Reservas de trânsito não consomem uma
         * capacidade numérica arbitrária.
         *
         * Elas podem coexistir quando os caminhos
         * planejados são independentes.
         */
        for (
            const candidate of
            state.transitReservations
        ) {

            if (
                candidate === agent
            ) {

                continue;

            }

            if (
                !isCompatibleReservation(
                    candidate
                )
            ) {

                return false;

            }

        }

        /*
         * Nós exclusivos continuam aceitando
         * apenas uma admissão por vez.
         */
        if (node.exclusive) {

            if (
                state.reservations.size > 0 ||
                state.transitReservations.size > 0 ||
                state.occupants.size > 0
            ) {

                return false;

            }

            state.reservations.add(
                agent
            );

            return true;

        }

        state.transitReservations.add(
            agent
        );

        return true;

    }

    reserveConnectionLane(fromId, toId, agent) {

        const laneIndex = this.findAvailableLaneIndex(fromId, toId, agent);

        if (laneIndex === null) return null;

        return this.reserveSpecificConnectionLane(
            fromId,
            toId,
            laneIndex,
            agent
        );

    }

    reserveSpecificConnectionLane(
        fromId,
        toId,
        laneIndex,
        agent
    ) {

        const connection =
            this.graph.requireConnection(
                fromId,
                toId
            );

        const state =
            this.getConnectionState(
                fromId,
                toId
            );

        const existingLane =
            state.lanes.find(lane =>
                lane.reservations.has(agent) ||
                lane.occupants.has(agent)
            );

        /*
         * O ator já possui uma lane nesta
         * conexão.
         */
        if (existingLane) {

            return existingLane.index ===
                laneIndex

                ? laneIndex
                : null;

        }

        const lane =
            state.lanes[laneIndex];

        if (
            !lane ||
            connection.blocked
        ) {

            return null;

        }

        if (
            !this.isLaneDirectionCompatible(
                lane,
                fromId,
                toId,
                agent
            )
        ) {

            return null;

        }

        /*
         * Não permite que chamadas diretas a
         * este método contornem o limite.
         */
        if (
            !this.isLaneBelowCapacity(
                connection,
                lane,
                agent
            )
        ) {

            return null;

        }

        lane.reservations.add(
            agent
        );

        lane.directions.set(
            agent,
            {
                fromId,
                toId
            }
        );

        state.reservations.add(
            agent
        );

        return laneIndex;

    }

    reservePriorityConnectionLane(
        fromId,
        toId,
        agent,
        preferredLaneIndex = null
    ) {

        const connection =
            this.graph.requireConnection(
                fromId,
                toId
            );

        const state =
            this.getConnectionState(
                fromId,
                toId
            );

        if (connection.blocked) {

            return null;

        }

        const normalLaneIndex =
            connection.fromId === fromId
                ? 0
                : 1;

        const order =
            Number.isInteger(
                preferredLaneIndex
            )

                ? [
                    preferredLaneIndex
                ]

                : [
                    normalLaneIndex,

                    ...state.lanes
                        .map(
                            lane =>
                                lane.index
                        )
                        .filter(
                            index =>
                                index !==
                                normalLaneIndex
                        )
                ];

        for (
            const laneIndex of order
        ) {

            const lane =
                state.lanes[
                laneIndex
                ];

            if (!lane) {

                continue;

            }

            /*
             * Não permite três atores, mesmo
             * para prioridade absoluta.
             */
            if (
                !this.isLaneBelowCapacity(
                    connection,
                    lane,
                    agent
                )
            ) {

                continue;

            }

            /*
             * Ocupantes físicos não podem ser
             * deslocados.
             *
             * Todos precisam estar andando na
             * mesma direção.
             */
            const occupantsCompatible =
                [...lane.occupants]
                    .every(candidate => {

                        if (
                            candidate ===
                            agent
                        ) {

                            return true;

                        }

                        const direction =
                            lane.directions.get(
                                candidate
                            );

                        return (
                            direction
                                ?.fromId ===
                            fromId &&
                            direction
                                ?.toId ===
                            toId
                        );

                    });

            if (!occupantsCompatible) {

                continue;

            }

            /*
             * Apenas reservas incompatíveis
             * podem ser deslocadas pela
             * prioridade.
             */
            const displaced =
                [...lane.reservations]
                    .filter(candidate => {

                        if (
                            candidate ===
                            agent
                        ) {

                            return false;

                        }

                        const direction =
                            lane.directions.get(
                                candidate
                            );

                        return (
                            direction
                                ?.fromId !==
                            fromId ||
                            direction
                                ?.toId !==
                            toId
                        );

                    });

            for (
                const candidate of
                displaced
            ) {

                lane.reservations.delete(
                    candidate
                );

                lane.directions.delete(
                    candidate
                );

                state.reservations.delete(
                    candidate
                );

            }

            /*
             * Revalida a capacidade depois de
             * remover reservas incompatíveis.
             */
            if (
                !this.isLaneBelowCapacity(
                    connection,
                    lane,
                    agent
                )
            ) {

                continue;

            }

            lane.reservations.add(
                agent
            );

            lane.directions.set(
                agent,
                {
                    fromId,
                    toId
                }
            );

            state.reservations.add(
                agent
            );

            return {
                laneIndex,
                displaced
            };

        }

        return null;

    }

    reserveNodeEvacuationLane(
        fromId,
        toId,
        agent
    ) {

        const connection =
            this.graph.requireConnection(
                fromId,
                toId
            );

        const state =
            this.getConnectionState(
                fromId,
                toId
            );

        if (connection.blocked) {

            return null;

        }

        const normalLaneIndex =
            connection.fromId === fromId
                ? 0
                : 1;

        const oppositeLaneIndex =
            normalLaneIndex === 0
                ? 1
                : 0;

        /*
         * Em emergência, tenta primeiro a lane
         * contrária para liberar rapidamente o
         * nó.
         *
         * Mesmo assim, capacidade e direção dos
         * ocupantes continuam obrigatórias.
         */
        for (
            const laneIndex of [
                oppositeLaneIndex,
                normalLaneIndex
            ]
        ) {

            const lane =
                state.lanes[
                laneIndex
                ];

            if (!lane) {

                continue;

            }

            if (
                !this.isLaneBelowCapacity(
                    connection,
                    lane,
                    agent
                )
            ) {

                continue;

            }

            const occupantsCompatible =
                [...lane.occupants]
                    .every(candidate => {

                        if (
                            candidate ===
                            agent
                        ) {

                            return true;

                        }

                        const direction =
                            lane.directions.get(
                                candidate
                            );

                        return (
                            direction
                                ?.fromId ===
                            fromId &&
                            direction
                                ?.toId ===
                            toId
                        );

                    });

            if (!occupantsCompatible) {

                continue;

            }

            const displaced =
                [...lane.reservations]
                    .filter(candidate => {

                        if (
                            candidate ===
                            agent
                        ) {

                            return false;

                        }

                        const direction =
                            lane.directions.get(
                                candidate
                            );

                        return (
                            direction
                                ?.fromId !==
                            fromId ||
                            direction
                                ?.toId !==
                            toId
                        );

                    });

            for (
                const candidate of
                displaced
            ) {

                lane.reservations.delete(
                    candidate
                );

                lane.directions.delete(
                    candidate
                );

                state.reservations.delete(
                    candidate
                );

            }

            if (
                !this.isLaneBelowCapacity(
                    connection,
                    lane,
                    agent
                )
            ) {

                continue;

            }

            lane.reservations.add(
                agent
            );

            lane.directions.set(
                agent,
                {
                    fromId,
                    toId
                }
            );

            state.reservations.add(
                agent
            );

            return {
                laneIndex,
                displaced,

                usedOppositeLane:
                    laneIndex ===
                    oppositeLaneIndex
            };

        }

        return null;

    }

    findAvailableLaneIndex(
        fromId,
        toId,
        agent = null
    ) {

        const connection =
            this.graph.requireConnection(
                fromId,
                toId
            );

        const state =
            this.getConnectionState(
                fromId,
                toId
            );

        if (connection.blocked) {

            return null;

        }

        /*
         * A conexão possui duas lanes
         * direcionais fixas.
         *
         * lane 0:
         * connection.fromId → connection.toId
         *
         * lane 1:
         * connection.toId → connection.fromId
         */
        const preferredIndex =
            connection.fromId === fromId
                ? 0
                : 1;

        const lane =
            state.lanes[
            preferredIndex
            ];

        if (!lane) {

            return null;

        }

        if (
            !this.isLaneDirectionCompatible(
                lane,
                fromId,
                toId,
                agent
            )
        ) {

            return null;

        }

        if (
            !this.isLaneBelowCapacity(
                connection,
                lane,
                agent
            )
        ) {

            return null;

        }

        return preferredIndex;

    }

    isLaneDirectionCompatible(
        lane,
        fromId,
        toId,
        agent = null
    ) {

        const users =
            new Set([
                ...lane.occupants,
                ...lane.reservations
            ]);

        if (agent) {

            users.delete(
                agent
            );

        }

        for (
            const candidate of users
        ) {

            const direction =
                lane.directions.get(
                    candidate
                );

            /*
             * Se a direção estiver ausente, a
             * lane não pode ser considerada
             * segura.
             */
            if (!direction) {

                return false;

            }

            if (
                direction.fromId !==
                fromId ||
                direction.toId !==
                toId
            ) {

                return false;

            }

        }

        return true;

    }

    getConnectionLaneIndex(fromId, toId, agent) {

        const state = this.getConnectionState(fromId, toId);
        const lane = state.lanes.find(candidate =>
            candidate.reservations.has(agent) ||
            candidate.occupants.has(agent)
        );

        return lane?.index ?? null;

    }

    canCrossNode(
        id,
        agent,
        isCompatibleCrossing =
            () => false
    ) {

        const node =
            this.graph.requireNode(
                id
            );

        const state =
            this.getNodeState(
                id
            );

        if (node.blocked) {

            return false;

        }

        if (
            this.isCollisionBlockedFor(
                state,
                agent
            )
        ) {

            return false;

        }

        /*
         * Reservas comuns são exclusivas.
         *
         * Uma reserva comum de outro ator impede
         * a travessia. A própria reserva do agent
         * não é um bloqueio.
         */
        for (
            const candidate of
            state.reservations
        ) {

            if (
                candidate !== agent
            ) {

                return false;

            }

        }

        /*
         * Reservas de trânsito podem coexistir
         * quando as trajetórias são compatíveis.
         */
        for (
            const candidate of
            state.transitReservations
        ) {

            if (
                candidate === agent
            ) {

                continue;

            }

            if (
                !isCompatibleCrossing(
                    candidate
                )
            ) {

                return false;

            }

        }

        /*
         * Um ocupante comum bloqueia o nó.
         *
         * Um ator que já está atravessando pode
         * coexistir com o novo ator quando seus
         * caminhos são compatíveis.
         */
        for (
            const candidate of
            state.occupants
        ) {

            if (
                candidate === agent
            ) {

                continue;

            }

            if (
                !state.crossingAgents.has(
                    candidate
                )
            ) {

                return false;

            }

            if (
                !isCompatibleCrossing(
                    candidate
                )
            ) {

                return false;

            }

        }

        return true;

    }

    occupyNode(id, agent, { crossing = false } = {}) {

        const node = this.graph.requireNode(id);
        const state = this.getNodeState(id);

        // canCrossNode() already performed the junction handshake. A transit
        // node is semantic traffic space, not an action capacity: compatible
        // crossings must not be rejected a second time by generic capacity.
        const occupied = crossing && !node.exclusive
            ? !node.blocked
            : this.occupyResource(node, state, agent);

        if (occupied) {
            state.reservations.delete(agent);
            state.occupants.add(agent);
            state.transitReservations.delete(agent);
            if (crossing) state.crossingAgents.add(agent);
            else state.crossingAgents.delete(agent);
        }

        return occupied;

    }

    occupyConnectionLane(fromId, toId, agent, laneIndex) {

        const state = this.getConnectionState(fromId, toId);
        const lane = state.lanes[laneIndex];

        if (!lane) return false;

        lane.reservations.delete(agent);
        lane.occupants.add(agent);
        state.reservations.delete(agent);
        state.occupants.add(agent);
        return true;

    }

    ensureConnectionOccupancy(
        fromId,
        toId,
        agent,
        preferredLaneIndex = null
    ) {

        const connection = this.graph.requireConnection(fromId, toId);
        const state = this.getConnectionState(fromId, toId);
        const occupiedLane = state.lanes.find(lane =>
            lane.occupants.has(agent)
        );

        if (occupiedLane) {
            occupiedLane.directions.set(agent, { fromId, toId });
            state.occupants.add(agent);
            return { laneIndex: occupiedLane.index, repaired: false };
        }

        const reservedLane = state.lanes.find(lane =>
            lane.reservations.has(agent)
        );
        const normalLaneIndex = connection.fromId === fromId
            ? 0
            : Math.min(1, connection.laneCount - 1);
        const requestedLaneIndex = Number.isInteger(preferredLaneIndex)
            ? preferredLaneIndex
            : reservedLane?.index ?? normalLaneIndex;
        const laneIndex = requestedLaneIndex;

        if (!state.lanes[laneIndex]) return null;

        for (const lane of state.lanes) {
            lane.reservations.delete(agent);
            if (!lane.occupants.has(agent)) lane.directions.delete(agent);
        }

        const lane = state.lanes[laneIndex];

        // This method repairs observed physical ownership; it does not grant
        // new traffic permission. If a corrupted/recovered traversal already
        // placed two bodies on the same authored lane, record both bodies on
        // that lane instead of pretending the second one moved laterally.
        // CollisionFailsafe can then identify the rear-end relation and make
        // the follower brake until the leader clears it.
        lane.occupants.add(agent);
        lane.directions.set(agent, { fromId, toId });
        state.reservations.delete(agent);
        state.occupants.add(agent);

        return { laneIndex, repaired: true };

    }

    occupyResource(resource, state, agent) {

        if (!this.isResourceAvailable(resource, state, agent)) return false;

        state.reservations.delete(agent);
        state.occupants.add(agent);
        return true;

    }

    reserveResource(resource, state, agent) {

        if (!this.isResourceAvailable(resource, state, agent)) return false;

        state.reservations.add(agent);
        return true;

    }

    yieldTransitReservationsToArrival(id, agent) {

        const state = this.getNodeState(id);
        const displaced = [...state.transitReservations]
            .filter(candidate => candidate !== agent);

        for (const candidate of displaced) {
            state.transitReservations.delete(candidate);
        }

        return displaced;

    }

    yieldNodeReservationsToPriority(id, agent) {

        const state = this.getNodeState(id);
        const displaced = new Set();

        for (const collection of [
            state.reservations,
            state.transitReservations
        ]) {
            for (const candidate of [...collection]) {
                if (candidate === agent ||
                    candidate.navigationPassagePolicy === "absolute") continue;
                collection.delete(candidate);
                displaced.add(candidate);
            }
        }

        return [...displaced];

    }

    releaseNode(id, agent) {

        const state = this.getNodeState(id);

        state.crossingAgents.delete(agent);
        state.transitReservations.delete(agent);
        this.releaseResource(state, agent);

    }

    addCollisionBlock(id, encounter) {

        this.getNodeState(id).collisionBlocks.add(encounter);

    }

    releaseCollisionBlock(id, encounter) {

        if (!this.graph.hasNode(id)) return;
        this.getNodeState(id).collisionBlocks.delete(encounter);

    }

    isCollisionBlockedFor(state, agent = null) {

        if (state.collisionBlocks.size === 0) return false;
        if (!agent) return true;

        return [...state.collisionBlocks].some(encounter =>
            encounter.winner !== agent && encounter.yielder !== agent
        );

    }

    releaseConnection(fromId, toId, agent) {

        const state = this.getConnectionState(fromId, toId);

        for (const lane of state.lanes) {
            lane.occupants.delete(agent);
            lane.reservations.delete(agent);
            lane.directions.delete(agent);
        }

        this.releaseResource(state, agent);

    }

    releaseConnectionReservation(
        fromId,
        toId,
        agent
    ) {

        const state =
            this.getConnectionState(
                fromId,
                toId
            );

        for (
            const lane of
            state.lanes
        ) {

            lane.reservations.delete(
                agent
            );

            /*
             * Não remove a direção se o ator já
             * estiver fisicamente ocupando a
             * lane.
             */
            if (
                !lane.occupants.has(
                    agent
                )
            ) {

                lane.directions.delete(
                    agent
                );

            }

        }

        state.reservations.delete(
            agent
        );

    }

    releaseResource(state, agent) {

        state.occupants.delete(agent);
        state.reservations.delete(agent);

    }

    releaseReservations(agent) {

        for (const state of this.nodeStates.values()) {
            state.reservations.delete(agent);
            state.transitReservations.delete(agent);
        }

        for (const state of this.connectionStates.values()) {
            state.reservations.delete(agent);

            for (const lane of state.lanes) {
                lane.reservations.delete(agent);

                // A topology change may invalidate future reservations while
                // the actor is still physically traversing this lane. Its
                // direction belongs to that occupancy and must survive until
                // releaseConnection() finalizes the segment.
                if (!lane.occupants.has(agent)) {
                    lane.directions.delete(agent);
                }
            }
        }

    }

    releaseAgent(agent) {

        for (const state of this.nodeStates.values()) {
            for (const encounter of [...state.collisionBlocks]) {
                if (encounter.winner === agent || encounter.yielder === agent) {
                    state.collisionBlocks.delete(encounter);
                }
            }
            state.crossingAgents.delete(agent);
            state.transitReservations.delete(agent);
            this.releaseResource(state, agent);
        }

        for (const state of this.connectionStates.values()) {
            for (const lane of state.lanes) {
                lane.occupants.delete(agent);
                lane.reservations.delete(agent);
                lane.directions.delete(agent);
            }

            this.releaseResource(state, agent);
        }

    }

}
