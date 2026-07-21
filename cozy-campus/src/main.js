import "./style.css";

import { Renderer } from "./Renderer";
import { Game } from "./Game";
import { CozyCampusLevel } from "./levels/CozyCampusLevel";

const renderer = new Renderer();

const game = new Game(renderer, { level: new CozyCampusLevel() });

// O helper pode ser habilitado durante o desenvolvimento.
game.setNavigationHelperVisible(true);

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
