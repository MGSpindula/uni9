import { EntityState } from "../core/EntityState";

export class AnimationController {

    constructor(visual = null, mixer = null) {

        // The primitive player has no clips yet. A GLB will provide this mixer later.
        this.visual = visual;
        this.mixer = mixer;
        this.state = EntityState.IDLE;

        // Procedural animation changes local visual offsets, never world movement.
        this.time = 0;
        this.baseY = visual?.position.y ?? 0;
        this.baseRotationZ = visual?.rotation.z ?? 0;

    }

    // -----------------------------
    // States
    // -----------------------------

    play(state) {

        if (this.state === state) return;

        this.state = state;

        // Later: fade out the old AnimationAction and fade in the action for state.

    }

    isPlaying(state) {

        return this.state === state;

    }

    // -----------------------------
    // Lifecycle
    // -----------------------------

    update(delta) {

        this.mixer?.update(delta);

        if (!this.visual) return;

        if (this.isPlaying(EntityState.WALKING)) {

            this.time += delta;

            // A small bob and lean make the primitive communicate "walking".
            this.visual.position.y =
                this.baseY + Math.abs(Math.sin(this.time * 9)) * 0.08;

            this.visual.rotation.z =
                this.baseRotationZ + Math.sin(this.time * 4.5) * 0.05;

            return;

        }

        // Returning to idle restores the original local transform.
        this.visual.position.y = this.baseY;
        this.visual.rotation.z = this.baseRotationZ;

    }

}
