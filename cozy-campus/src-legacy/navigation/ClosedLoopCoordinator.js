import * as THREE from "three";
import { EntityState } from "../core/EntityState";

// Circuitos menores parecem um ator andando nervosamente em torno de um canto.
const MIN_CLOSED_LOOP_NODES = 4;

// Mantém toda a semântica de uma caminhada fechada em um único lugar. O
// sistema principal continua sendo a fachada, enquanto este coordenador cuida
// da entrada segura, das voltas e da saída contínua do circuito.
export class ClosedLoopCoordinator {

    constructor(navigation) {

        this.navigation = navigation;

    }

    start(actor, nodeIds, {
        laps = 1,
        id = "closed-loop",
        onLap = null,
        onComplete = null,
        onCancelled = null
    } = {}) {

        const nav = this.navigation;
        const context = nav.requireContext(actor);
        const traversal = actor.navigation.getTraversalState();
        const cycle = [...nodeIds];

        if (cycle.length > 1 && cycle[0] === cycle.at(-1)) cycle.pop();

        const uniqueNodeIds = new Set(cycle);
        const lapCount = THREE.MathUtils.clamp(Math.floor(laps), 1, 2);

        if (cycle.length < MIN_CLOSED_LOOP_NODES ||
            uniqueNodeIds.size !== cycle.length) return false;

        for (let index = 0; index < cycle.length; index++) {

            const fromId = cycle[index];
            const toId = cycle[(index + 1) % cycle.length];

            if (!nav.graph.hasNode(fromId) ||
                nav.graph.isNodeBlocked(fromId) ||
                !nav.graph.areConnected(fromId, toId) ||
                nav.graph.isConnectionBlocked(fromId, toId)) return false;

        }

        const entry = this.findEntry(context, cycle);

        if (!entry) return false;

        const startIndex = cycle.indexOf(entry.nodeId);
        let orderedCycle = [
            ...cycle.slice(startIndex),
            ...cycle.slice(0, startIndex)
        ];

        if (entry.arrivalFromId && orderedCycle[1] === entry.arrivalFromId) {

            orderedCycle = [
                orderedCycle[0],
                ...orderedCycle.slice(1).reverse()
            ];

        }

        const startsImmediately = !context.interaction.active &&
            !traversal.currentConnection &&
            traversal.currentNodeId === entry.nodeId;

        context.intent.closedLoop = {
            id,
            nodeIds: orderedCycle,
            entryNodeId: entry.nodeId,
            phase: startsImmediately ? "looping" : "entering",
            lapsTotal: lapCount,
            lapsRemaining: lapCount,
            lapsCompleted: 0,
            onLap,
            onComplete,
            onCancelled
        };
        context.route.departureContinuity = null;

        console.log(
            `[ClosedLoop] ${actor.name} chooses "${id}" for ` +
            `${lapCount} lap${lapCount === 1 ? "" : "s"}.`
        );

        if (startsImmediately) {

            nav.traffic.cancel(actor);
            nav.interactionTraffic.releaseReservations(actor);
            nav.trafficState.releaseReservations(actor);
            nav.routeGeometry.clearActiveLaneCurve(actor);
            actor.locomotion.resetCurve();
            context.intent.position = null;
            context.intent.interaction = null;
            context.intent.destinationId = null;
            context.intent.deferredCommand = null;
            return this.startPriming(context);

        }

        console.log(
            `[ClosedLoop] ${actor.name} heads to safe entry ` +
            `"${entry.nodeId}" before starting the circuit.`
        );
        const accepted = nav.moveToClosestNode(
            actor,
            nav.graph.requireNode(entry.nodeId).position,
            { replaceIntent: false, preparedCandidate: entry.candidate }
        );

        if (accepted) return true;

        this.cancel(context, "entry-unreachable");
        return false;

    }

    startPriming(context) {

        const nav = this.navigation;
        const loop = context.intent.closedLoop;

        if (!loop || loop.nodeIds.length < MIN_CLOSED_LOOP_NODES) return false;

        const fromId = loop.nodeIds[0];
        const toId = loop.nodeIds[1];
        const actor = context.actor;
        const connection = nav.graph.requireConnection(fromId, toId);
        const laneIndex = connection.fromId === fromId ? 0 : 1;
        const laneEnd = nav.routeGeometry.getConnectionLaneNodePosition(
            toId,
            fromId,
            toId,
            laneIndex
        );

        loop.phase = "priming";
        loop.primingTargetId = toId;
        actor.followWaypoints([{
            id: toId,
            position: laneEnd,
            preferredLaneIndex: laneIndex,
            closedLoopPrimingEnd: true
        }]);
        nav.refresh();
        return true;

    }

