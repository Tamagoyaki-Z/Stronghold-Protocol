// Asset URL resolution against data/assets.json (docs/ASSETS.md). Pure: every function takes the
// manifest object (or null) and returns a URL string or null — callers draw their own fallback
// (glyph, CSS shape) when null. Only URLs present in the manifest are ever returned, so the client
// never requests files the asset pipeline did not produce (no 404 noise in the console).

const str = (v) => (typeof v === 'string' && v ? v : null);
const obj = (v) => (v && typeof v === 'object' ? v : null);

/** @param {any} m manifest @param {string} key 'group/key' */
export function uiUrl(m, key) {
  return str(obj(obj(m)?.ui)?.[key]);
}

/**
 * Operator avatar for a chess record (golden → E2 art when present).
 *
 * 干员皮肤 (docs/SKINS.md): `skinId` swaps in the skin's own 180×180 thumbnail. Without it the 干员调配 roster, the
 * shop cards and the prep underframe kept drawing the DEFAULT portrait after a skin was chosen — the choice only
 * reached the board models, never the operator's picture.
 * @param {any} m manifest
 * @param {any} chess chess.json record (or { assets: { avatar } })
 * @param {string|null} [skinId] a chosen skin's id (`char_498_inside@kitchen#2`)
 */
export function chessAvatarUrl(m, chess, skinId = null) {
  const chars = obj(obj(m)?.chars);
  const id = str(chess?.assets?.avatar) || str(chess?.charId);
  if (!chars || !id) return null;
  if (skinId) {
    // the skin catalogue lives under the OPERATOR id (assets.json `chars[charId].skins[skinId]`)
    const skin = obj(obj(chars[id])?.skins)?.[skinId] || obj(obj(chars[str(chess?.charId)])?.skins)?.[skinId];
    const art = str(skin?.avatar);
    if (art) return art;
  }
  if (id.endsWith('_2') && !chars[id]) {
    const base = chars[id.slice(0, -2)];
    return str(base?.avatarE2) || str(base?.avatar);
  }
  return str(chars[id]?.avatar) || (chess?.charId ? str(chars[chess.charId]?.avatar) : null);
}

/**
 * Half-body portrait (180×360) for a chess record (golden → E2 portrait when present).
 * @param {any} m
 * @param {any} chess
 */
export function chessPortraitUrl(m, chess) {
  const chars = obj(obj(m)?.chars);
  const id = str(chess?.assets?.portrait);
  if (!chars) return null;
  if (id) {
    if (id.endsWith('_2')) {
      const base = chars[id.slice(0, -2)];
      if (base) return str(base.portraitE2) || str(base.portrait);
    }
    if (id.endsWith('_1')) {
      const base = chars[id.slice(0, -2)];
      if (base) return str(base.portrait);
    }
  }
  const byChar = chess?.charId ? chars[chess.charId] : null;
  if (!byChar) return null;
  return (chess?.isGolden ? str(byChar.portraitE2) : null) || str(byChar.portrait);
}

/**
 * 立绘 URL：选了皮肤就用皮肤的 180×180 头像，否则回退原立绘。
 *
 * 皮肤 (docs/SKINS.md) 只带 180×180 头像与战斗骨骼，**不含 ~2.5 MB 的 `skin/{portraitId}b.png`**，所以
 * 原本要立绘的地方（商店卡片、详情头图）就用头像顶上。`skinId` 由调用方传入而不是在这里读 store，
 * 以保持本文件所有函数都是纯函数。传入的 key 应是**基础棋子 id**（精锐卡用 baseId），与服务端
 * server/lobby.js freezeSkins 和对局渲染 public/js/render/app.js 同一口径。
 * @param {any} m manifest
 * @param {any} chess chess.json 记录
 * @param {string|null} [skinId] 已选皮肤的 id（char_102_texas@epoque#7）
 */
export function chessArtUrl(m, chess, skinId = null) {
  if (skinId && hasSkin(m, chess, skinId)) {
    const skinAvatar = chessAvatarUrl(m, chess, skinId);
    if (skinAvatar) return skinAvatar;
  }
  return chessPortraitUrl(m, chess);
}

