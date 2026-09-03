"use client";

import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { memo, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { CatalogItem } from "@/lib/catalog";
import { modelScale } from "@/lib/composition/scale3d";
import { DROP, SNAP, easeOut, legoPop, pieceWaveSnap } from "./legoDrop";
import { ModelPiece, patchPieceMaterial } from "./ModelPiece";
import { countRender, perfCounters, renderClock } from "./stageState";

/**
 * Repeated catalog models rendered as instances — the "40 pines = 40 scene
 * graphs" fix. Pieces sharing a catalog id collapse into one InstancedMesh
 * per sub-mesh of the GLB: shared geometry, shared material, one draw call
 * per sub-mesh instead of one per piece (and the same again in the shadow
 * pass). The logical world doesn't change — lots, occupancy, selection, and
 * the WebMCP tools see identical pieces; only materialization differs.
 *
 * The stage hands each group a STABLE `entries` array (only groups whose
 * members changed get a new one), and this component is memoized on it —
 * so a placement rewrites exactly one group's instance buffer.
 *
 * Rigged models (SkinnedMesh anywhere in the GLB) can't instance — those
 * groups fall back to per-piece ModelPiece clones automatically.
 */

/** Never flipped: a mirrored instance matrix (negative determinant) inverts
 * instanced normals — three.js doesn't inverse-transpose per instance — and
 * the model lights black. Flipped pieces render through ModelPiece instead. */
export type InstancedEntry = {
  id: string;
  col: number;
  row: number;
  x: number;
  y: number;
  z: number;
  rot: number;
};

type Part = {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  /** Sub-mesh transform relative to the GLB root. */
  local: THREE.Matrix4;
};

type Arrival =
  | { mode: "wave"; born: number; delay: number; done: boolean }
  | { mode: "grow"; born: number; done: boolean };

const GROW_S = 0.22;

function useModelParts(item: CatalogItem) {
  const gltf = useGLTF(item.model ?? "/assets/kenney/models/missing.glb");
  return useMemo(() => {
    const parts: Part[] = [];
    let skinned = false;
    gltf.scene.updateMatrixWorld(true);
    const rootInv = new THREE.Matrix4().copy(gltf.scene.matrixWorld).invert();
    gltf.scene.traverse((child) => {
      if ((child as THREE.SkinnedMesh).isSkinnedMesh) {
        skinned = true;
        return;
      }
      if (child instanceof THREE.Mesh) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(patchPieceMaterial);
        parts.push({
          geometry: child.geometry,
          material: child.material,
          local: new THREE.Matrix4().multiplyMatrices(rootInv, child.matrixWorld),
        });
      }
    });
    // Same normalization as ModelPiece: kind-canonical scale, feet on y=0,
    // footprint centered — one source of truth via modelScale + bounds.
    const { scale } = modelScale(item);
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const center = box.getCenter(new THREE.Vector3());
    const norm = new THREE.Matrix4()
      .makeTranslation(-center.x * scale, -box.min.y * scale, -center.z * scale)
      .multiply(new THREE.Matrix4().makeScale(scale, scale, scale));
    return { parts, skinned, norm };
  }, [gltf, item]);
}

/** Capacity in steps so per-piece adds don't reallocate GPU buffers. */
function capacityFor(n: number) {
  return Math.max(16, Math.ceil(n / 16) * 16);
}

