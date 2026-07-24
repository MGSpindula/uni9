import * as CANNON from "cannon-es";

// Characters are kinematic navigation agents. Cannon mirrors their bodies for
// contact queries, but never pushes object3D or advances route progress.
export class PhysicsWorld {

    constructor(owner, {
        fixedTimeStep = 1 / 60,
        maxSubSteps = 3,
        contactSkin = 0.025
    } = {}) {

        this.owner = owner;
        this.fixedTimeStep = fixedTimeStep;
        this.maxSubSteps = maxSubSteps;
        this.contactSkin = contactSkin;
        this.world = new CANNON.World();
        this.world.gravity.set(0, 0, 0);
        this.world.broadphase = new CANNON.SAPBroadphase(this.world);
        this.world.defaultContactMaterial.friction = 0;
        this.world.defaultContactMaterial.restitution = 0;
        this.characterMaterial = new CANNON.Material("character");
        this.actorBodies = new Map();
        this.metrics = {
            corrections: 0,
            totalCorrection: 0,
            maximumCorrection: 0
        };

        this.world.addContactMaterial(new CANNON.ContactMaterial(
            this.characterMaterial,
            this.characterMaterial,
            {
                friction: 0,
                restitution: 0,
                contactEquationStiffness: 1e7,
                contactEquationRelaxation: 4
            }
        ));

    }

    registerActor(actor) {

        const radius = actor.collisionRadius ?? 0.36;
        const body = new CANNON.Body({
            mass: 1,
            material: this.characterMaterial,
            type: CANNON.Body.KINEMATIC,
            fixedRotation: true,
            linearDamping: 0.05,
            angularDamping: 1,
            allowSleep: false
        });

        body.addShape(new CANNON.Sphere(radius + this.contactSkin));
        body.position.set(
            actor.object3D.position.x,
            actor.object3D.position.y + radius,
            actor.object3D.position.z
        );
        body.velocity.set(0, 0, 0);
        body.angularVelocity.set(0, 0, 0);
        body.characterRadius = radius;
        // Dynamic response used to push actors away from their splines while
        // Locomotion kept advancing curveDistance. When contact cleared, that
        // stale progress snapped the actor forward. Traffic and the predictive
        // brake now prevent contact; Cannon remains detection-only here.
        body.collisionResponse = false;
        this.world.addBody(body);
        this.actorBodies.set(actor, body);

    }

    unregisterActor(actor) {

        const body = this.actorBodies.get(actor);

        if (!body) return;

        this.world.removeBody(body);
        this.actorBodies.delete(actor);

    }

    solve(delta) {

        this.metrics.corrections = 0;
        this.metrics.totalCorrection = 0;
        this.metrics.maximumCorrection = 0;

        for (const [actor, body] of this.actorBodies) {

            if (!actor.isActive()) continue;

            body.position.x = actor.object3D.position.x;
            body.position.z = actor.object3D.position.z;
            body.velocity.x = 0;
            body.velocity.z = 0;

            body.position.y = actor.object3D.position.y + body.characterRadius;
            body.velocity.y = 0;
            body.angularVelocity.set(0, 0, 0);
            body.wakeUp();

        }

        this.world.step(this.fixedTimeStep, delta, this.maxSubSteps);

    }

}
