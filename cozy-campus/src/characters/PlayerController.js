import { Input } from "../core/Input";

export class PlayerController {

    constructor({ player, selection, interactionSystem, element }) {

        this.player = player;
        this.selection = selection;
        this.interactionSystem = interactionSystem;
        this.element = element;
        this.input = new Input(element);

        this.bindInput();

    }

    // -----------------------------
    // Pointer input (Player only)
    // -----------------------------

    bindInput() {

        this.input.on("MouseMove", event => {

            this.selection.handleMouseMove(event);

        });

        this.input.on("MouseLeave", () => {

            this.selection.clearHover();
            this.element.style.cursor = "default";

        });

        this.input.on("Click", event => this.handleClick(event));

    }

    handleClick(event) {

        const hit =
            this.selection.handleClick(
                event
            );

        if (!hit) {

            return false;

        }

        const pointerResult =
            hit.entity.pointerInteract(
                hit.object,
                hit
            );

        if (
            !pointerResult ||
            pointerResult.type !==
            "INTERACT"
        ) {

            return false;

        }

        return this.interactionSystem
            .request({
                actor:
                    this.player,

                target:
                    hit.entity,

                interactionId:
                    pointerResult
                        .interactionId,

                tags:
                    pointerResult.tags ??
                    []
            });

    }

    dispose() {

        this.input.dispose();
        this.element.style.cursor = "default";

    }

}
