export class CharacterDebugPanel {

    constructor({ getRows, refreshInterval = 200 }) {

        this.getRows = getRows;
        this.copyFeedback = "";
        this.copyFeedbackUntil = 0;
        this.element = document.createElement("aside");
        this.element.className = "character-debug";
        document.body.appendChild(this.element);
        this.render();
        this.timer = window.setInterval(() => this.render(), refreshInterval);

    }

    render() {

        const rows = this.getRows();
        const collapsed = this.element.classList.contains("collapsed");

        this.element.replaceChildren();

        const header = document.createElement("header");
        const title = document.createElement("strong");
        const controls = document.createElement("div");
        const copy = document.createElement("button");
        const toggle = document.createElement("button");

        title.textContent = "Character Debug";
        copy.className = "character-debug-copy";
        copy.textContent = performance.now() < this.copyFeedbackUntil
            ? this.copyFeedback
            : "JSON";
        copy.title = "Copiar o debug instantaneo de todos os atores como JSON";
        copy.addEventListener("click", () => this.copyJsonSnapshot());
        toggle.textContent = collapsed ? "+" : "−";
        toggle.addEventListener("click", () => {

            this.element.classList.toggle("collapsed");
            this.render();

        });
        controls.className = "character-debug-controls";
        controls.append(copy, toggle);
        header.append(title, controls);
        this.element.append(header);

        if (collapsed) return;

        for (const row of rows) {

            const card = document.createElement("section");
            const heading = document.createElement("strong");
            const state = document.createElement("span");
            const details = document.createElement("dl");

            card.dataset.visibility = row.offscreen ? "offscreen" : "onscreen";
            card.dataset.collision = row.collisionActive ? "waiting" : "clear";

            heading.textContent = row.name;
            state.className = `character-debug-state ${row.state.toLowerCase()}`;
            state.textContent = row.state;
            card.append(heading, state);

            this.appendDetail(details, "Behavior", row.behavior);
            this.appendDetail(details, "Choice", row.choice);
            this.appendDetail(details, "Nav phase", row.phase);
            this.appendDetail(details, "Traversal", row.traversal);
            this.appendDetail(details, "Position", row.position);
            this.appendDetail(details, "View", row.view);
            this.appendDetail(details, "Location", row.location);
            this.appendDetail(details, "Lane", row.lane);
            this.appendDetail(details, "Next", row.next);
            this.appendDetail(details, "Progress", row.progress);
            this.appendDetail(details, "Intent", row.intent);
            this.appendDetail(details, "Interact.", row.interaction);
            this.appendDetail(details, "Queue", row.queue);
            this.appendDetail(details, "Wait", row.wait);
            this.appendDetail(details, "Collision", row.collision);
            this.appendDetail(details, "Recovery", row.recovery);
            this.appendDetail(details, "Flags", row.flags);
            card.append(details);
            this.element.append(card);

        }

    }

    createJsonSnapshot() {

        return JSON.stringify({
            capturedAt: new Date().toISOString(),
            characters: this.getRows()
        }, null, 2);

    }

    async copyJsonSnapshot() {

        const json = this.createJsonSnapshot();

        try {

            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(json);
            } else {
                this.copyTextFallback(json);
            }

            this.showCopyFeedback("Copied");

        } catch (error) {

            try {
                this.copyTextFallback(json);
                this.showCopyFeedback("Copied");
            } catch (fallbackError) {
                console.error(
                    "[CharacterDebug] Could not copy the JSON snapshot.",
                    fallbackError ?? error
                );
                this.showCopyFeedback("Error");
            }

        }

    }

    copyTextFallback(text) {

        const field = document.createElement("textarea");
        field.value = text;
        field.setAttribute("readonly", "");
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.appendChild(field);
        field.select();

        const copied = document.execCommand("copy");
        field.remove();

        if (!copied) throw new Error("document.execCommand(copy) failed.");

    }

    showCopyFeedback(message) {

        this.copyFeedback = message;
        this.copyFeedbackUntil = performance.now() + 1200;
        this.render();

    }

    appendDetail(list, label, value) {

        const term = document.createElement("dt");
        const description = document.createElement("dd");

        term.textContent = label;
        description.textContent = value ?? "—";
        list.append(term, description);

    }

    dispose() {

        window.clearInterval(this.timer);
        this.element.remove();

    }

}
