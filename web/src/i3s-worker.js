// Off-main-thread helpers for the mesh stream: collision BVHs for fine nodes and simplified
// copies of coarse nodes for the horizon layer.

import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';

function bvh({ position, index }) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setIndex(new BufferAttribute(index, 1));
  const { roots, index: sorted } = MeshBVH.serialize(new MeshBVH(geometry, { maxLeafSize: 8 }), { cloneBuffers: false });
  return [{ roots, index: sorted, position }, [...roots, sorted.buffer, position.buffer]];
}

async function simplify({ position, uv, index, ratio }) {
  await MeshoptSimplifier.ready;
  const source = index instanceof Uint32Array ? index : new Uint32Array(index);
  const target = Math.max(3, Math.floor((source.length * ratio) / 3) * 3);
  // UV-aware, so texture charts do not smear; locked borders keep neighbouring tiles crack-free.
  const [out] = MeshoptSimplifier.simplifyWithAttributes(source, position, 3, uv, 2, [1, 1], null, target, 0.01, ['LockBorder']);
  const [remap, count] = MeshoptSimplifier.compactMesh(out);
  const p = new Float32Array(count * 3), t = new Float32Array(count * 2);
  for (let v = 0; v < remap.length; v++) {
    const r = remap[v];
    if (r === 0xffffffff) continue;
    p[r * 3] = position[v * 3]; p[r * 3 + 1] = position[v * 3 + 1]; p[r * 3 + 2] = position[v * 3 + 2];
    t[r * 2] = uv[v * 2]; t[r * 2 + 1] = uv[v * 2 + 1];
  }
  const i = count < 65536 ? Uint16Array.from(out) : out;
  return [{ position: p, uv: t, index: i }, [p.buffer, t.buffer, i.buffer]];
}

const jobs = { bvh, simplify };

self.onmessage = async ({ data }) => {
  try {
    const [result, transfer] = await jobs[data.type](data);
    self.postMessage({ id: data.id, result }, transfer);
  } catch (err) {
    self.postMessage({ id: data.id, error: String(err?.message || err) });
  }
};
