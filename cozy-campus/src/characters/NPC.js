import { Character } from "./Character.js"

export class NPC extends Character {
    constructor(options = {}) {
        const {
            name = "NPC",
            color = 0xe6a06d,
            ...characterOptions
        } = options

        super({
            ...characterOptions,
            name,
            color,
            kind: "npc",
        })

        this.isNPC = true
    }
}