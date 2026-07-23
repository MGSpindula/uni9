import "./style.css";

import { Renderer } from "./Renderer";
import { Game } from "./Game";
import {
    DEBUG_MODE,
    SIMPLE_PERFORMANCE_DEBUG
} from "./GameConfig";
import { CozyCampusLevel } from "./levels/CozyCampusLevel";

const renderer = new Renderer();

const game = new Game(renderer, {
    level: new CozyCampusLevel(),
    debugMode: DEBUG_MODE,
    simplePerformanceDebug: SIMPLE_PERFORMANCE_DEBUG
});

game.start();

function disposeGame() {

    game.dispose();
    renderer.dispose();

}

window.addEventListener(
    "beforeunload",
    disposeGame,
    { once: true }
);

if (import.meta.hot) {

    import.meta.hot.dispose(() => {

        window.removeEventListener(
            "beforeunload",
            disposeGame
        );

        disposeGame();

    });

}
