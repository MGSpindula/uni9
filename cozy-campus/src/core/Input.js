import * as THREE from "three";
import { Raycast } from "./Raycast";

export class Input {

    constructor(camera, scene, registry, selection) {

        this.raycast = new Raycast(
            camera,
            scene
        );

        this.registry = registry;

        this.selection = selection;

        window.addEventListener(
            "mousemove",
            (event) => this.hover(event)
        );

        window.addEventListener(
            "click",
            (event) => this.click(event)
        );

    }

    hover(event) {

        const hit = this.raycast.getHit(

            event,

            this.registry

        );

        if (

            !hit ||

            !hit.entity.canInteract()

        ) {

            this.selection.clear();

            document.body.style.cursor =
                "default";

            return;

        }

        this.selection.setHovered(

            hit.entity,

            hit.object

        );

        document.body.style.cursor =
            "pointer";

    }

    click(event) {

        const hit = this.raycast.getHit(

            event,

            this.registry

        );

        if (!hit || !hit.entity.canInteract()) {

            return;

        }

        hit.entity.interact(
            hit.object
        );

    }

}