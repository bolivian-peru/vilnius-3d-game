import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const UPSTREAM = 'https://opencity.idvilnius.lt/server/rest/services/3D/Vilnius_mesh_2022/SceneServer/layers/0';
const CACHE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/raw/i3s/Vilnius_mesh_2022');
const ROUTES = [
  [/^\/?$/, () => ['layer.json', 'application/json']],
  [/^\/nodepages\/(\d+)$/, (m) => [`nodepages/${m[1]}.json`, 'application/json']],
  [/^\/nodes\/(\d+)\/geometries\/1$/, (m) => [`nodes/${m[1]}/geometry.drc`, 'application/octet-stream']],
  [/^\/nodes\/(\d+)\/textures\/0$/, (m) => [`nodes/${m[1]}/texture.jpg`, 'image/jpeg']],
];
const UPSTREAM_LIMIT = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The municipal service answers about ten requests a second. This serves mesh parts from a local
// disk cache (shared with the Python pipeline, git-ignored) and only asks upstream for what is new,
// so places you have visited or pre-warmed open at disk speed. Local evaluation only.
// The page spreads requests over s0..s3.localhost (same server) to get past the browser's six
// connections per host; upstream stays limited to UPSTREAM_LIMIT at a time, newest request first
// (that is where the player is now), and requests whose browser tab gave up are dropped.
// Requests marked `?lo` (the distant horizon) only go upstream when nothing else waits, and never
// take the last LOW_RESERVE slots.
const LOW_RESERVE = 2;
function meshCache() {
  const pending = new Map();
  let active = 0;
  const high = [], low = [];
  const pump = () => {
    while (active < UPSTREAM_LIMIT) {
      const job = high.pop() || (active < UPSTREAM_LIMIT - LOW_RESERVE ? low.shift() : null);
      if (!job) return;
      active++;
      job.queued = null;
      job.start();
    }
  };
  const acquire = (job) => new Promise((r) => { job.start = r; job.queued = job.lo ? low : high; job.queued.push(job); pump(); });
  const release = () => { active--; pump(); };

  const fetchOnce = (rel, url, res, lo) => {
    let job = pending.get(rel);
    if (job && !lo && job.queued === low) {
      // Now wanted up close: move it to the front queue.
      low.splice(low.indexOf(job), 1);
      job.lo = false;
      job.queued = high;
      high.push(job);
      pump();
    }
    if (!job) {
      job = { clients: new Set(), lo };
      job.promise = (async () => {
        await acquire(job);
        try {
          if (!job.clients.size) throw new Error('gone');
          for (let attempt = 0; ; attempt++) {
            const r = await fetch(url, { headers: { 'User-Agent': 'vilnius-3d-game-web/0.1 (local evaluation)' }, signal: AbortSignal.timeout(30000) });
            if (r.ok) {
              const body = Buffer.from(await r.arrayBuffer());
              const file = path.join(CACHE, rel);
              await mkdir(path.dirname(file), { recursive: true });
              await writeFile(file, body);
              return body;
            }
            if (attempt >= 2 || (r.status !== 429 && r.status < 500)) throw new Error(`upstream ${r.status}`);
            await sleep(attempt ? 3000 : 1000);
          }
        } finally {
          release();
        }
      })().finally(() => pending.delete(rel));
      pending.set(rel, job);
    }
    job.clients.add(res);
    res.on('close', () => job.clients.delete(res));
    return job.promise;
  };
  const handler = async (req, res, next) => {
    const [url, query] = (req.url || '').split('?');
    for (const [pattern, target] of ROUTES) {
      const m = url.match(pattern);
      if (!m) continue;
      const [rel, type] = target(m);
      try {
        const body = await readFile(path.join(CACHE, rel)).catch(() => fetchOnce(rel, UPSTREAM + url.replace(/\/$/, ''), res, query === 'lo'));
        if (res.destroyed) return;
        // The mesh is a fixed 2022 survey: let the browser keep every part for good.
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length,
          'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*' });
        res.end(body);
      } catch (err) {
        if (res.destroyed) return;
        res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end(String(err.message));
      }
      return;
    }
    next();
  };
  return {
    name: 'vilnius-mesh-cache',
    configureServer(server) { server.middlewares.use('/i3s', handler); },
    configurePreviewServer(server) { server.middlewares.use('/i3s', handler); },
  };
}

// Procedural trees come from ez-tree's sources (MIT): its bundle inlines every bark and leaf texture,
// so trees.js imports the generator directly and loads only the textures it uses itself.
const EZ_TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'node_modules/@dgreenheck/ez-tree/src/lib');
function ezTree() {
  return {
    name: 'ez-tree-src',
    enforce: 'pre',
    resolveId(id, importer) {
      if (id === 'ez-tree') return path.join(EZ_TREE, 'index.js');
      if (id.startsWith('ez-tree/')) return path.join(EZ_TREE, id.slice(8));
      if (id === './textures' && importer?.startsWith(EZ_TREE)) return '\0ez-tree-textures';
    },
    load(id) { if (id === '\0ez-tree-textures') return 'export const getBarkTexture = () => null, getLeafTexture = () => null;'; },
  };
}

export default defineConfig({ plugins: [meshCache(), ezTree()], optimizeDeps: { exclude: ['ez-tree'] },
  server: { watch: { ignored: ['**/public/citytiles/**'] } } });
