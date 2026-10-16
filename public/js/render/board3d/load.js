// render/board3d/load.js — loading of three.js and the official board art (local-client extraction, DESIGN §13/§15).
//
//   const THREE = await loadThree()            // '/vendor/three.module.js' (tools/vendor.mjs), null when missing
//   const pack = await loadBoardPack(assets)   // null when the board art is not installed (→ 2D board)
//   → { key, images: { D, N?, R?, E?, common?, commonE?, BG?, wind?, gate?, waterN?, caustics?, noise? },
//       meshes: { crate?, blower?, bgPlane?, gate: { startDown?, startUp?, startBack?, endDown?, endUp? } },
//       tiles, uv, materials: { theme?, fx? } }
//   const scene = await loadScenePack(assets, stageId)   // the stage's official scene (tools/local-extract/scenes.py),
//   → { key, stage, doc, chunks: [{ material, lightmap, group, bounds, position, uv, uv1, normal, color, index }],
//       groups: { name: [x0, y0, x1, y1] }, images: { tex: { name: img }, lm: [img|null] } }     null when not extracted
//
// Everything is optional except the diffuse atlas: a missing map or mesh only drops that feature (e.g. no normal
// map → flat shading of the atlas; no crate mesh → a procedural box). URLs come from data/local-assets.json only
// (assets.localUrl) — nothing is guessed. Results are cached per page.

import { resolveUvTable } from './atlas.js';
import { parseObj } from './obj.js';
import { runtimeURL } from '../../runtime.js';

export const THREE_URL = '/vendor/three.module.js';

let threePromise = null;
let threeFailures = 0;
/** Dynamic import of the vendored three.js ESM build (browser only); null when unavailable. */
export function loadThree(url = THREE_URL) {
  if (!threePromise) {
    // Browsers also cache failed module imports. Two bounded retry URLs permit a transient download failure to
    // recover; clearing only our promise would keep receiving that same cached rejection without another request.
    if (threeFailures >= 3) return Promise.resolve(null);
    // Retry query strings bypass exact import-map keys; pin the page's content version first.
    const source = new URL(runtimeURL(url), import.meta.url);
    if (threeFailures) source.searchParams.set('sp-retry', String(threeFailures));
    const pending = import(/* @vite-ignore */ source.href).then((m) => (m && m.WebGLRenderer ? m : null), () => null).then((m) => {
      if (!m && threePromise === pending) { threePromise = null; threeFailures++; }
      return m;
    });
    threePromise = pending;
  }
  return threePromise;
}

/**
 * Can this browser run the 3D board? (WebGL2 — three r163+ requires it.) Software / blocklisted GPUs ("major
 * performance caveat") count as unavailable unless `allowSlow` (an explicit `?board=3d`).
 */
