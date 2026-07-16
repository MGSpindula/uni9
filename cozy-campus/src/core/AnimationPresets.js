import { Tween } from "./Tween";

// Reusable visual motions built on Entity's tween ownership.
export class AnimationPresets {

    // -----------------------------
    // Generic tween
    // -----------------------------

    static to(entity, {
        object,
        property,
        to,
        duration = 0.5,
        easing = Tween.easeOutQuad,
        onComplete = null
    }) {

        return entity.tween({
            object,
            property,
            from: object[property],
            to,
            duration,
            easing,
            onComplete
        });

    }

    // -----------------------------
    // Scale
    // -----------------------------

    static scaleTo(entity, {
        // object3D is only a safe default for static/simple entities.
        // For a moving character or a visual-only effect, pass entity.visual explicitly.
        target = entity.object3D,
        to,
        duration = 0.25,
        easing = Tween.easeOutQuad,
        onComplete = null
    }) {

        entity.tweenScale(
            target.scale,
            target.scale.clone(),
            to,
            duration,
            easing,
            onComplete
        );

    }

    static scaleBounce(entity, {
        // Bouncing object3D changes the entity's world transform. Use entity.visual
        // when this is only presentation feedback and must not affect gameplay.
        target = entity.object3D,
        multiplier = 1.2,
        outDuration = 0.2,
        returnDuration = 0.25,
        outEasing = Tween.easeOutBack,
        returnEasing = Tween.easeInOutQuad,
        onComplete = null
    } = {}) {

        const initialScale = target.scale.clone();
        const peakScale = initialScale.clone().multiplyScalar(multiplier);

        this.scaleTo(entity, {
            target,
            to: peakScale,
            duration: outDuration,
            easing: outEasing,
            onComplete: () => {

                this.scaleTo(entity, {
                    target,
                    to: initialScale,
                    duration: returnDuration,
                    easing: returnEasing,
                    onComplete
                });

            }
        });

    }

    // -----------------------------
    // Position
    // -----------------------------

    static jump(entity, {
        // A jump on object3D is physical/world movement. Target entity.visual for a
        // cosmetic hop that should not alter navigation, collision or network state.
        target = entity.object3D,
        height = 1,
        upDuration = 0.3,
        downDuration = 0.3,
        upEasing = Tween.easeOutCubic,
        downEasing = Tween.easeInCubic,
        onComplete = null
    } = {}) {

        const initialY = target.position.y;

        this.to(entity, {
            object: target.position,
            property: "y",
            to: initialY + height,
            duration: upDuration,
            easing: upEasing,
            onComplete: () => {

                this.to(entity, {
                    object: target.position,
                    property: "y",
                    to: initialY,
                    duration: downDuration,
                    easing: downEasing,
                    onComplete
                });

            }
        });

    }

}
