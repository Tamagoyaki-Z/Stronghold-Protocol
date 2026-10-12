// render/board3d/load.js — loading of three.js and the official board art (local-client extraction, DESIGN §13/§15).
//
//   const THREE = await loadThree()            // '/vendor/three.module.js' (tools/vendor.mjs), null when missing
//   const pack = await loadBoardPack(assets)   // null when the board art is not installed (→ 2D board)
//   → { key, images: { D, N?, R?, E?, common?, commonE?, BG?, wind?, gate?, waterN?, caustics?, noise? },
//       meshes: { crate?, blower?, bgPlane?, gate: { startDown?, startUp?, startBack?, endDown?, endUp? } },
//       tiles, uv, materials: { theme?, fx? } }
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

/**
 * Why the 3D board is or is not used, readable at runtime (dev / field diagnosis).
 *
 * `render/app.js` decides with two values — `webgl2Available(allowSlow)` and `boardArtListed(assets)` — and when the
 * answer is "2D" there is otherwise nothing to read: `stats().board3d` only says `{ on: false }` without saying which
 * of the two said no. The three booleans here are the whole decision, computed on demand (never at boot).
 *
 *   await __SP_BOARD3D_PROBE__() → {
 *     gl2:     WebGL2 ignoring the "major performance caveat" flag (a software renderer still reports true here),
 *     gl2fast: WebGL2 as the DEFAULT `auto` mode asks for it (software / blocklisted ⇒ false → 2D),
 *     listed:  the local-art manifest lists map/autochess/TX_autochessi_D (i.e. the board art is installed),
 *     url:     the URL that listing resolves to (null when not installed),
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
  return { gl2: webgl2Available(true), gl2fast: webgl2Available(false), listed, url };
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
});

export const PACK_MESHES = Object.freeze({
  crate: ['mesh/s_common_box_01', 'pCube2'],
  blower: ['mesh/s_wind_device', 'S_wild_wind_device'],
  bgPlane: ['mesh/s_background_common', 'pPlane1'],
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
    const [tiles, fxMats, fxPrefab] = await Promise.all([
      fetchJson(tilesUrl),
      (async () => { const u = url('map/fx', 'materials'); return u ? fetchJson(u) : null; })(),
      (async () => { const u = url('map/fx', 'prefab'); return u ? fetchJson(u) : null; })(),
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
      materials: { theme: isObj(themeMats) ? themeMats : null, fx: isObj(fxMats) ? fxMats : null },
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

/** Forget the cached pack and the three.js import attempt (tests / hot reload). */
export function resetBoardPack() { cached = null; threePromise = null; threeFailures = 0; }
