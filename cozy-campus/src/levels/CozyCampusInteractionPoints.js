import * as THREE from "three";

import { Entity } from "../core/Entity";
import { InteractionPoint } from "../navigation/InteractionPoint";
import { InteractionDefinition } from "../core/interactions/InteractionDefinition";

export class CozyCampusInteractionPoints
    extends Entity {

    constructor() {

        super(
            "Cozy Campus Interaction Points"
        );

        this.object3D =
            new THREE.Group();

        this.object3D.name =
            "CozyCampusInteractionPoints";

        this.visual =
            this.object3D;

        this.createPoints();
        this.createDefinitions();
        this.createClickTargets();

        this.disableOutline();

    }

    createPoints() {

        this.windowPoint =
            this.addInteractionPoint(
                new InteractionPoint(
                    "ambient:window",
                    {
                        position:
                            new THREE.Vector3(
                                -7, 
                                0, 
                                -7
                            ),

                        rotationY:
                            Math.PI * 1.45,

                        connectTo:
                            "north-1",

                        terminal:
                            true,

                        metadata: {
                            pose: "lean",
                            role: "action"
                        }
                    }
                )
            );

        this.lookupPoint =
            this.addInteractionPoint(
                new InteractionPoint(
                    "ambient:lookup",
                    {
                        position:
                            new THREE.Vector3(
                                8.5, 
                                2, 
                                -4
                            ),

                        rotationY:
                            Math.PI * 1.45,

                        connectTo:
                            "upper-north-2",

                        terminal:
                            true,

                        metadata: {
                            pose: "lean",
                            role: "action"
                        }
                    }
                )
            );

        this.westPoint =
            this.addInteractionPoint(
                new InteractionPoint(
                    "ambient:west",
                    {
                        position:
                            new THREE.Vector3(
                                3.2,
                                0,
                                9
                            ),

                        rotationY:
                            Math.PI * 0.2,

                        connectTo:
                            "west-1",

                        terminal:
                            true,

                        metadata: {
                            pose: "stand",
                            role: "action"
                        }
                    }
                )
            );

        this.eastPoint =
            this.addInteractionPoint(
                new InteractionPoint(
                    "ambient:east",
                    {
                        position:
                            new THREE.Vector3(
                                9,
                                0,
                                8
                            ),

                        connectTo:
                            "east-exit",

                        terminal:
                            true,

                        metadata: {
                            pose: "stand",
                            role: "action"
                        }
                    }
                )
            );

        this.spawnPoint =
            this.addInteractionPoint(
                new InteractionPoint(
                    "ambient:spawn",
                    {
                        position:
                            new THREE.Vector3(
                                1.2,
                                0,
                                -9.1
                            ),

                        rotationY:
                            Math.PI * 0.75,

                        connectTo:
                            "spawn",

                        terminal:
                            true,

                        metadata: {
                            pose: "stand",
                            role: "action"
                        }
                    }
                )
            );

        this.ballPoint =
            this.addInteractionPoint(
                new InteractionPoint(
                    "ambient:ball",
                    {
                        position:
                            new THREE.Vector3(
                                -9, 
                                0, 
                                -1
                            ),

                        rotationY:
                            Math.PI * 1,

                        connectTo:
                            "west-3",

                        terminal:
                            true,

                        metadata: {
                            pose: "stand",
                            role: "action"
                        }
                    }
                )
            );

    }

    createDefinitions() {

        for (
            const point of
            this.interactionPoints
        ) {

            this.addInteractionDefinition(
                new InteractionDefinition({
                    id:
                        `idle:${point.id}`,

                    tags: [
                        "npc-interaction",
                        "idle",
                        "ambient",
                        point.metadata.pose ??
                        "stand"
                    ],

                    point
                })
            );

        }

    }

    createClickTargets() {

        for (
            const point of
            this.interactionPoints
        ) {

            const clickTarget =
                new THREE.Mesh(
                    new THREE.CylinderGeometry(
                        0.65,
                        0.65,
                        1.8,
                        12
                    ),

                    new THREE.MeshBasicMaterial({
                        color: 0x00ffff,
                        transparent: true,
                        opacity: 0.3,
                        depthWrite: false
                    })
                );

            clickTarget.name =
                `AmbientClickTarget:${point.id}`;

            clickTarget.position.y =
                0.9;

            clickTarget.userData.interactionId =
                `idle:${point.id}`;

            point.object3D.add(
                clickTarget
            );

            this.makeInteractable(
                clickTarget
            );

        }

    }

    onPointerInteract(object) {

        const interactionId =
            object?.userData
                ?.interactionId;

        if (!interactionId) {

            return null;

        }

        return {
            type: "INTERACT",
            interactionId
        };

    }

}