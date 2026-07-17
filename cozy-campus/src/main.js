import "./style.css";

import { Renderer } from "./Renderer";
import { Scene } from "./Scene";

const renderer = new Renderer();

const scene = new Scene(renderer);

// Desativar o NavigationGraphHelper por padrão
scene.setNavigationHelperVisible(false);

scene.start();