/**
 * Whether the manifest really carries this skin for this operator.
 *
 * `chessAvatarUrl` answers with *something* for an unknown skinId too (its `_2` branch hands back the E2 art of the
 * operator), so a caller that wants "a skin, or exactly the plain portrait" — the shop card is one — has to ask the
 * catalogue instead of the URL helper. The catalogue is keyed by the OPERATOR id, the same two keys chessAvatarUrl
 * tries (the record's `assets.avatar`, then `charId`).
 * @param {any} m manifest @param {any} chess chess.json record @param {string|null} skinId
 */
function hasSkin(m, chess, skinId) {
  const chars = obj(obj(m)?.chars);
  if (!chars || !skinId) return false;
  const id = str(chess?.assets?.avatar) || str(chess?.charId);
  const rec = (id ? obj(obj(chars[id])?.skins)?.[skinId] : null) || obj(obj(chars[str(chess?.charId)])?.skins)?.[skinId];
  return !!str(rec?.avatar);
}

/** Skill icon of a chess record (manifest `skills[iconId]`, else the empty skill sprite). */
export function skillIconUrl(m, chess) {
  const skills = obj(obj(m)?.skills);
  const id = str(chess?.assets?.skillIcon) || str(chess?.skill?.iconId) || str(chess?.skill?.skillId);
  if (skills && id && skills[id]) return str(skills[id]);
  const byId = obj(obj(m)?.skillsById);
  const alt = byId && chess?.skill?.skillId ? byId[chess.skill.skillId] : null;
  if (skills && alt && skills[alt]) return str(skills[alt]);
  return uiUrl(m, 'skillIcon/empty');
}

/**
 * Skill icon of one skill record (DESIGN §16 `skills[]`: iconId / skillId), else the empty skill sprite — or null with
 * `{ empty: false }` (the asset manifest only carries the default skills' icons: callers then draw a lettered S1–S3
 * tile instead of a blank square).
 */
export function skillRecordIconUrl(m, skill, { empty = true } = {}) {
  const skills = obj(obj(m)?.skills);
  for (const id of [str(skill?.iconId), str(skill?.skillId)]) if (skills && id && skills[id]) return str(skills[id]);
  const byId = obj(obj(m)?.skillsById);
  const alt = byId && skill?.skillId ? byId[skill.skillId] : null;
  if (skills && alt && skills[alt]) return str(skills[alt]);
  return empty ? uiUrl(m, 'skillIcon/empty') : null;
}

const PROF_KEY = {
  PIONEER: 'pioneer', WARRIOR: 'warrior', TANK: 'tank', SNIPER: 'sniper', CASTER: 'caster', MEDIC: 'medic',
  SUPPORT: 'support', SPECIAL: 'special',
};

/** Profession icon (small white glyph). */
export function profIconUrl(m, profession) {
  const k = PROF_KEY[String(profession || '').toUpperCase()];
  return k ? str(obj(obj(obj(m)?.prof)?.icon)?.[k]) : null;
}

/** Sub-profession icon from a chess record (`assets.subProfIcon` = 'sub_<id>_icon'). */
export function subProfIconUrl(m, chess) {
  const sub = obj(obj(obj(m)?.prof)?.sub);
  if (!sub) return null;
  const raw = str(chess?.assets?.subProfIcon);
  const id = raw ? raw.replace(/^sub_/, '').replace(/_icon$/, '') : str(chess?.subProfessionId);
  return id ? str(sub[id]) : null;
}

/** Bond glyph (white; tint in CSS). */
export function bondIconUrl(m, bondId) {
  return bondId ? str(obj(obj(m)?.bonds)?.[bondId]) : null;
}

/** Band (strategy) icon. */
export function bandIconUrl(m, bandId) {
  return bandId ? str(obj(obj(m)?.bands)?.[bandId]) : null;
}

/** Item icon for an items.json record (by trapId / iconId) or a raw trap id. */
export function itemIconUrl(m, item) {
  const items = obj(obj(m)?.items);
  if (!items) return null;
  if (typeof item === 'string') return str(items[item]);
  return str(items[item?.iconId]) || str(items[item?.trapId]);
}

