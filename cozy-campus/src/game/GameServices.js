import { EntityRegistry } from "../core/EntityRegistry.js"
import { SelectionManager } from "../core/SelectionManager.js"

import { NavMeshWorld } from "../navigation/NavMeshWorld.js"
import { CrowdNavigationSystem } from "../navigation/CrowdNavigationSystem.js"
import { NavigationFacade } from "../navigation/NavigationFacade.js"

export class GameServices {
    constructor({ camera, element, config, requestRender }) {
        if (!camera) {
            throw new TypeError("GameServices requires a camera.")
        }

        if (!element) {
            throw new TypeError("GameServices requires an input element.")
        }

        this.config = config
        this.requestRender = requestRender

        this.registry = new EntityRegistry()

        this.selection = new SelectionManager({
            camera,
            registry: this.registry,
            element,

            onChanged: () => {
                this.requestRender?.()
            },
        })

        this.navMeshWorld = new NavMeshWorld({
            config: config.navigation,
        })

        this.crowdNavigation = new CrowdNavigationSystem({
            navMeshWorld: this.navMeshWorld,

            config: config.navigation.crowd,

            defaultAgent: config.navigation.defaultAgent,

            onChanged: () => {
                this.requestRender?.()
            },
        })

        this.navigation = new NavigationFacade({
            navMeshWorld: this.navMeshWorld,

            crowdNavigation: this.crowdNavigation,
        })
    }

    update(delta) {
        this.crowdNavigation.update(delta)
    }

    resetLevel() {
        this.navigation.reset()
        this.navMeshWorld.clear()
    }

    dispose() {
        this.selection.dispose()

        this.navigation.reset()
        this.crowdNavigation.dispose()
        this.navMeshWorld.dispose()

        this.registry.clear()

        this.requestRender = null
    }
}