export const InstancedPieces = memo(function InstancedPieces({ item, entries }: { item: CatalogItem; entries: InstancedEntry[] }) {
  countRender("instancedGroupRenders");
  const { parts, skinned, norm } = useModelParts(item);
  const meshRefs = useRef<(THREE.InstancedMesh | null)[]>([]);
  const arrivals = useRef(new Map<string, Arrival>());
  const allSettled = useRef(false);
  const scratch = useRef({
    m: new THREE.Matrix4(),
    full: new THREE.Matrix4(),
    outer: new THREE.Matrix4(),
    pos: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    scl: new THREE.Vector3(),
    up: new THREE.Vector3(0, 1, 0),
  });

  const capacity = capacityFor(entries.length);
  const pieceIds = useMemo(() => entries.map((e) => e.id), [entries]);

  // Track arrivals: new pieces either ride the foundation wave (compose) or
  // grow in place (agent hop, human click) — same contract as PieceArrive.
  useLayoutEffect(() => {
    const seen = new Set<string>();
    for (const e of entries) {
      seen.add(e.id);
      if (arrivals.current.has(e.id)) continue;
      const snap = pieceWaveSnap(e.col, e.row);
      arrivals.current.set(
        e.id,
        snap
          ? { mode: "wave", born: snap.bornAt, delay: snap.delay, done: false }
          : { mode: "grow", born: performance.now(), done: false },
      );
      allSettled.current = false;
    }
    for (const id of arrivals.current.keys()) {
      if (!seen.has(id)) arrivals.current.delete(id);
    }
  }, [entries]);

  const writeAll = (now: number) => {
    const s = scratch.current;
    let settled = true;
    if (process.env.NODE_ENV !== "production") perfCounters.instancedWrites += 1;
    for (let i = 0; i < entries.length; i += 1) {
      const e = entries[i];
      const a = arrivals.current.get(e.id);
      let dy = 0;
      let pop = 1;
      let visible = true;
      if (a && !a.done) {
        if (a.mode === "wave") {
          const t = (now - a.born) / 1000 - a.delay;
          // Whatever happened to the frame loop meanwhile (a hidden tab, a
          // remount), a drop that is seconds overdue is simply landed.
          if (t > SNAP + 3) a.done = true;
          else if (t < 0) {
            visible = false;
          } else if (t >= SNAP) {
            a.done = true;
          } else {
            dy = DROP * (1 - easeOut(t / SNAP));
            pop = legoPop(t);
          }
        } else {
          const t = (now - a.born) / 1000;
          if (t >= GROW_S) {
            a.done = true;
          } else {
            pop = 0.86 + 0.14 * easeOut(t / GROW_S);
          }
        }
        if (!a.done) settled = false;
      }
      s.pos.set(e.x, e.y + dy, e.z);
      s.quat.setFromAxisAngle(s.up, -(e.rot ?? 0) * (Math.PI / 180));
      const k = visible ? pop : 0.0001;
      s.scl.set(k, k, k);
      s.outer.compose(s.pos, s.quat, s.scl);
      // piece transform × normalization, then each part's own local inside.
      s.m.multiplyMatrices(s.outer, norm);
      for (let p = 0; p < parts.length; p += 1) {
        const mesh = meshRefs.current[p];
        if (!mesh) continue;
        s.full.multiplyMatrices(s.m, parts[p].local);
        mesh.setMatrixAt(i, s.full);
      }
    }
    for (const mesh of meshRefs.current) {
      if (!mesh) continue;
      mesh.count = entries.length;
      mesh.instanceMatrix.needsUpdate = true;
      // A fresh bounding sphere is what lets the group be frustum-culled as
      // one object when the view leaves it entirely.
      mesh.computeBoundingSphere();
      mesh.userData.pieceIds = pieceIds;
    }
    return settled;
  };

  // Initial + membership-change write (covers moves too — x/z changed).
  useLayoutEffect(() => {
    if (skinned || parts.length === 0) return;
    allSettled.current = writeAll(performance.now());
    // New instances cast new shadows; unsettled ones need frames.
    renderClock.animating();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, parts, norm, capacity, skinned]);

  useFrame(() => {
    if (skinned || parts.length === 0 || allSettled.current) return;
    allSettled.current = writeAll(performance.now());
    if (!allSettled.current) renderClock.animating();
  });

  // Free per-mesh instance buffers on unmount; the geometry/material stay in
  // the shared useGLTF cache and must never be disposed here (dispose={null}).
  useLayoutEffect(() => {
    const meshes = meshRefs.current;
    return () => {
      for (const mesh of meshes) mesh?.dispose();
    };
  }, [capacity, parts]);

  if (parts.length === 0) return null;

  if (skinned) {
    // Rigged models can't share a skeleton across instances — clone per piece.
    return (
      <>
        {entries.map((e) => (
          <ModelPiece key={e.id} pieceId={e.id} item={item} position={[e.x, e.y, e.z]} rot={e.rot} />
        ))}
      </>
    );
  }

  return (
    <>
      {parts.map((part, p) => (
        <instancedMesh
          // Reallocation only when capacity steps up, not per placement.
          key={`${p}-${capacity}`}
          ref={(m) => {
            meshRefs.current[p] = m;
          }}
          args={[part.geometry, part.material as THREE.Material, capacity]}
          castShadow
          receiveShadow
          dispose={null}
        />
      ))}
    </>
  );
});
