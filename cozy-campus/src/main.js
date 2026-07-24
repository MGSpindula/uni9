import "./style.css"

import { GAME_CONFIG } from "./config/GameConfig.js"
import { Game } from "./game/Game.js"
import { Renderer } from "./rendering/Renderer.js"
import { CozyCampusLevel } from "./levels/cozy-campus/CozyCampusLevel.js"

let game = null
let renderer = null
let disposed = false

async function waitForDocument() {
    if (document.readyState !== "loading") {
        return
    }

    await new Promise((resolve) => {
        document.addEventListener("DOMContentLoaded", resolve, { once: true })
    })
}

async function bootstrap() {
    await waitForDocument()

    const mount =
        document.querySelector(GAME_CONFIG.app.mountSelector) ?? document.body

    renderer = new Renderer({
        mount,
        config: GAME_CONFIG.render,
    })

    game = new Game({
        renderer,
        config: GAME_CONFIG,
        level: new CozyCampusLevel(),
    })

    if (GAME_CONFIG.debug.exposeGlobal) {
        window.cozyCampus = {
            game,
            renderer,
        }
    }

    await game.start()
}

function disposeApplication() {
    if (disposed) {
        return
    }

    disposed = true

    if (window.cozyCampus) {
        delete window.cozyCampus
    }

    game?.dispose()
    renderer?.dispose()

    game = null
    renderer = null
}

window.addEventListener("beforeunload", disposeApplication, { once: true })

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        window.removeEventListener("beforeunload", disposeApplication)

        disposeApplication()
    })
}

bootstrap().catch((error) => {
    console.error("Cozy Campus failed to start.", error)

    disposeApplication()
})
