export class Level {
    constructor(id) {
        if (typeof id !== "string" || id.trim().length === 0) {
            throw new TypeError("Level requires a non-empty id.")
        }

        this.id = id
        this.game = null
        this.world = null
        this.loading = false
        this.loaded = false
    }

    beginLoad(game) {
        if (!game) {
            throw new TypeError(`Level "${this.id}" requires a Game.`)
        }

        if (this.loading) {
            throw new Error(`Level "${this.id}" is already loading.`)
        }

        if (this.loaded) {
            throw new Error(`Level "${this.id}" is already loaded.`)
        }

        this.game = game
        this.loading = true
    }

    completeLoad(world) {
        if (!this.loading) {
            throw new Error(`Level "${this.id}" did not begin loading.`)
        }

        if (!world || typeof world.dispose !== "function") {
            throw new TypeError(
                `Level "${this.id}" must provide a valid World.`,
            )
        }

        this.world = world
        this.loading = false
        this.loaded = true

        return world
    }

    load() {
        throw new Error(`Level "${this.id}" must implement load(game).`)
    }

    unload() {
        this.world?.dispose()

        this.world = null
        this.game = null
        this.loading = false
        this.loaded = false
    }
}
