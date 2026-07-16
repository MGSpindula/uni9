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

            const isHovering = this.selection.handleMouseMove(event);

            this.element.style.cursor = isHovering ? "pointer" : "default";

        });

        this.input.on("MouseLeave", () => {

            this.selection.clearHover();
            this.element.style.cursor = "default";

        });

        this.input.on("Click", event => this.handleClick(event));

    }

    handleClick(event) {

        const hit = this.selection.handleClick(event);

        if (!hit) return false;

        // onPointerInteract() is immediate Player feedback and may return a
        // generic interaction request. NPCs skip this method and submit the
        // same request shape from their behavior/state logic.
        const request = hit.entity.pointerInteract(hit.object, hit);

        if (request) {

            this.interactionSystem.request({
                actor: this.player,
                target: hit.entity,
                ...request
            });

        }

        return true;

    }

}
