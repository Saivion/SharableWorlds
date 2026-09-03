"use client";

import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { memo, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { CatalogItem } from "@/lib/catalog";
import { modelScale } from "@/lib/composition/scale3d";
import { renderClock } from "./stageState";

/**
 * One catalog GLB standing on the stage, normalized to the miniature world:
 * uniform kind-canonical scale (lib/composition/scale3d), feet on y=0,
 * footprint centered on x/z — so a piece placed on a lot stands ON that lot,
 * never floats and never buries, whatever units its kit was authored in.
 *
 * Memory: the clone shares geometry, materials and textures with the
 * useGLTF cache (SkeletonUtils.clone copies the object graph only), and
 * React Three Fiber never disposes primitives on unmount — so removing a
 * piece frees its scene-graph nodes and nothing that other pieces of the
 * same model still draw with.
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

const GROW_S = 0.22;

/** Brief settle-in on mount so placements land instead of popping. Runs on
 * wall-clock time (the renderer draws on demand, so frame deltas are not
 * a clock) and asks for frames only while it is still growing. */
function GrowIn({ children }: { children: React.ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  const born = useRef<number | null>(null);
  const done = useRef(false);
  useFrame(() => {
    // Settled pieces must cost nothing — a scene keeps every piece mounted,
    // so a callback that never finishes accumulates one per placement.
    if (done.current || !ref.current) return;
    const now = performance.now();
    if (born.current == null) born.current = now;
    const t = Math.min(1, (now - born.current) / 1000 / GROW_S);
    const e = 1 - Math.pow(1 - t, 3);
    ref.current.scale.setScalar(0.86 + 0.14 * e);
    if (t >= 1) done.current = true;
    else renderClock.animating();
  });
  useLayoutEffect(() => {
    renderClock.animating();
  }, []);
  return <group ref={ref} scale={0.86}>{children}</group>;
}

export type ModelPieceProps = {
  item: CatalogItem;
  position: [number, number, number];
  /** The piece this model stands for — resolved by the stage's click picker
   * through userData; there are no per-piece event handlers. */
  pieceId?: string;
  flip?: boolean;
  /** Quarter-turn yaw in degrees, clockwise; 0 faces the camera-south. */
  rot?: number;
  ghost?: boolean;
  grow?: boolean;
  dim?: boolean;
};

export const ModelPiece = memo(function ModelPiece({ item, position, pieceId, flip, rot, ghost = false, grow = false, dim = false }: ModelPieceProps) {
  const { object, scale, offset } = useNormalizedModel(item, ghost || dim);
  const yaw = -(rot ?? 0) * (Math.PI / 180);
  const userData = useMemo(() => (pieceId ? { pieceId } : {}), [pieceId]);

  // A model arriving (first mount, or its GLB resolving) changes what casts
  // shadows — and, on demand, would otherwise never be drawn until the next
  // interaction.
  useLayoutEffect(() => {
    renderClock.markSceneDirty();
  }, [object]);

  const inner = (
    <group position={offset} scale={scale}>
      <primitive object={object} />
    </group>
  );
  return (
    <group position={position} rotation-y={yaw} scale-x={flip ? -1 : 1} userData={userData}>
      {grow ? <GrowIn>{inner}</GrowIn> : inner}
    </group>
  );
});