/** Enemy icon (manifest keeps fallbacks resolved). */
export function enemyIconUrl(m, enemyKey) {
  const e = enemyKey ? obj(obj(obj(m)?.enemies)?.[enemyKey]) : null;
  if (e?.icon) return str(e.icon);
  // `_2` / `_3` variants fall back to their base enemy
  const base = typeof enemyKey === 'string' ? enemyKey.replace(/_\d+$/, '') : null;
  return base && base !== enemyKey ? str(obj(obj(obj(m)?.enemies)?.[base])?.icon) : null;
}

/** Token avatar, falling back to its owner operator's avatar. */
export function tokenAvatarUrl(m, tokenId) {
  const tokens = obj(obj(m)?.tokens);
  const t = tokenId ? obj(tokens?.[tokenId]) : null;
  if (t?.avatar) return str(t.avatar);
  if (t?.owner) return str(obj(obj(obj(m)?.chars)?.[t.owner])?.avatar);
  return null;
}

/** Faction (特训敌人 type) icon: `enemyTypeIcon/<icon>`. */
export function factionIconUrl(m, iconId) {
  return iconId ? uiUrl(m, `enemyTypeIcon/${iconId}`) : null;
}

/** Title (评语) icon: `titleIcon/<picId>`. */
export function titleIconUrl(m, picId) {
  return picId ? uiUrl(m, `titleIcon/${picId}`) : null;
}

/** Greek type letters of some modules (ISW-α, …) → the Latin letter of the client's icon file names (isw-a). */
const GREEK = { 'α': 'a', 'β': 'b', 'γ': 'g', 'δ': 'd', 'Δ': 'd' };
/** Lower-cased key → path index of a local `groups.module` object (built once per manifest object). */
const moduleIconIndex = new WeakMap();

/**
 * Official module (uniequip) TYPE icon from the local-client art (DESIGN §13 / §16): `data/local-assets.json`
 * `groups.module[<type>]`, matched case-insensitively against the module's typeName ('MAR-X' → key 'mar-x', 'PRI-X' →
 * key 'PRI-X' — the client's file names are mixed case). null when the manifest, the group or the entry is missing
 * (callers draw the lettered tile / type text instead).
 * @param {any} local the local-art manifest (`data.get('local')`) or null
 * @param {string} typeName e.g. 'MAR-X'
 */
export function moduleTypeIconUrl(local, typeName) {
  const g = obj(obj(obj(local)?.groups)?.module);
  const t = str(typeName)?.trim();
  if (!g || !t) return null;
  const exact = str(obj(g[t])?.path);
  if (exact) return exact;
  let idx = moduleIconIndex.get(g);
  if (!idx) {
    idx = new Map();
    for (const [k, v] of Object.entries(g)) {
      const p = str(obj(v)?.path);
      if (p && !idx.has(k.toLowerCase())) idx.set(k.toLowerCase(), p);
    }
    moduleIconIndex.set(g, idx);
  }
  const key = t.replace(/[αβγδΔ]/g, (c) => GREEK[c]).toLowerCase();
  return idx.get(key) || null;
}

/**
 * Icon for an m.private.effects entry: { iconKind: 'band'|'choice'|'team'|'item'|'garrison', iconId }.
 * @param {any} m
 * @param {{ iconKind?: string, iconId?: string }} eff
 */
export function effectIconUrl(m, eff) {
  const kind = eff?.iconKind;
  const id = str(eff?.iconId);
  if (kind === 'band') return bandIconUrl(m, id) || (id && id.startsWith('icon_') ? bandIconUrl(m, `band_${id.slice(5)}`) : null);
  if (kind === 'item') return itemIconUrl(m, id);
  if (kind === 'garrison') return uiUrl(m, `garrisonTypeIcon/${id || 's_icon_bond'}`) || uiUrl(m, 'garrisonTypeIcon/s_icon_bond');
  if (kind === 'team') return uiUrl(m, `buffIcon/${id && id.startsWith('icon_') ? id : 'icon_team_buff'}`);
  if (kind === 'choice') return uiUrl(m, `buffIcon/${id && id.startsWith('icon_') ? id : 'icon_player_buff'}`);
  return id ? uiUrl(m, `buffIcon/${id}`) : null;
}
