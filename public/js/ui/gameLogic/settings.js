// ui/gameLogic/settings.js — settings defaults and sanitising. Re-exported from ../gameLogic.js.

import { VOICE_LANGS, sanitizeVoiceOverrides } from '../../voicePrefs.js';
export { VOICE_LANGS } from '../../voicePrefs.js';

import { clamp, isObj } from './shared.js';
import { DEFAULT_HOTKEYS, sanitizeHotkeys } from './shortcuts.js';


// ---- settings ------------------------------------------------------------------------------------------------------

/**
 * The operator voice dubs (settings 语音语言): 'cn' 中文 (`audio.voice`, the default) and 'jp' 日本語 (`audio.voiceJp`,
 * falling back to the Chinese line it lacks — public/js/audio.js voiceLine). Not tied to the interface language.
 */


/**
 * The steps of 设置 →「文字大小」 (textSize): the interface text root `--t` of css/theme.css — 'sm' is the design's own
 * sizes (`--t: 1rem`), the others lift the phone's 40 px root by a floor and grow the desktop gently. Text only: the
 * layout root `1rem` (and with it the field camera, the detail card's side and the DOM fallback board) never moves.
 */
export const TEXT_SIZES = Object.freeze(['sm', 'md', 'lg', 'xl']);

/** keys: the in-match shortcuts' key map (ui/gameLogic/shortcuts.js; settings → 快捷键). voiceLang: VOICE_LANGS.
 *  textSize: TEXT_SIZES (css/theme.css `--t`, applied by ui/settings.js applyTextSize). ammoCount: 设置「弹药数量」 — the
 *  rounds left / the magazine under an ammo skill's bar (render/units.js; PR #552), off by default: the official HUD has no
 *  such number (the maintainer's decision of 2026-10-13).
 *  performanceMode: 性能模式 — the render side lives in render/app.js (perfMode / PERF_DPR_CAP).
 *  optimisticFeedback: 乐观界面反馈 — painted by ui/gameActions.js + screens/game.js, default ON. */
export const DEFAULT_SETTINGS = Object.freeze({ bgm: 0.6, sfx: 0.8, voice: 0.8, voiceLang: 'cn', voiceOverrides: Object.freeze({}), resolution: 'auto', muted: false, damageNumbers: true, officialDamageNumbers: false, ammoCount: false, quality: 'high', performanceMode: false, optimisticFeedback: true, textSize: 'sm', keys: DEFAULT_HOTKEYS });
const QUALITIES = ['high', 'medium', 'low'];

/**
 * 乐观界面反馈 / OPTIMISTIC UI FEEDBACK — 默认**开**（项目所有者已批准 A 方案，2026-10-12）。
 *
 * 局内点按的往返成本 ≈ 2×主线程排队 + 2×网络（服务端只占 1–2 ms），点按后要等一会儿才有反应。
 * 开着时 ui/gameActions.js 会为每个未答复的请求发布一个 pending 意图，UI 只据此画**纯视觉**的
 * 保留态（置灰 / aria-busy / 底部扫光条）——绝不猜任何权威数值：资金、卡池、座位、回合、准备状态
 * 全部仍只来自服务器帧，因此**帧到达后本地渲染的就是服务器状态**；答复、错误、超时（8 s）或断线
 * 都会撤销该态。关着时 pending 快照为空，组件渲染与加这个功能之前逐字节一致。
 */

/**
 * 性能模式 / PERFORMANCE MODE — 一键降载，默认关（关着时整条渲染路径和以前完全一致）。
 *
 * The player's own 画质 (quality) is never rewritten: the render engine only reads a *derived* tier
 * (`render/app.js` perfMode/viewQuality) while this is on — no 3D board (it reuses the existing
 * "3D art / WebGL2 unavailable → 2D atlas board" branch), the pixel-ratio cap drops to 1, and the
 * effects/shadow/antialias path runs at quality 'low'. It is a client-only preference, stored with
 * the rest of the settings in `sp.pref.settings`.
 */


