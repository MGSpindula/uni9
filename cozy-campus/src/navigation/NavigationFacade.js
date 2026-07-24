import { NavigationStatus } from "./NavigationAgentState.js"

export class NavigationFacade {
    constructor({ navMeshWorld, crowdNavigation }) {
        if (!navMeshWorld || !crowdNavigation) {
            throw new TypeError(
                "NavigationFacade requires NavMeshWorld and CrowdNavigationSystem.",
            )
        }

        this.navMeshWorld = navMeshWorld
        this.crowdNavigation = crowdNavigation
    }

    register(actor, options = {}) {
        return this.crowdNavigation.register(actor, options)
    }

    unregister(actor) {
        return this.crowdNavigation.unregister(actor)
    }

    moveTo(actor, destination, options = {}) {
        return this.crowdNavigation.moveTo(actor, destination, options)
    }

    cancel(actor) {
        return this.crowdNavigation.stop(actor)
    }

    stop(actor) {
        return this.cancel(actor)
    }

    pause(actor) {
        return this.crowdNavigation.pause(actor)
    }

    resume(actor) {
        return this.crowdNavigation.resume(actor)
    }

    isMoving(actor) {
        return this.getStatus(actor) === NavigationStatus.MOVING
    }

    getStatus(actor) {
        return this.crowdNavigation.getState(actor)?.status ?? null
    }

    getState(actor) {
        return this.crowdNavigation.getState(actor)
    }

    projectPoint(position, options = {}) {
        return this.navMeshWorld.projectPoint(position, options)
    }

    findPath(start, destination, options = {}) {
        return this.navMeshWorld.findPath(start, destination, options)
    }

    findRandomPoint(center = null, radius = null, options = {}) {
        return this.navMeshWorld.findRandomPoint(center, radius, options)
    }

    isReachable(start, destination, options = {}) {
        return this.navMeshWorld.isReachable(start, destination, options)
    }

    reset() {
        this.crowdNavigation.reset()
    }

    get ready() {
        return this.navMeshWorld.ready
    }
}
