export class CharacterDebugPanel {

    constructor({ getRows, refreshInterval = 200 }) {

        this.getRows = getRows;
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
        const toggle = document.createElement("button");

        title.textContent = "Character Debug";
        toggle.textContent = collapsed ? "+" : "−";
        toggle.addEventListener("click", () => {

            this.element.classList.toggle("collapsed");
            this.render();

        });
        header.append(title, toggle);
        this.element.append(header);

        if (collapsed) return;

        for (const row of rows) {

            const card = document.createElement("section");
            const heading = document.createElement("strong");
            const state = document.createElement("span");
            const details = document.createElement("dl");

            heading.textContent = row.name;
            state.className = `character-debug-state ${row.state.toLowerCase()}`;
            state.textContent = row.state;
            card.append(heading, state);

            this.appendDetail(details, "Behavior", row.behavior);
            this.appendDetail(details, "Nav phase", row.phase);
            this.appendDetail(details, "Traversal", row.traversal);
            this.appendDetail(details, "Position", row.position);
            this.appendDetail(details, "Location", row.location);
            this.appendDetail(details, "Lane", row.lane);
            this.appendDetail(details, "Next", row.next);
            this.appendDetail(details, "Progress", row.progress);
            this.appendDetail(details, "Intent", row.intent);
            this.appendDetail(details, "Interact.", row.interaction);
            this.appendDetail(details, "Queue", row.queue);
            this.appendDetail(details, "Wait", row.wait);
            this.appendDetail(details, "Flags", row.flags);
            card.append(details);
            this.element.append(card);

        }

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
