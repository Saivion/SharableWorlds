"use client";

import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, type ComponentProps } from "react";
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { CatalogItem } from "@/lib/catalog";
import { modelScale } from "@/lib/composition/scale3d";

/**
 * One catalog GLB standing on the stage, normalized to the miniature world:
 * uniform kind-canonical scale (lib/composition/scale3d), feet on y=0,
 * footprint centered on x/z — so a piece placed on a lot stands ON that lot,
 * never floats and never buries, whatever units its kit was authored in.
 */

type Normalized = {
  object: THREE.Group;
  scale: number;
  offset: THREE.Vector3;
};

/** Shared look pass for catalog materials — cloned pieces and instanced
 * groups must patch identically or the same model reads differently. */
export function patchPieceMaterial(m: THREE.Material): THREE.Material {
  // DoubleSide keeps mirrored (flip) pieces from rendering inside-out.
  m.side = THREE.DoubleSide;
  if ("envMapIntensity" in m) {
    (m as THREE.MeshStandardMaterial).envMapIntensity = 0.55;
  }
  if ("roughness" in m) {
    const std = m as THREE.MeshStandardMaterial;
    if (typeof std.roughness === "number" && std.roughness > 0.9) std.roughness = 0.72;
  }
  return m;
}

function useNormalizedModel(item: CatalogItem, ghost: boolean): Normalized {
  const gltf = useGLTF(item.model ?? "/assets/kenney/models/missing.glb");
  return useMemo(() => {
    // SkeletonUtils.clone — a plain Object3D.clone leaves SkinnedMeshes bound
    // to the source skeleton, which renders rigged characters as garbage.
    const object = cloneSkeleton(gltf.scene) as THREE.Group;
    object.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = !ghost;
        child.receiveShadow = !ghost;
        const patch = patchPieceMaterial;
        if (ghost) {
          // Ghosts get their own translucent material clones — the source
          // materials are shared across every instance of this model.
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          const cloned = mats.map((m) => {
            const c = patch(m.clone());
            c.transparent = true;
            c.opacity = 0.45;
            c.depthWrite = false;
            return c;
          });
          child.material = Array.isArray(child.material) ? cloned : cloned[0];
        } else {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(patch);
        }
      }
    });
    const { scale } = modelScale(item);
    const box = new THREE.Box3().setFromObject(object);
    const center = box.getCenter(new THREE.Vector3());
    const offset = new THREE.Vector3(-center.x * scale, -box.min.y * scale, -center.z * scale);
    return { object, scale, offset };
  }, [gltf, item, ghost]);
}

/** Brief settle-in on mount so placements land instead of popping. */
function GrowIn({ children }: { children: React.ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  const born = useRef<number | null>(null);
  const done = useRef(false);
  useFrame(({ clock }) => {
    // Settled pieces must cost nothing — a scene keeps every piece mounted,
    // so a callback that never finishes accumulates one per placement.
    if (done.current || !ref.current) return;
    if (born.current == null) born.current = clock.elapsedTime;
    const t = Math.min(1, (clock.elapsedTime - born.current) / 0.22);
    const e = 1 - Math.pow(1 - t, 3);
    const s = 0.6 + 0.4 * e;
    ref.current.scale.setScalar(s);
    if (t >= 1) done.current = true;
  });
  return <group ref={ref} scale={0.6}>{children}</group>;
}

export type ModelPieceProps = {
  item: CatalogItem;
  position: [number, number, number];
  flip?: boolean;
  /** Quarter-turn yaw in degrees, clockwise; 0 faces the camera-south. */
  rot?: number;
  ghost?: boolean;
  grow?: boolean;
  dim?: boolean;
} & Pick<ComponentProps<"group">, "onPointerDown" | "onPointerOver" | "onPointerOut">;

export function ModelPiece({ item, position, flip, rot, ghost = false, grow = false, dim = false, ...handlers }: ModelPieceProps) {
  const { object, scale, offset } = useNormalizedModel(item, ghost || dim);
  const yaw = -(rot ?? 0) * (Math.PI / 180);
  const inner = (
    <group position={offset} scale={scale}>
      <primitive object={object} />
    </group>
  );
  return (
    <group
      position={position}
      rotation-y={yaw}
      scale-x={flip ? -1 : 1}
      {...handlers}
    >
      {grow ? <GrowIn>{inner}</GrowIn> : inner}
    </group>
  );
}
