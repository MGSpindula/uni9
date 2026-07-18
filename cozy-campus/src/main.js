import "./style.css";

import { Renderer } from "./Renderer";
import { Scene } from "./Scene";

const renderer = new Renderer();

const scene = new Scene(renderer);

// O helper pode ser habilitado durante o desenvolvimento.
scene.setNavigationHelperVisible(true);

scene.start();

function disposeGame() {

    scene.dispose();
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