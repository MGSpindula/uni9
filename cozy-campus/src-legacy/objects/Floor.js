import * as THREE from "three";
import { Entity } from "../core/Entity";

export class Floor extends Entity {

    constructor() {

        super("Floor");

        this.object3D = new THREE.Group();
        this.walkableSurfaces = [];

        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(20, 20),
            new THREE.MeshStandardMaterial({ color: 0x6ea96e })
        );

        ground.rotation.x = -Math.PI / 2;
        this.addWalkableSurface(ground);

        // Test route: north-2 -> upper-north -> upper-east -> east-exit.
        // Both slopes are real clickable meshes and their endpoints match the
        // Y values authored in CozyCampusNavigation exactly.
        this.addWalkableSurface(this.createSlope({
            start: new THREE.Vector3(3, 0.01, -3),
            end: new THREE.Vector3(6, 2.01, -3),
            width: 2.4,
            color: 0x87b978
        }));
        this.addWalkableSurface(this.createPlatform({
            center: new THREE.Vector3(7.2, 2, -1.2),
            width: 2.4,
            length: 6,
            color: 0x78a96f
        }));
        this.addWalkableSurface(this.createSlope({
            start: new THREE.Vector3(7.2, 2.01, 1.8),
            end: new THREE.Vector3(7.2, 0.01, 5),
            width: 2.4,
            color: 0x87b978
        }));

        // Grounding raycasts run before the first render, so rotated/translated
        // surface matrices must already be valid on the first simulation frame.
        this.object3D.updateMatrixWorld(true);

    }

    // -----------------------------
    // Walkable geometry
    // -----------------------------

    addWalkableSurface(surface) {

        surface.receiveShadow = true;
        surface.castShadow = true;
        surface.userData.walkable = true;
        this.walkableSurfaces.push(surface);
        this.object3D.add(surface);

    }

    createSlope({ start, end, width, color }) {

        const direction = end.clone().sub(start);
        const horizontal = new THREE.Vector3(
            direction.x,
            0,
            direction.z
        ).normalize();
        const side = new THREE.Vector3(-horizontal.z, 0, horizontal.x)
            .multiplyScalar(width * 0.5);
        const vertices = [
            start.clone().add(side),
            start.clone().sub(side),
            end.clone().add(side),
            end.clone().sub(side)
        ];
        const geometry = new THREE.BufferGeometry().setFromPoints(vertices);

        geometry.setIndex([0, 1, 2, 2, 1, 3]);
        geometry.computeVertexNormals();

        return new THREE.Mesh(
            geometry,
            new THREE.MeshStandardMaterial({
                color,
                side: THREE.DoubleSide
            })
        );

    }

    createPlatform({ center, width, length, color }) {

        const platform = new THREE.Mesh(
            new THREE.PlaneGeometry(width, length),
            new THREE.MeshStandardMaterial({ color })
        );

        platform.rotation.x = -Math.PI / 2;
        platform.position.copy(center);
        return platform;

    }

    // -----------------------------
    // Lifecycle
    // -----------------------------

    update() {

    }

}
