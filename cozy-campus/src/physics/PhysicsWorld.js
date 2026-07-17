import * as CANNON from "cannon";
import * as THREE from "three";

export class PhysicsWorld {
  constructor(gravity = -9.81) {
    this.world = new CANNON.World();
    this.world.gravity.set(0, gravity, 0);
    this.world.defaultContactMaterial.friction = 0.3;
    this.world.defaultContactMaterial.restitution = 0.0;
    
    this.actorBodies = new Map();
    this.staticBodies = [];
    this.characterMaterial = new CANNON.Material("character");
    this.groundMaterial = new CANNON.Material("ground");
    
    // Reduce friction between characters
    const charCharContact = new CANNON.ContactMaterial(
      this.characterMaterial,
      this.characterMaterial,
      {
        friction: 0.0,
        restitution: 0.0,
        contactEquationStiffness: 1e7,
        contactEquationRelaxation: 3
      }
    );
    this.world.addContactMaterial(charCharContact);
    
    // Ground contact
    const groundCharContact = new CANNON.ContactMaterial(
      this.groundMaterial,
      this.characterMaterial,
      {
        friction: 0.3,
        restitution: 0.0
      }
    );
    this.world.addContactMaterial(groundCharContact);
  }

  createActorBody(actor, radius = 0.35, height = 1.8) {
    // Use sphere for simplicity (Cannon handles collision well)
    // More accurate would be capsule, but sphere is sufficient for ground movement
    const shape = new CANNON.Sphere(radius);
    const body = new CANNON.Body({
      mass: 75, // ~human mass in kg
      shape: shape,
      material: this.characterMaterial,
      linearDamping: 0.5,
      angularDamping: 0.99 // Prevent spinning
    });

    // Position body at actor location
    if (actor.object3D && actor.object3D.position) {
      body.position.set(
        actor.object3D.position.x,
        actor.object3D.position.y + radius,
        actor.object3D.position.z
      );
    }

    // Lock rotation (characters don't tumble)
    body.quaternion.set(0, 0, 0, 1);
    body.angularVelocity.set(0, 0, 0);

    body.characterRadius = radius;
    this.world.addBody(body);
    this.actorBodies.set(actor, body);
    
    return body;
  }

  createTerrainBodyFromMesh(mesh) {
    if (!mesh?.isMesh || !mesh.geometry) return null;

    mesh.updateWorldMatrix(true, false);

    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    mesh.matrixWorld.decompose(position, quaternion, scale);

    const geometry = mesh.geometry;
    const body = new CANNON.Body({
      mass: 0,
      material: this.groundMaterial
    });

    const vertices = [];
    const indices = [];
    const posAttr = geometry.getAttribute("position");

    if (!posAttr) return null;

    for (let i = 0; i < posAttr.count; i++) {
      vertices.push(
        posAttr.getX(i) * scale.x,
        posAttr.getY(i) * scale.y,
        posAttr.getZ(i) * scale.z
      );
    }

    const indexAttr = geometry.getIndex();
    if (indexAttr) {
      for (let i = 0; i < indexAttr.count; i++) {
        indices.push(indexAttr.getX(i));
      }
    } else {
      for (let i = 0; i < posAttr.count; i++) {
        indices.push(i);
      }
    }

    const shape = new CANNON.Trimesh(vertices, indices);
    body.addShape(shape);
    body.position.set(position.x, position.y, position.z);
    body.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    this.world.addBody(body);
    this.staticBodies.push(body);

    return body;
  }

  createTerrainBody(geometry, position = new THREE.Vector3(0, 0, 0), scale = 1) {
    // Static trimesh body from Three.js geometry
    const body = new CANNON.Body({
      mass: 0, // Static
      material: this.groundMaterial
    });

    const vertices = [];
    const indices = [];
    
    const posAttr = geometry.getAttribute("position");
    if (posAttr) {
      for (let i = 0; i < posAttr.count; i++) {
        vertices.push(
          posAttr.getX(i) * scale,
          posAttr.getY(i) * scale,
          posAttr.getZ(i) * scale
        );
      }
    }

    const indexAttr = geometry.getIndex();
    if (indexAttr) {
      for (let i = 0; i < indexAttr.count; i++) {
        indices.push(indexAttr.getX(i));
      }
    }

    if (vertices.length > 0 && indices.length > 0) {
      const shape = new CANNON.Trimesh(vertices, indices);
      body.addShape(shape);
    }

    body.position.set(position.x, position.y, position.z);
    this.world.addBody(body);
    this.staticBodies.push(body);
    
    return body;
  }

  getActorBody(actor) {
    return this.actorBodies.get(actor);
  }

  removeActor(actor) {
    const body = this.actorBodies.get(actor);
    if (body) {
      this.world.removeBody(body);
      this.actorBodies.delete(actor);
    }
  }

  step(deltaTime) {
    const fixedTimeStep = 1 / 60; // 60 FPS physics
    const maxSubSteps = 3;
    
    this.world.step(fixedTimeStep, deltaTime, maxSubSteps);
  }

  syncActorPositions() {
    for (const [actor, body] of this.actorBodies) {
      if (!actor.object3D) continue;

      const followsPhysics =
        actor.isState?.("walking") || actor.isState?.("waiting");

      if (followsPhysics) {
        actor.object3D.position.x = body.position.x;
        actor.object3D.position.z = body.position.z;
        actor.object3D.position.y = body.position.y - (body.characterRadius ?? 0);
      } else {
        body.position.x = actor.object3D.position.x;
        body.position.z = actor.object3D.position.z;
        body.position.y = actor.object3D.position.y + (body.characterRadius ?? 0);
        body.velocity.x = 0;
        body.velocity.z = 0;
      }
    }
  }
}
