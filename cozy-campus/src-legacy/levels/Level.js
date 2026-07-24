// Content pipeline contract. A level owns authored entities, lighting and its
// navigation topology; Game owns reusable services and the render pipeline.
export class Level {
    constructor(id) { this.id = id; }
    load() { throw new Error(`Level "${this.id}" must implement load(game).`); }
    unload() {}
}
