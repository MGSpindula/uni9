import * as THREE from "three";
import { Entity } from "../core/Entity";
import { EntityState } from "../core/EntityState";
import { Tween } from "../core/Tween";

export class Chair extends Entity {

    constructor() {

        super("Chair");

        this.cooldown = 0;

        this.setState(EntityState.IDLE);

        this.object3D = new THREE.Group();

        this.legsGroup = new THREE.Group();

        this.object3D.add(
            this.legsGroup
        );

        this.createSeat();
        this.createBack();
        this.createLegs();


        this.object3D.position.set(0, 0, 2);

    }


    createSeat() {

        this.seat = new THREE.Mesh(

            new THREE.BoxGeometry(
                1.5,
                0.2,
                1.5
            ),

            new THREE.MeshStandardMaterial({
                color: 0x8b4513
            })

        );

        this.seat.name = "Seat";

        this.seat.position.y = 1;

        this.seat.castShadow = true;

        this.object3D.add(this.seat);

        this.makeInteractable(this.seat);

    }


    createBack() {

        this.back = new THREE.Mesh(

            new THREE.BoxGeometry(
                1.5,
                1.8,
                0.2
            ),

            new THREE.MeshStandardMaterial({
                color: 0x8b4513
            })

        );

        this.back.position.set(
            0,
            1.8,
            -0.65
        );

        this.back.castShadow = true;

        this.object3D.add(this.back);

    }


    createLegs() {

        const geometry =
            new THREE.BoxGeometry(
                0.15,
                1,
                0.15
            );


        const material =
            new THREE.MeshStandardMaterial({
                color: 0x4b2500
            });


        const positions = [
            [-0.6, 0.5, -0.6],
            [0.6, 0.5, -0.6],
            [-0.6, 0.5, 0.6],
            [0.6, 0.5, 0.6]
        ];

        const legNames = [
            "FrontLeftLeg",
            "FrontRightLeg",
            "BackLeftLeg",
            "BackRightLeg"
        ];

        this.legs = [];


        for (let i = 0; i < positions.length; i++) {

            const leg = new THREE.Mesh(
                geometry,
                material
            );

            leg.name = legNames[i];

            leg.position.set(
                ...positions[i]
            );

            leg.castShadow = true;

            this.legsGroup.add(leg);

        }

    }

    hover(mesh) {

        mesh.material.emissive.set(0x444444);
        this.tweenScale(

            this.object3D.scale,

            undefined,

            new THREE.Vector3(1.2, 1.2, 1.2),

            0.5,

            Tween.easeOutBack
        );

    }

    unhover(mesh) {

        mesh.material.emissive.set(0x000000);

        if (!this.isState(EntityState.COOLDOWN)) {

            this.tweenScale(

                this.object3D.scale,

                undefined,

                new THREE.Vector3(1, 1, 1),

                0.5,

                Tween.easeOutBack
            );

        }

    }

    interact(mesh) {

        if (!this.isState(EntityState.IDLE)) {

            return;

        }

        this.disableInteraction();

        this.setState(EntityState.COOLDOWN);

        this.cooldown = 5;

        this.animateColors();
        this.animateLeg();
        this.animateJump();
        this.animateScale();

    }

    animateColors() {

        const red = new THREE.Color(0xff0000);
        const duration = 2

        this.tweenColor(this.seat.material.color, undefined, red, duration);
        this.tweenColor(this.back.material.color, undefined, red, duration);

        for (const leg of this.legsGroup.children) {

            this.tweenColor(leg.material.color, undefined, red, duration);

        }

    }

    animateLeg() {

        const leg = this.object3D.getObjectByName("FrontLeftLeg");

        this.tween({

            object: leg.rotation,
            property: "z",

            from: leg.rotation.z,
            to: 0.5,

            duration: 0.5,

            easing: Tween.easeOutQuad

        });

    }

    animateJump() {

        this.tween({

            object: this.object3D.position,
            property: "y",

            from: this.object3D.position.y,
            to: 3,

            duration: 1,

            easing: Tween.easeOutCubic,

            onComplete: () => {

                this.tween({

                    object: this.object3D.position,
                    property: "y",

                    from: this.object3D.position.y,
                    to: 0,

                    duration: 1,

                    easing: Tween.easeInCubic

                });

            }

        });

    }

    animateScale() {

        this.tweenScale(

            this.object3D.scale,

            undefined,

            new THREE.Vector3(1.2, 1.2, 1.2),

            0.5,

            Tween.easeOutBack,

            () => {

                this.tweenScale(

                    this.object3D.scale,

                    undefined,

                    new THREE.Vector3(1, 1, 1),

                    0.5,

                    Tween.easeInOutQuad

                );

            }

        );

    }

    onStateChanged(previous, current) {

        console.log(previous, "->", current);

        switch (current) {

            case EntityState.IDLE:

                break;

            case EntityState.COOLDOWN:

                break;

        }

    }

    update(delta) {

        super.update(delta);

        if (this.isState(EntityState.COOLDOWN)) {

            this.cooldown -= delta;

            if (this.cooldown <= 0) {

                this.enableInteraction();

                this.setState(EntityState.IDLE);

            }

        }

    }

}