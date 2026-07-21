import { Game } from "./Game";
import { CozyCampusLevel } from "./levels/CozyCampusLevel";

// Backward-compatible name for older examples. New application code should
// instantiate Game and provide a Level implementing load(game)/unload(game).
export class Scene extends Game {
    constructor(renderer, options = {}) {
        super(renderer, {
            ...options,
            level: options.level ?? new CozyCampusLevel()
        });
    }
}
