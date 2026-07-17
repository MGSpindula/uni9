import { EntityState } from "../core/EntityState";

export class AnimationController {

    constructor(visual = null, mixer = null) {

        // The primitive player has no clips yet. A GLB will provide this mixer later.
        this.visual = visual;
        this.mixer = mixer;
        this.state = EntityState.IDLE;

        // Procedural animation changes local visual offsets, never world movement.
        this.time = 0;
        this.walkPhase = 0;
        this.strideLength = 1.15;
        this.visualSpeed = 0;
        this.speedResponse = 10;
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

    update(delta, motion = null) {

        this.mixer?.update(delta);

        if (!this.visual) return;

        // Physical motion is authoritative. Collision avoidance can move a
        // character while its semantic state remains WAITING.
        const targetSpeed = motion?.moving
            ? motion.normalizedSpeed
            : 0;
        const blend = 1 - Math.exp(-this.speedResponse * delta);

        this.visualSpeed += (targetSpeed - this.visualSpeed) * blend;

        if (this.visualSpeed > 0.001) {

            this.time += delta;

            // Phase follows physical distance, not elapsed time. Changing the
            // locomotion speed therefore changes the walk cycle without foot
            // sliding, and a traffic stop freezes progress through the stride.
            this.walkPhase += (
                (motion?.distanceMoved ?? 0) / this.strideLength
            ) * Math.PI * 2;

            // A small bob and lean make the primitive communicate "walking".
            this.visual.position.y =
                this.baseY +
                Math.abs(Math.sin(this.walkPhase * 2)) *
                0.08 * this.visualSpeed;

            this.visual.rotation.z =
                this.baseRotationZ +
                Math.sin(this.walkPhase) * 0.05 * this.visualSpeed;

            return;

        }

        // Returning to idle restores the original local transform.
        this.visual.position.y = this.baseY;
        this.visual.rotation.z = this.baseRotationZ;

    }

}
