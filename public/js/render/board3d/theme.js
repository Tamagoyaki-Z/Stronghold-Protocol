// public/js/render/board3d/theme.js — which world-texture theme a stage is played on.
//
// The local-client dump ships more than one recolour of the board: the default (`map/autochess`) and 沙地
// (`map/autochesssand`, 沙尘暴/土石结构). The two differ in file names, in prefab names and in shader keywords, so a
// stage played on sand must say so — the board cannot guess it — and nothing may swap the default world for another
// theme globally (every other stage would then be drawn on sand).
//
// The mapping is keyed by STAGE ID, not by display name: `name` is a human label that i18n and future patches can edit
// ("战场#06(上半) 沙尘暴/土石结构"), while the id is the stable key every other subsystem already uses. Adding a theme
// is one entry here plus its manifest group; a stage with no entry keeps the default world, which is what every stage
// did before themes existed.
//
// Kept free of three.js / DOM so it is testable in Node (the board pack loader reads it, see load.js).

/** Manifest group of the default world — the board every stage drew before themes existed. */
export const DEFAULT_THEME = 'map/autochess';

/**
 * Stage id → manifest group of the world its battlefield is dressed in.
 *
 * 沙地: the sand battlefield. `map/autochesssand` carries its own prefab (`MT_AutochessSand`), shader
 * (`StandardRealtimeShadow` + vertex-colour blend) and textures (`TX_AutochessSand_A/N/M`, plus `_Grass_*` / `_shuidi_*`).
 * KNOWN GAP (2026-10-08, recorded rather than hidden): the renderer builds its materials from the DEFAULT prefab's
 * keyword set, so sand is textured correctly but its vertex-colour-blend shading path is not ported, and the dump has no
 * sand decoration meshes (土石结构) — the ground, water and background are real, the props are not there to place.
 *
 * The stage id is checked with a suffix test (`…m06`) because a future patch may prefix it (`act3autochess_m06`); the
 * alternative — matching the name — would break on any wording change.
 */
export const STAGE_THEME = Object.freeze({
  act1autochess_m06: 'map/autochesssand', // 战场#06(上半) 沙尘暴/土石结构
});

/** Stage ids known to have a matching manifest group (see STAGE_THEME). */
export function themeForStage(stageId) {
  if (typeof stageId !== 'string' || !stageId) return DEFAULT_THEME;
  if (STAGE_THEME[stageId]) return STAGE_THEME[stageId];
  // One documented tolerance: a future patch may version the prefix (`act3autochess_m06`). Only the part from
  // `autochess_` on is compared, so an unrelated id can never match. There is deliberately no name-based fallback —
  // matching display names would silently move a stage onto sand when its wording changes.
  const key = stageId.slice(stageId.indexOf('autochess_'));
  if (key.startsWith('autochess_')) {
    for (const [id, group] of Object.entries(STAGE_THEME)) {
      if (id.endsWith(key)) return group;
    }
  }
  return DEFAULT_THEME;
}

/**
 * The theme group to load for a board.
 *
 * `stageId` comes from the match (`m.public.stageId`); when the client does not know it yet (the view can be created
 * before the match's first frame) the default world is used, which is exactly the pre-theme behaviour. Callers must not
 * pass a theme derived from a name or from "the first group that exists".
 * @param {string|null|undefined} stageId
 * @returns {string}
 */
export function boardThemeFor(stageId) {
  return themeForStage(stageId);
}
