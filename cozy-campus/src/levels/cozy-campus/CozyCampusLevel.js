import { AmbientLight, Color, DirectionalLight } from "three"

import { DEBUG_REGIONS } from "../../debug/DebugOverlay.js"
import { NPC } from "../../characters/NPC.js"
import { CharacterDebugPanel } from "../../debug/CharacterDebugPanel.js"
import { World } from "../../game/World.js"
import { NavMeshDebugView } from "../../navigation/debug/NavMeshDebugView.js"
import { Level } from "../Level.js"
import { CozyCampusNavMeshSource } from "./CozyCampusNavMeshSource.js"

const PROTOTYPE_NPC_SPAWN = Object.freeze({
    x: -6,
    y: 0,
    z: -3,
})

const PROTOTYPE_NPC_DESTINATION = Object.freeze({
    x: 7.2,
    y: 2,
    z: 2,
})

export class CozyCampusLevel extends Level {
    constructor() {
        super("cozy-campus")

        this.previousBackground = null

        this.navMeshSource = null
        this.navMeshDebugView = null

        this.prototypeNpc = null
        this.characterDebugPanel = null
    }

    load(game) {
        this.beginLoad(game)

        const { config, renderPipeline, services } = game

        const scene = renderPipeline.scene

        this.previousBackground = scene.background

        scene.background = new Color(0x87ceeb)

        const world = new World({
            id: this.id,
            scene,
            services,
        })

        this.world = world

        this.createLights(world)

        this.navMeshSource = new CozyCampusNavMeshSource({
            agent: config.navigation.defaultAgent,
        })

        world.addSceneObject(this.navMeshSource.object3D, {
            dispose: () => {
                this.navMeshSource?.dispose()
            },
        })

        const navMeshResult = this.navMeshSource.build()

        services.navMeshWorld.setNavMesh(navMeshResult.navMesh)

        if (config.debug.enabled) {
            this.navMeshDebugView = new NavMeshDebugView({
                scene,

                navMeshWorld: services.navMeshWorld,

                visible: config.debug.navigationVisible,
            })
        }

        this.prototypeNpc = this.createPrototypeNpc(world, game)

        if (config.debug.enabled) {
            this.characterDebugPanel = new CharacterDebugPanel({
                character: this.prototypeNpc,

                navigation: game.navigation,

                mount:
                    game.debugOverlay?.getRegion(DEBUG_REGIONS.LEFT) ??
                    document.body,

                routePoints: [PROTOTYPE_NPC_SPAWN, PROTOTYPE_NPC_DESTINATION],

                visible: config.debug.characterVisible,

                collapsed: false,
                autoStart: true,
            })

            world.addController(this.characterDebugPanel)
        }

        game.requestRender()

        return this.completeLoad(world)
    }

    createPrototypeNpc(world, game) {
        const navigationProfile = {
            ...game.config.navigation.defaultAgent,

            maxSpeed: 1.75,
            maxAcceleration: 7,
        }

        const npc = new NPC({
            id: "npc-prototype",
            name: "Prototype NPC",
            color: 0xe59a67,

            position: PROTOTYPE_NPC_SPAWN,

            navigationProfile,
        })

        world.addCharacter(npc, navigationProfile)

        return npc
    }

    createLights(world) {
        const ambient = new AmbientLight(0xffffff, 1)

        const sun = new DirectionalLight(0xffffff, 2)

        sun.name = "CozyCampusSun"

        sun.position.set(10, 20, 10)

        sun.castShadow = true

        sun.shadow.camera.left = -13
        sun.shadow.camera.right = 13
        sun.shadow.camera.top = 13
        sun.shadow.camera.bottom = -13
        sun.shadow.camera.near = 0.5
        sun.shadow.camera.far = 50

        sun.shadow.camera.updateProjectionMatrix()

        sun.shadow.mapSize.set(1024, 1024)

        sun.shadow.bias = -0.0001

        sun.target.position.set(0, 0, 0)

        world.addSceneObject(ambient)
        world.addSceneObject(sun)
        world.addSceneObject(sun.target)
    }

    unload(game) {
        this.navMeshDebugView?.dispose()

        this.navMeshDebugView = null

        super.unload(game)

        if (game?.renderPipeline?.scene) {
            game.renderPipeline.scene.background = this.previousBackground
        }

        this.previousBackground = null

        this.navMeshSource = null
        this.prototypeNpc = null
        this.characterDebugPanel = null
    }
}
