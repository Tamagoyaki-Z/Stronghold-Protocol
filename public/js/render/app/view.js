// public/js/render/app/view.js — which field a camera shows, and the board box that follows it.

import { AREAS, areaFor } from '../board3d/layout.js';
import { normRect } from '../projection.js';

const VIEW_KINDS = new Set(['prep', 'normal', 'unite', 'boss', 'bossPrep', 'pen']);

/**
 * The field a camera request actually shows — what render/projection.js presetCamera frames: 'hidden' → 'boss';
 * a 'prep' camera asked for the boss rows (Final Assault prep: rect r1 ≤ 6) → 'bossPrep'; unknown kinds → 'normal'.
 * Drives the built 3D area, the drawn 2D rows and the lit rect, so they always match the camera.
 */
export function viewKind(kind, opts) {
  let k = kind === 'hidden' ? 'boss' : kind;
  if (!VIEW_KINDS.has(k)) k = 'normal';
  if (k === 'prep' && opts && opts.rect && normRect(opts.rect).r1 <= 6) k = 'bossPrep';
  return k;
}

/** 3D areas without the enemy preview pen block (the own field / both normal halves); see `boardArea`. */
const AREA_NO_PEN = Object.freeze({
  normal: Object.freeze(AREAS.normal.filter((a) => a.r1 <= 13)),
  unite: Object.freeze(AREAS.unite.filter((a) => a.r1 <= 13)),
});

/**
 * 3D area built for a view kind (viewKind): the enemy preview pen (rows 14–18) only for the 'pen' camera — the prep,
 * battle and 联防 cameras show the field alone (user playtest #2 item 6) with its separator rows 6 and 13 (the row-13
 * devices blow into the field: act2 m01's blowers, user playtest #5 item 6; the boss field's row-6 devices are drawn
 * with the boss field only — board3d/layout.js stageDevices); the boss kinds build the boss field.
 */
export function boardArea(vk) {
  if (vk === 'pen') return AREAS.normal;
  if (vk === 'prep' || vk === 'normal') return AREA_NO_PEN.normal.length ? AREA_NO_PEN.normal : AREAS.normal;
  if (vk === 'unite') return AREA_NO_PEN.unite.length ? AREA_NO_PEN.unite : AREAS.unite;
  return areaFor(vk);
}

/**
 * 2D rows drawn for a view kind: the pen rows (14–18) only for the 'pen' camera; the boss field with the separator
 * and the normal rows behind it as scenery.
 */
export function bandFor(kind) {
  if (kind === 'boss' || kind === 'hidden' || kind === 'bossPrep') return [0, 13];
  return kind === 'pen' ? [6, 18] : [6, 13];
}

/**
 * Active field rows [r0, r1] of a view kind for the 2D board (render/tiles.js `setView` field: drawn rows outside it are
 * dim scenery without devices): the normal / 联防 / prep fields live between the separator walls (rows 6–13, the
 * devices on the row-13 wall included; the row-6 wall's belong to the boss field — tiles.js _stageDevices); the pen
 * camera adds the pen (6–18); the boss field 0–6.
 */
export function fieldRows(kind) {
  return kind === 'boss' || kind === 'hidden' || kind === 'bossPrep' ? [0, 6] : kind === 'pen' ? [6, 18] : [6, 13];
}

/** Are the pen's figures shown for a view kind (a camera flight shows them when either end is the pen)? */
export const penShown = (vk, prevVk = null) => vk === 'pen' || prevVk === 'pen';

/** Is the prep's leader on the boss field shown for a view kind (a flight shows it when either end is the boss-field prep)? */
export const leaderShown = (vk, prevVk = null) => vk === 'bossPrep' || prevVk === 'bossPrep';

/** localStorage key of the sticky remote 2D switch (`sp.pref.` + this, same namespace as the settings in store.js). */
export const BOARD_PREF_KEY = 'board';

/** The `?board=` value of a URL search string, or null. Shared with render/board3d/load.js `boardPreferenceFromURL`. */
export function boardPreferenceFromURL(search) {
  try { return new URLSearchParams(search || '').get('board'); } catch { return null; }
}