export function webgl2Available(allowSlow = false) {
  try {
    if (typeof document === 'undefined') return false;
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2', allowSlow ? {} : { failIfMajorPerformanceCaveat: true });
    if (!gl) return false;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return true;
  } catch { return false; }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

let deviceClassCache = null;

/**
 * What this browser can actually render with — the once-per-page device class behind the 3D board's gate.
 *
 * `software`: WebGL2 exists only WITH the "major performance caveat" (SwiftShader / llvmpipe / a blocklisted GPU).
 * Such a renderer still answers `webgl2Available(true)`, which is why the forced `?board=3d` switched the 3D board on
 * for it — a native-resolution, shadowed, antialiased three.js scene the CPU has to rasterise, the load that left
 * weak machines on a black screen with a dead cursor (field report, 2026-10). The probe is one throwaway canvas +
 * context per page (≈ one draw) and its result is cached: `software` cannot change, and the gate asks on every view.
 *
 * `getContext` is called as a method of its own canvas (a bare call throws Illegal invocation in Chrome).
 *
 * @returns {{ software: boolean, lazy: boolean }} `lazy` = no WebGL2 at all (also the answer in Node, with no document)
 */
export function board3dDeviceClass() {
  const lazy = { software: false, lazy: true };
  if (deviceClassCache) return deviceClassCache;
  try {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return (deviceClassCache = lazy);
    const c = document.createElement('canvas');
    const get = c.getContext;
    if (typeof get !== 'function') return (deviceClassCache = lazy);
    const ctx = (opts) => get.call(c, 'webgl2', opts);
    const fast = !!ctx({ failIfMajorPerformanceCaveat: true });
    const any = fast || !!ctx({});
    if (any) { const lose = any.getExtension?.('WEBGL_lose_context'); if (lose) lose.loseContext(); }
    return (deviceClassCache = { software: !fast && any, lazy: !any });
  } catch { return (deviceClassCache = lazy); }
}

/** Forget the cached device class (tests; on a real page it is a property of the page, not of the view). */
export function resetBoard3dDeviceClass() { deviceClassCache = null; }

/** `?board=` of a URL search string — null when absent or unparsable (`render/app/view.js boardPreferenceFromURL`). */
export function boardPreferenceFromURL(search) {
  try { return new URLSearchParams(search || '').get('board'); } catch { return null; }
}

/**
 * The 3D board's gate: is the 3D board wanted, and what (if anything) must the player be told about it?
 *
 * Precedence, highest first — the order the settings and the URL have always had:
 *   1. `pref` (`?board=3d|2d`, then the remembered choice, then the view option; `app/view.js boardPreference`) —
 *      `2d` wins over everything: that is the emergency switch, and it is also the sticky remote kill switch;
 *   2. no WebGL2 at all — always 2D, silently (three r163+ needs WebGL2; nothing was ever possible);
 *   3. WebGL2 as the FAST renderer asks for it (`gl2fast` = `webgl2Available(false)`, i.e. failIfMajorPerformanceCaveat)
 *      — false ⇒ software / blocklisted ⇒ 2D, whatever 画质 says, and the player is told (that is the fix);
 *   4. 性能模式 (`perf`) — on ⇒ 2D, silently (the player turned it on);
 *   5. `pref === '3d'`: the explicit override ("I know my machine" / dev). It wins over 3 and 4 because the slow path
 *      was asked for on purpose, but a software renderer still gets a `forced-software` warning, so the player is told
 *      what the override costs on this machine instead of meeting the black screen unexplained.
 *
 * The rule this adds is 5's caveat, not its refusal: a software renderer can no longer reach the 3D board by accident
 * (no `?board=3d`), while the override stays available to whoever asks for it.
 *
 * @param {'2d'|'3d'|'auto'} pref
 * @param {{ gl2?: boolean, gl2fast?: boolean, perf?: boolean, remote?: boolean }|null} [probe] defaults to the live
 *   `board3dDeviceClass()` (which answers both `gl2` and `gl2fast` in one probe)
 * @returns {{ want: boolean, pref: '2d'|'3d'|'auto', software: boolean, reason: '2d'|'nogl2'|'perf'|'software'|'forced-software'|'ok', notice: 'software'|'forced-software'|'remote-2d'|null }}
 */
export function board3dGate(pref = 'auto', probe = null) {
  const cls = board3dDeviceClass();
  const software = probe ? probe.gl2fast === false : cls.software;
  const gl2 = probe ? probe.gl2 !== false : !cls.lazy;
  const perf = probe ? probe.perf === true : false;
  if (pref === '2d') {
    // A `?board=2d` the URL itself carried is a deliberate act: say so once, so the 2D board does not read as a regression.
    return { want: false, pref, software, reason: '2d', notice: probe?.remote ? 'remote-2d' : null };
  }
  if (!gl2) return { want: false, pref, software, reason: 'nogl2', notice: null };
  if (pref === '3d') {
    return software
      ? { want: true, pref, software, reason: 'forced-software', notice: 'forced-software' }
      : { want: true, pref, software, reason: 'ok', notice: null };
  }
  if (software) return { want: false, pref, software, reason: 'software', notice: 'software' };
  if (perf) return { want: false, pref, software, reason: 'perf', notice: null };
  return { want: true, pref, software, reason: 'ok', notice: null };
}

/**
 * Why the 3D board is or is not used, readable at runtime (dev / field diagnosis).
 *
 * `render/app.js` decides with the gate above (`board3dGate(boardPreference(opts.board))`) and `boardArtListed`, and
 * when the answer is "2D" there is otherwise nothing to read: `stats().board3d` only says `{ on: false }` without
 * saying which input said no. The booleans here are that whole decision, computed on demand (never at boot).
 *
 *   await __SP_BOARD3D_PROBE__() → {
 *     gl2:      WebGL2 ignoring the "major performance caveat" flag (a software renderer still reports true here),
 *     gl2fast:  WebGL2 as the DEFAULT `auto` mode asks for it (software / blocklisted ⇒ false → 2D),
 *     software: gl2fast is false — the device class that disables 3D, and that is warned when `?board=3d` overrides it,
 *     stored:   the remembered `?board=` choice (the sticky remote kill switch), or null,
 *     listed:   the local-art manifest lists map/autochess/TX_autochessi_D (i.e. the board art is installed),
 *     url:      the URL that listing resolves to (null when not installed),
 *     gate:     `board3dGate(pref)` of the current page URL — the very object render/app.js acts on,
 *   }
 *
 * In a browser console on the running game: `await __SP_BOARD3D_PROBE__()`.
 */
export async function board3dProbe(assets) {
  let listed = false, url = null;
  try {
    listed = await boardArtListed(assets);
    url = assets && typeof assets.localUrl === 'function' ? assets.localUrl(...PACK_IMAGES.D) : null;
  } catch { /* reported as not listed */ }
  let stored = null;
  try { stored = globalThis.localStorage?.getItem('sp.pref.board') || null; } catch { /* no storage */ }
  const raw = boardPreferenceFromURL(globalThis.location?.search);
  const pref = raw === '2d' || raw === '3d' ? raw : (stored === '2d' || stored === '3d' ? stored : 'auto');
  return {
    gl2: webgl2Available(true), gl2fast: webgl2Available(false), software: board3dDeviceClass().software,
    stored, listed, url, game: board3dGate(pref, { gl2fast: !board3dDeviceClass().software, perf: false, remote: raw === '2d' }),
  };
}
if (typeof globalThis !== 'undefined') globalThis.__SP_BOARD3D_PROBE__ = board3dProbe;

/** Manifest key → pack slot. */
export const PACK_IMAGES = Object.freeze({
  D: ['map/autochess', 'TX_autochessi_D'],
  N: ['map/autochess', 'TX_autochessi_N_rgb'],
  R: ['map/autochess', 'TX_autochessi_M_rough'],
  E: ['map/autochess', 'TX_autochessi_E'],
  common: ['map/autochess', 'TX_autochessi_common_D'],
  commonE: ['map/autochess', 'TX_autochessi_common_E'],
  BG: ['map/autochess', 'TX_autochessi_BG'],
  wind: ['map/common', 'TX_wind_device'],
  gate: ['map/fx', '[opt]merged_textures'],
  waterN: ['map/water', '[ucp]TX_water_normal'],
  caustics: ['map/water', 'TX_Caustics256'],
  noise: ['map/water', 'T_noise_clouds_01'],
  platform: ['mesh/trap_110', 'TX_trap_1106_achplat'],
});

export const PACK_MESHES = Object.freeze({
  crate: ['mesh/s_common_box_01', 'pCube2'],
  blower: ['mesh/s_wind_device', 'S_wild_wind_device'],
  bgPlane: ['mesh/s_background_common', 'pPlane1'],
  platform: ['mesh/trap_110', 'trap_1106_achplat'],
});

/** The official gate / objective boxes: prefab node → pack slot (meshes resolved through map/fx/prefab.json). */
export const GATE_NODES = Object.freeze({
  startDown: 'Start_down', startUp: 'Start_up', startBack: 'Start_back', endDown: 'Start_down1', endUp: 'Start_up1',
});

/** The world group every board used before themes existed (upstream's own board). */
export const DEFAULT_BOARD_GROUP = 'map/autochess';

/**
 * The board's world textures for one theme group, resolved from that group's own `materials.json`.
 *
 * A THEME group carries the recoloured set of a scenario — 沙地 (`map/autochesssand`: 沙尘暴/土石结构) is the one the
 * local-client dump ships — and its files are named differently from the default's (`TX_AutochessSand_A/N/M` vs
 * `TX_autochessi_D/N_rgb/M_rough`). Reading the names out of `materials.json` is what lets a theme work without a second
 * hardcoded table. The slots are the same in both dumps: `_MainTex` = albedo, `_BumpMap` = normal, `_MetallicGlossMap`
 * = roughness/metallic, `_EmissionMap` = emission (沙地 has none).
 *
 * NOTE the dump is NOT a literal substitute for the default's names, which is why `fallback` exists: `map/autochess`
 * lists `_BumpMap → TX_autochessi_N` and `_MetallicGlossMap → TX_autochessi_M`, while the renderer deliberately loads
 * the packed `TX_autochessi_N_rgb` / `TX_autochessi_M_rough` instead. Trusting materials.json alone would have silently
 * swapped the default board's normal and roughness maps (caught by comparing the two, 2026-10-08).
 *
 * @param {any} themeMats parsed `<group>/materials.json`
 * @param {{ D?: string, N?: string, M?: string, E?: string }} [fallback] names to keep when the dump disagrees
 * @returns {{ D: string, N?: string, M?: string, E?: string }|null} manifest entry names (not URLs), or null
 */
export function worldSlots(themeMats, fallback = null) {
  if (!isObj(themeMats)) return null;
  // the world prefab is the first entry (the dump orders the ground material before its grass/sand/water sub-materials)
  const first = Object.values(themeMats)[0];
  const tex = first && isObj(first.textures) ? first.textures : null;
  if (!tex) return null;
  const out = {};
  for (const [slot, key] of [['_MainTex', 'D'], ['_BumpMap', 'N'], ['_MetallicGlossMap', 'M'], ['_EmissionMap', 'E']]) {
    const t = tex[slot];
    const n = t && typeof t.texture === 'string' ? t.texture : '';
    const name = (fallback && fallback[key]) || n;
    if (name) out[key] = name;
  }
  return out.D ? out : null;
}

/**
 * Every image slot of a board pack: the theme's world textures plus the scene-wide ones that live outside its group
 * (wind device, gate fx, water, background plane).
 *
 * The world group's own fixed names are the FALLBACK when the group's `materials.json` is missing or silent about a
 * slot, so a theme without a dump degrades to the default art instead of losing the board.
 * @param {any} themeMats
 * @param {string} [group]
 * @returns {Record<string, [string, string]>}
 */
export function groupImages(themeMats, group = DEFAULT_BOARD_GROUP) {
  const fixed = { D: PACK_IMAGES.D[1], N: PACK_IMAGES.N[1], M: PACK_IMAGES.R[1], E: PACK_IMAGES.E[1] };
  // the fixed names are the DEFAULT BOARD's own files — a different theme must use its own dump's names instead
  const slots = worldSlots(themeMats, group === DEFAULT_BOARD_GROUP ? fixed : null) || fixed;
  const out = {};
  for (const [k, n] of Object.entries(slots)) out[k] = [group, n];
  for (const [k, v] of Object.entries(PACK_IMAGES)) if (!(k in out)) out[k] = v;
  return out;
}

let cached = null;

/**
 * Does the local-art manifest list the board atlas? Reads the manifest only (no images): decides whether the
 * ~2 MB three.js build is worth downloading at all (most hosts have no local-client art → 2D board, no three).
 */
export async function boardArtListed(assets) {
  if (!assets || typeof assets.local !== 'function' || typeof assets.localUrl !== 'function') return false;
  try { await assets.local(); } catch { return false; }
  const u = assets.localUrl(...PACK_IMAGES.D);
  return typeof u === 'string' && u.length > 0;
}

async function fetchText(url) {
  try { const r = await fetch(url, { cache: 'no-cache' }); return r.ok ? await r.text() : null; } catch { return null; }
}
async function fetchJson(url) {
  try { const r = await fetch(url, { cache: 'no-cache' }); return r.ok ? await r.json() : null; } catch { return null; }
}

/**
 * Load the board pack through the asset store of public/js/assets.js (needs local(), localUrl(), image()).
 * @returns {Promise<object|null>}
 */
export function loadBoardPack(assets, themeGroup = DEFAULT_BOARD_GROUP) {
  if (cached) return cached;
  const group = typeof themeGroup === 'string' && themeGroup ? themeGroup : DEFAULT_BOARD_GROUP;
  const pending = (async () => {
    if (!assets || typeof assets.local !== 'function' || typeof assets.localUrl !== 'function' || typeof assets.image !== 'function') return null;
    const manifest = await assets.local().catch(() => null);
    if (!isObj(manifest)) return null;
    const url = (g, n) => { const u = assets.localUrl(g, n); return typeof u === 'string' && u ? encodeURI(u) : null; };
    // the theme's materials FIRST: they name this world's own texture files and give the fx materials at the end
    const themeMats = await (async () => { const u = url(group, 'materials'); return u ? fetchJson(u) : null; })();
    const images$ = groupImages(themeMats, group);
    const dUrl = url(...(images$.D || PACK_IMAGES.D));
    if (!dUrl) return null;
    const images = {};
    await Promise.all(Object.entries(images$).map(async ([k, [g, n]]) => {
      const u = url(g, n);
      if (!u) return;
      const img = await assets.image(u, { retry: true }).catch(() => null);
      if (img && (img.width || img.naturalWidth) > 0) images[k] = img;
    }));
    if (!images.D) return null;
    const dir = dUrl.replace(/\/[^/]*$/, '');
    // `tiles.json` is the DEFAULT board atlas's surface/UV table (tools/crop-board-atlas.mjs), not a world texture: a
    // recolour like 沙地 ships no such file, so it must come from the default world instead of being fetched next to the
    // theme's albedo (which 404s and runs the page's error handlers for a file that simply lives elsewhere). The local
    // manifest does not index it, so its directory is derived from the default group's own albedo.
    const tilesUrl = (() => {
      const own = url(group, 'tiles');
      if (own) return own;
      const def = url(DEFAULT_BOARD_GROUP, 'tiles');
      if (def) return def;
      const defD = url(...PACK_IMAGES.D);
      return defD ? `${defD.replace(/\/[^/]*$/, '')}/tiles.json` : `${dir}/tiles.json`;
    })();
    const [tiles, theme, fxMats, fxPrefab, trapMats] = await Promise.all([
      fetchJson(tilesUrl),
      (async () => { const u = url('map/autochess', 'materials'); return u ? fetchJson(u) : null; })(),
      (async () => { const u = url('map/fx', 'materials'); return u ? fetchJson(u) : null; })(),
      (async () => { const u = url('map/fx', 'prefab'); return u ? fetchJson(u) : null; })(),
      (async () => { const u = url('mesh/trap_110', 'materials'); return u ? fetchJson(u) : null; })(),
    ]);
    const meshes = { gate: {} };
    await Promise.all(Object.entries(PACK_MESHES).map(async ([k, [g, n]]) => {
      const u = url(g, n);
      const text = u ? await fetchText(u) : null;
      const m = text ? parseObj(text) : null;
      if (m) meshes[k] = m;
    }));
    const prefab = Array.isArray(fxPrefab) ? fxPrefab : [];
    await Promise.all(Object.entries(GATE_NODES).map(async ([slot, node]) => {
      const rec = prefab.find((p) => p && p.name === node && (node !== 'Start_back' || p.parent === '[opt]start_box'));
      const key = rec && typeof rec.mesh === 'string' ? rec.mesh : node;
      const u = url('map/fx', key);
      const text = u ? await fetchText(u) : null;
      const m = text ? parseObj(text) : null;
      if (m) meshes.gate[slot] = { mesh: m, material: rec && Array.isArray(rec.materials) ? rec.materials[0] || null : null };
    }));
    return {
      key: `${dUrl}#${tiles?.version || 0}`,
      group,
      images, meshes, tiles: isObj(tiles) ? tiles : null, uv: resolveUvTable(isObj(tiles) ? tiles : null),
      materials: { theme: isObj(themeMats) ? themeMats : (isObj(theme) ? theme : null), fx: isObj(fxMats) ? fxMats : null, trap: isObj(trapMats) ? trapMats : null },
    };
  })().catch((err) => { console.warn('[board3d] art load failed', err); return null; }).then((pack) => {
    // A timeout / failed atlas is not proof the host lacks 3D art. A later mount or visibility change may retry.
    // An older attempt finishing after reset must not discard a newer cached request.
    if (!pack && cached === pending) cached = null;
    return pack;
  });
  cached = pending;
  return pending;
}

/** Manifest group of a stage's official scene, and of the textures the scenes share. */
export const sceneGroup = (stageId) => `scene/${stageId}`;
export const SCENE_TEX_GROUP = 'scene/tex';
export const SCENE_VERSION = 1;
/** Bytes per vertex of a scene chunk: position f32×3, uv f32×2, lightmap uv f32×2, normal i8×4, colour u8×4. */
export const SCENE_VERTEX_BYTES = 36;

/**
 * Typed-array views of the chunks of a scene.bin (scenes.py pack_chunk); null when a record does not fit the buffer.
 * @param {object} doc scene.json
 * @param {ArrayBuffer} buf scene.bin
 */
export function parseSceneChunks(doc, buf) {
  if (!isObj(doc) || !Array.isArray(doc.chunks) || !(buf instanceof ArrayBuffer)) return null;
  const out = [];
  for (const c of doc.chunks) {
    const n = c?.verts | 0, m = (c?.tris | 0) * 3, o = c?.offset | 0;
    const end = o + n * SCENE_VERTEX_BYTES + m * (c.index32 ? 4 : 2);
    if (!(n > 0) || !(m > 0) || o < 0 || o % 4 || end > buf.byteLength || typeof c.material !== 'string') return null;
    let p = o;
    const position = new Float32Array(buf, p, n * 3); p += n * 12;
    const uv = new Float32Array(buf, p, n * 2); p += n * 8;
    const uv1 = new Float32Array(buf, p, n * 2); p += n * 8;
    const normal = new Int8Array(buf, p, n * 4); p += n * 4;
    const color = new Uint8Array(buf, p, n * 4); p += n * 4;
    const index = c.index32 ? new Uint32Array(buf, p, m) : new Uint16Array(buf, p, m);
    out.push({
      material: c.material, lightmap: Number.isInteger(c.lightmap) ? c.lightmap : -1, group: typeof c.group === 'string' ? c.group : '',
      bounds: Array.isArray(c.bounds) ? c.bounds : null, position, uv, uv1, normal, color, index,
    });
  }
  return out;
}

/**
 * Mesh bucket of a scene chunk. One material and one lightmap page are one draw. Water ignores the page: that shader
 * has no lightmap (`scene.js` `sceneWaterMaterial`).
 * @param {{ material?: string, lightmap?: number }} chunk
 * @param {{ kind?: string }|null} info scene.json materials[name]
 */
export function sceneMaterialKey(chunk, info) {
  return `${chunk?.material}|${info?.kind === 'water' || isSceneWater(info, chunk?.material) ? '' : chunk?.lightmap}`;
}

/** Surface water, not the DynamicWaterTile platform decal (both were extracted as kind: water). */
export function isSceneWater(info, name = '') {
  if (!isObj(info)) return false;
  const shader = typeof info.shader === 'string' ? info.shader : '';
  if (shader.endsWith('/DynamicWaterTile')) return false;
  return shader.endsWith('/StylizedWater') || /_water\d*$/i.test(name);
}

/**
 * Pick this map's water record by shader, then by name, never by a theme-specific name. An explicit surface pick
 * wins. [ASSUMED] With several surfaces the board takes the first StylizedWater; each scene mesh keeps its own
 * record (including water2). No surface record → null, so the caller restores the procedural water defaults.
 */
export function sceneWaterInfo(doc) {
  const mats = isObj(doc?.materials) ? doc.materials : {};
  const name = doc?.waterMaterial;
  if (typeof name === 'string' && isSceneWater(mats[name], name)) return mats[name];
  const entries = Object.entries(mats).filter(([n, info]) => isSceneWater(info, n));
  return entries.find(([, info]) => typeof info.shader === 'string' && info.shader.endsWith('/StylizedWater'))?.[1] || entries[0]?.[1] || null;
}

/**
 * One scene chunk from several that share a material bucket (`sceneMaterialKey`). Vertex attributes stay in the
 * scene.bin layout (position f32×3, uv f32×2, lightmap uv f32×2, normal i8×4, colour u8×4) and indices are rewritten
 * with the vertex offset; past 65535 vertices the index is 32-bit (WebGL2). A single chunk is returned as-is, so the
 * pack's views of scene.bin stay shared. The caller passes chunks of one bucket that are on screen together: a
 * file-level merge would bake a switched-off HIDDEN part into the base mesh.
 * @param {object[]|null} chunks
 * @returns {object|null}
 */
export function mergeSceneChunks(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return null;
  if (chunks.length === 1) return chunks[0];
  const first = chunks[0];
  let nv = 0, ni = 0, index32 = false;
  for (const c of chunks) {
    const n = c?.position?.length / 3;
    if (!Number.isInteger(n) || n <= 0) throw new Error(`scene chunk ${c?.material}: ${c?.position?.length ?? 0} position components`);
    if (c.material !== first.material) throw new Error(`scene merge mixes ${first.material} and ${c.material}`);
    if (c.uv?.length !== n * 2 || c.uv1?.length !== n * 2 || c.normal?.length !== n * 4 || c.color?.length !== n * 4) {
      throw new Error(`scene chunk ${c.material}: attributes do not match ${n} vertices`);
    }
    if (!c.index || c.index.length === 0) throw new Error(`scene chunk ${c.material}: no indices`);
    nv += n;
    ni += c.index.length;
    if (c.index instanceof Uint32Array) index32 = true;
  }
  if (nv > 65535) index32 = true;
  const position = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const uv1 = new Float32Array(nv * 2);
  const normal = new Int8Array(nv * 4);
  const color = new Uint8Array(nv * 4);
  const index = index32 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0, bounds = null;
  for (const c of chunks) {
    const n = c.position.length / 3;
    position.set(c.position, vo * 3);
    uv.set(c.uv, vo * 2);
    uv1.set(c.uv1, vo * 2);
    normal.set(c.normal, vo * 4);
    color.set(c.color, vo * 4);
    for (let i = 0; i < c.index.length; i++) {
      const v = c.index[i];
      if (v < 0 || v >= n) throw new Error(`scene chunk ${c.material}: index ${v} out of ${n}`);
      index[io + i] = v + vo;
    }
    vo += n;
    io += c.index.length;
    if (Array.isArray(c.bounds) && c.bounds.length >= 6) {
      const b = c.bounds;
      bounds = bounds
        ? [Math.min(bounds[0], b[0]), Math.min(bounds[1], b[1]), Math.min(bounds[2], b[2]), Math.max(bounds[3], b[3]), Math.max(bounds[4], b[4]), Math.max(bounds[5], b[5])]
        : b.slice();
    }
  }
  return { material: first.material, lightmap: first.lightmap, group: '', bounds, position, uv, uv1, normal, color, index };
}

/** Ground rect [x0, y0, x1, y1] (board space) of every named group of chunks (the scene's switchable parts). */
export function sceneGroupRects(chunks) {
  const out = {};
  for (const c of chunks || []) {
    if (!c.group || !c.bounds) continue;
    const b = c.bounds, r = out[c.group];
    out[c.group] = r ? [Math.min(r[0], b[0]), Math.min(r[1], b[1]), Math.max(r[2], b[3]), Math.max(r[3], b[4])] : [b[0], b[1], b[3], b[4]];
  }
  return out;
}

async function fetchBuffer(url) {
  try { const r = await fetch(url, { cache: 'no-cache' }); return r.ok ? await r.arrayBuffer() : null; } catch { return null; }
}

const sceneCache = new Map();

/** Does the local-art manifest list the official scene of `stageId`? (manifest only) */
export async function sceneListed(assets, stageId) {
  if (!stageId || !assets || typeof assets.local !== 'function' || typeof assets.localUrl !== 'function') return false;
  try { await assets.local(); } catch { return false; }
  return !!assets.localUrl(sceneGroup(stageId), 'scene') && !!assets.localUrl(sceneGroup(stageId), 'bin');
}

/**
 * Load a stage's official scene (scene.json + scene.bin + lightmap pages + the materials' albedo (`images.tex`) and
 * normal / metallic-gloss (`images.data`) textures + the reflection atlas `images.env`). A missing texture, lightmap
 * page or atlas only drops that map; a missing or malformed scene gives null (→ the procedural board).
 * @returns {Promise<object|null>}
 */
export function loadScenePack(assets, stageId) {
  if (typeof stageId !== 'string' || !stageId) return Promise.resolve(null);
  if (sceneCache.has(stageId)) return sceneCache.get(stageId);
  const pending = (async () => {
    if (!(await sceneListed(assets, stageId)) || typeof assets.image !== 'function') return null;
    const url = (g, n) => { const u = assets.localUrl(g, n); return typeof u === 'string' && u ? encodeURI(u) : null; };
    const group = sceneGroup(stageId);
    const [doc, buf] = await Promise.all([fetchJson(url(group, 'scene')), fetchBuffer(url(group, 'bin'))]);
    if (!isObj(doc) || doc.version !== SCENE_VERSION || !buf) return null;
    const chunks = parseSceneChunks(doc, buf);
    if (!chunks || !chunks.length) return null;
    const img = async (u) => {
      if (!u) return null;
      const i = await assets.image(u, { retry: true }).catch(() => null);
      return i && (i.width || i.naturalWidth) > 0 ? i : null;
    };
    const mats = isObj(doc.materials) ? doc.materials : {};
    const namesOf = (...keys) => [...new Set(Object.values(mats).flatMap((m) => keys.map((k) => (isObj(m) && typeof m[k] === 'string' ? m[k] : null))).filter(Boolean))];
    const names = namesOf('map'), dataNames = namesOf('normalMap', 'glossMap');
    const pages = Math.max(0, Math.min(16, doc.lightmaps | 0));
    const [texList, dataList, lm, env] = await Promise.all([
      Promise.all(names.map((n) => img(url(SCENE_TEX_GROUP, n)))),
      Promise.all(dataNames.map((n) => img(url(SCENE_TEX_GROUP, n)))),
      Promise.all(Array.from({ length: pages }, (_, i) => img(url(group, `lm${i}`)))),
      isObj(doc.env) ? img(url(group, 'env')) : null,
    ]);
    const tex = {}, data = {};
    names.forEach((n, i) => { if (texList[i]) tex[n] = texList[i]; });
    dataNames.forEach((n, i) => { if (dataList[i]) data[n] = dataList[i]; });
    return { key: `${url(group, 'scene')}#${doc.binBytes | 0}`, stage: stageId, doc, chunks, groups: sceneGroupRects(chunks), images: { tex, data, lm, env } };
  })().catch((err) => { console.warn('[board3d] scene load failed', err); return null; }).then((pack) => {
    if (!pack && sceneCache.get(stageId) === pending) sceneCache.delete(stageId);
    return pack;
  });
  sceneCache.set(stageId, pending);
  return pending;
}

/** Forget the cached pack and the three.js import attempt (tests / hot reload). */
export function resetBoardPack() { cached = null; threePromise = null; threeFailures = 0; sceneCache.clear(); }
