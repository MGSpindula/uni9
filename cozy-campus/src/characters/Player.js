import { Character } from "./Character.js"

export class Player extends Character {
    constructor(options = {}) {
        const {
            name = "Player",
            color = 0x4f8edb,
            ...characterOptions
        } = options

        super({
            ...characterOptions,
            name,
            color,
            kind: "player",
        })

        this.isPlayer = true
    }
}