/**
 * `'2d' | '3d' | 'auto'` board preference. Highest first:
 *
 *   1. `?board=`in the page URL — the immediate, no-tools-required override: `?board=2d` is the emergency switch a
 *      player can be sent (or bookmark) when the 3D board freezes their machine (field report 2026-10: a black screen
 *      with a dead cursor, every 3D (re)initialisation — prep, round change, scene switch). `?board=3d` re-enables 3D;
 *      `?board=auto` forgets a stored choice. `?board=` is validated, so an unrelated value falls through.
 *   2. the remembered choice of `?board=` (`localStorage` `sp.pref.board`) — what makes the emergency switch survive the
 *      player walking into a room and getting a fresh URL. A preference the PLAYER cannot be reached with is not a
 *      switch: 2D would otherwise come back the moment the query string is gone.
 *   3. the caller's own `opt` (the view option; only the dev demo passes one).
 *
 * @param {string} [opt] the caller's own preference
 * @param {'2d'|'3d'|'auto'} [stored] the remembered preference (default: read from localStorage, null-safe)
 * @param {(v: '2d'|'3d'|'auto') => void} [remember] how to persist a `?board=` the URL carried (default: savePref)
 * @returns {'2d'|'3d'|'auto'}
 */
export function boardPreference(opt, stored = storedBoardPreference(), remember = rememberBoardPreference) {
  if (stored !== '2d' && stored !== '3d') stored = null;
  let raw = null;
  try { raw = boardPreferenceFromURL(globalThis.location?.search); } catch { /* no location */ }
  if (raw === 'auto') { remember('auto'); return 'auto'; }
  if (raw === '2d' || raw === '3d') { remember(raw); return raw; }
  const v = opt;
  return stored || (v === '2d' || v === '3d' ? v : 'auto');
}

/** The remembered `?board=` choice, or null (no localStorage / private mode / never set). */
export function storedBoardPreference() {
  try {
    const v = globalThis.localStorage?.getItem('sp.pref.' + BOARD_PREF_KEY);
    return v === '2d' || v === '3d' ? v : null;
  } catch { return null; }
}

/**
 * Remember (or forget, for `'auto'`) the `?board=` choice. Every failure — quota, private mode, no storage — is
 * ignored: the switch of THIS page load still works, only its persistence is lost.
 * @param {'2d'|'3d'|'auto'} v
 */
export function rememberBoardPreference(v) {
  try {
    if (v === '2d' || v === '3d') globalThis.localStorage?.setItem('sp.pref.' + BOARD_PREF_KEY, v);
    else globalThis.localStorage?.removeItem('sp.pref.' + BOARD_PREF_KEY);
  } catch { /* ignore */ }
}

/** `?board=2d` was applied to THIS page load (the notice in render/app.js `showBoardNotice` keys off it). */
export function boardForcedByURL() {
  try { return boardPreferenceFromURL(globalThis.location?.search) === '2d'; } catch { return false; }
}

/**
 * A battle device box (render/units.js DeviceView `ctx.createBox()` contract: `{ mesh, update(cam, b), destroy() }`)
 * that follows the board layer: the 3D scene's crate mesh while `board()` returns a BoardScene, else the Pixi box of
 * the 2D board. A board switch mid-battle (lost WebGL context → 2D, or back to 3D) swaps the inner box on the next
 * update instead of leaving the crate on a dead scene. `mesh` is the Pixi mesh (null in 3D: nothing to add to Pixi).
 */
export function switchableBox({ board, pixi }) {
  let inner = null, owner;
  const drop = () => { try { inner?.destroy(); } catch { /* ignore */ } inner = null; owner = undefined; };
  return {
    get mesh() { return inner ? inner.mesh || null : null; },
    get inner() { return inner; },
    update(cam, b) {
      const scene = board() || null;
      if (!inner || owner !== scene || inner.destroyed) {
        drop();
        inner = scene ? scene.createDevice() : pixi();
        owner = scene;
      }
      inner?.update(cam, b);
    },
    destroy: drop,
  };
}