/**
 * 分辨率 / RESOLUTION — how many device pixels the field canvas is allowed to use.
 *
 * Split out of 画质 (quality) on the project owner's request (2026-10-08): a phone whose operator models read blurry
 * needs MORE PIXELS for the sprites, and folding that into 画质 would also turn on the expensive board features the
 * player may not want (the 3D board's PBR fill, shadows). These are pixel-ratio CAPS applied on top of the device's
 * own `devicePixelRatio`, so 'native' (=2) means "up to 2× CSS pixels" and never upscales beyond the screen.
 *   auto  — the 画质 setting decides (upstream behaviour, the default)
 *   720p / 1080p / 1440p — a fixed cap, for a phone that renders at 3× and cannot afford it
 *   native — always the highest cap (2), the "as sharp as the screen allows" choice
 * The 3D board keeps its own, lower cap: it is fill-bound (the PBR board), unlike the sprites.
 */
export const RESOLUTION_MODES = Object.freeze(['auto', '720p', '1080p', '1440p', 'native']);
export const RES_CAP = Object.freeze({ '720p': 1, '1080p': 1.5, '1440p': 2, native: 2 });
/** The pixel-ratio cap a resolution mode asks for, or null for `auto` (the caller then keeps its quality default). */
export function resolutionCap(res) {
  return RES_CAP[res] ?? null;
}
/** The 3D board's own cap: it never exceeds the sprite cap, and stays below it on the mid tiers. */
export function boardResolutionCap(res) {
  const cap = resolutionCap(res);
  if (cap == null) return null;
  return cap >= 2 ? 2 : cap <= 1 ? 1 : 1.25;
}

/**
 * Sanitize persisted settings.
 * @param {any} raw
 * @returns {{ bgm: number, sfx: number, voice: number, voiceLang: 'cn'|'jp', voiceOverrides: Record<string, string>, resolution: 'auto'|'720p'|'1080p'|'1440p'|'native', muted: boolean, damageNumbers: boolean, officialDamageNumbers: boolean, ammoCount: boolean, quality: 'high'|'medium'|'low',
 *   performanceMode: boolean, optimisticFeedback: boolean, textSize: 'sm'|'md'|'lg'|'xl', keys: Record<'refresh'|'freeze'|'levelUp'|'retreat'|'sell'|'ready', string> }}
 */
export function sanitizeSettings(raw) {
  const r = isObj(raw) ? raw : {};
  const vol = (v, d) => (Number.isFinite(v) ? clamp(Math.round(v * 100) / 100, 0, 1) : d);
  return {
    bgm: vol(r.bgm, DEFAULT_SETTINGS.bgm),
    sfx: vol(r.sfx, DEFAULT_SETTINGS.sfx),
    voice: vol(r.voice, DEFAULT_SETTINGS.voice),
    // 中日语音: only cn/jp; anything else (absent field, an old save, a hand-edited value) ⇒ cn
    voiceLang: VOICE_LANGS.includes(r.voiceLang) ? r.voiceLang : DEFAULT_SETTINGS.voiceLang,
    voiceOverrides: sanitizeVoiceOverrides(r.voiceOverrides),
    resolution: RESOLUTION_MODES.includes(r.resolution) ? r.resolution : DEFAULT_SETTINGS.resolution,
    muted: typeof r.muted === 'boolean' ? r.muted : DEFAULT_SETTINGS.muted,
    damageNumbers: typeof r.damageNumbers === 'boolean' ? r.damageNumbers : DEFAULT_SETTINGS.damageNumbers,
    officialDamageNumbers: typeof r.officialDamageNumbers === 'boolean' ? r.officialDamageNumbers : false,
    ammoCount: typeof r.ammoCount === 'boolean' ? r.ammoCount : DEFAULT_SETTINGS.ammoCount,
    quality: QUALITIES.includes(r.quality) ? r.quality : DEFAULT_SETTINGS.quality,
    // 性能模式: 只有显式 true 才算开（旧存档没有这个字段 ⇒ 关，行为和以前完全一样）
    performanceMode: r.performanceMode === true,
    // 乐观界面反馈: 只有显式 false 才算关（旧存档没有这个字段 ⇒ 开，这是已批准的默认）
    optimisticFeedback: r.optimisticFeedback !== false,
    textSize: TEXT_SIZES.includes(r.textSize) ? r.textSize : DEFAULT_SETTINGS.textSize,
    keys: sanitizeHotkeys(r.keys),
  };
}
