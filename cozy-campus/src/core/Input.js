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

        this.hoveredEntity = null;
        this.hoveredObject = null;

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

        if (!hit || !hit.entity.canInteract()) {

            if (this.hoveredEntity) {

                this.hoveredEntity.unhover(
                    this.hoveredObject
                );

                this.selection.hover(
                    this.hoveredObject
                );

                this.hoveredEntity = null;
                this.hoveredObject = null;

            }

            this.selection.hover(null);

            document.body.style.cursor = "default";

            return;

        }

        if (

            hit.entity !== this.hoveredEntity ||

            hit.object !== this.hoveredObject

        ) {

            if (this.hoveredEntity) {

                this.hoveredEntity.unhover(
                    this.hoveredObject
                );

            }

            this.hoveredEntity = hit.entity;
            this.hoveredObject = hit.object;

            this.hoveredEntity.hover(
                this.hoveredObject
            );

        }

        document.body.style.cursor = "pointer";

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