    findEntry(context, nodeIds) {

        const nav = this.navigation;
        const traversal = context.actor.navigation.getTraversalState();
        const allowedNodeIds = nodeIds.filter(nodeId =>
            !this.isNodeAttachedToActionPoint(nodeId)
        );

        if (allowedNodeIds.length === 0) return null;

        if (!context.interaction.active &&
            !traversal.currentConnection &&
            allowedNodeIds.includes(traversal.currentNodeId)) {

            return {
                nodeId: traversal.currentNodeId,
                candidate: null,
                cost: 0,
                arrivalFromId: context.traversal.arrivalFromNodeId
            };

        }

        return allowedNodeIds
            .map(nodeId => {

                const candidate = nav.findBestPlan(
                    context,
                    nav.graph.requireNode(nodeId).position,
                    6
                );

                if (!candidate ||
                    candidate.plan.destinationId !== nodeId) return null;

                return {
                    nodeId,
                    candidate,
                    cost: candidate.accessCost + candidate.plan.cost,
                    arrivalFromId: candidate.plan.nodeIds.at(-2) ?? null
                };

            })
            .filter(Boolean)
            .sort((first, second) => first.cost - second.cost)[0] ?? null;

    }

    isNodeAttachedToActionPoint(nodeId) {

        const connector = this.navigation.connector;

        for (const point of connector.points.values()) {

            if (point.metadata.role !== "action") continue;

            const access = connector.connect(point.via ?? point, {
                silent: true
            });

            if (access?.nodeIds?.length === 1 &&
                access.nodeIds[0] === nodeId) return true;

        }

        return false;

    }

    startLap(context) {

        const loop = context.intent.closedLoop;

        if (!loop) return false;

        loop.phase = "looping";

        const waypoints = this.createRouteWaypoints(loop.nodeIds);

        if (waypoints.length === 0) {

            this.cancel(context, "invalidated");
            return false;

        }

        context.actor.followWaypoints(waypoints);
        this.navigation.refresh();
        return true;

    }

    createRouteWaypoints(nodeIds) {

        const nav = this.navigation;

        return nodeIds.map((fromId, index) => {

            const toId = nodeIds[(index + 1) % nodeIds.length];
            const connection = nav.graph.requireConnection(fromId, toId);

            return {
                id: toId,
                position: nav.graph.requireNode(toId).position.clone(),
                preferredLaneIndex: connection.fromId === fromId ? 0 : 1,
                closedLoopLapEnd: index === nodeIds.length - 1
            };

        });

    }

    cancel(context, reason = "cancelled") {

        const loop = context?.intent.closedLoop;

        if (!loop) return false;

        context.intent.closedLoop = null;
        loop.onCancelled?.({
            actor: context.actor,
            id: loop.id,
            lapsCompleted: loop.lapsCompleted,
            reason
        });
        return true;

    }

    completeLap(context, waypoint) {

        const nav = this.navigation;
        const { actor } = context;
        const loop = context.intent.closedLoop;
        const nodeId = waypoint.id;

        if (!loop) return false;

        loop.lapsCompleted++;
        loop.lapsRemaining--;
        loop.onLap?.({
            actor,
            id: loop.id,
            completed: loop.lapsCompleted,
            total: loop.lapsTotal
        });

        if (loop.lapsRemaining > 0) {

            console.log(
                `[ClosedLoop] ${actor.name} completed ` +
                `${loop.lapsCompleted}/${loop.lapsTotal} on "${loop.id}".`
            );
            return this.startLap(context);

        }

        context.intent.closedLoop = null;
        nav.routeGeometry.clearActiveLaneCurve(actor);

        const previousNodeId = context.traversal.arrivalFromNodeId;
        let direction = waypoint.routeCurve
            ?.getTangent(1, new THREE.Vector3())
            .setY(0) ?? new THREE.Vector3();

        if (direction.lengthSq() <= 0.0001 && previousNodeId) {

            direction = nav.graph.requireNode(nodeId).position.clone()
                .sub(nav.graph.requireNode(previousNodeId).position)
                .setY(0);

        }

        context.route.departureContinuity = previousNodeId &&
            direction.lengthSq() > 0.0001
            ? {
                nodeId,
                previousNodeId,
                direction: direction.normalize()
            }
            : null;

        nav.trafficState.releaseNode(nodeId, actor);
        actor.navigation.setCurrentNode(nodeId);
        actor.setState(EntityState.IDLE);

        console.log(
            `[ClosedLoop] ${actor.name} leaves "${loop.id}" after ` +
            `${loop.lapsCompleted} lap${loop.lapsCompleted === 1 ? "" : "s"}.`
        );
        loop.onComplete?.({ actor, id: loop.id, lapsCompleted: loop.lapsCompleted });
        return true;

    }

}
