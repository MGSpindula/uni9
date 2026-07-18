import { Input } from "../core/Input";
import { InteractionIntent } from "../core/interactions/InteractionIntent";

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
            this.selection.handleClick(event);

        if (!hit) {

            return;

        }

        const pointerResult =
            hit.entity.pointerInteract(
                hit.object,
                hit
            );

        if (
            pointerResult?.type === "INTERACT"
        ) {

            const intent =
                new InteractionIntent({
                    actor: this.player,
                    target: hit.entity,
                    interactionId:
                        pointerResult.interactionId,
                    tags:
                        pointerResult.tags ?? []
                });

            this.interactionSystem.request(
                intent
            );

        }

        return true;

    }

    dispose() {

        this.input.dispose();
        this.element.style.cursor = "default";

    }

}
