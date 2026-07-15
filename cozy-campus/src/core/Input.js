export class Input {

    constructor(element = window) {

        this.element = element;
        this.listeners = new Map();

        this.handlers = {
            MouseMove: event => this.emit("MouseMove", event),
            MouseEnter: event => this.emit("MouseEnter", event),
            MouseLeave: event => this.emit("MouseLeave", event),
            Click: event => this.emit("Click", event)
        };

        element.addEventListener("mousemove", this.handlers.MouseMove);
        element.addEventListener("mouseenter", this.handlers.MouseEnter);
        element.addEventListener("mouseleave", this.handlers.MouseLeave);
        element.addEventListener("click", this.handlers.Click);

    }

    on(eventName, listener) {

        if (!this.listeners.has(eventName)) {

            this.listeners.set(eventName, new Set());

        }

        this.listeners.get(eventName).add(listener);

        return () => this.off(eventName, listener);

    }

    off(eventName, listener) {

        this.listeners.get(eventName)?.delete(listener);

    }

    emit(eventName, event) {

        for (const listener of this.listeners.get(eventName) ?? []) {

            listener(event);

        }

    }

    dispose() {

        this.element.removeEventListener("mousemove", this.handlers.MouseMove);
        this.element.removeEventListener("mouseenter", this.handlers.MouseEnter);
        this.element.removeEventListener("mouseleave", this.handlers.MouseLeave);
        this.element.removeEventListener("click", this.handlers.Click);
        this.listeners.clear();

    }

}
