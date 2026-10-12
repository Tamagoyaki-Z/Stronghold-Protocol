// 皮肤选择器 (docs/SKINS.md) — the 皮肤 section of the 干员调配 screen's detail panel.
//
// All 174 skins are built-in. Operators without skins return null silently.
// Outside match only: changes are persisted to localStorage and mirrored via room.skins.

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, MicroLabel } from './components.js';
import { useStore, shallowEqual } from '../store.js';
import { data } from '../data.js';
import { t } from '../../../shared/i18n.js';
import { skinsStore, availableSkins, loadSkinData, setSkin, clearSkin, roomAvatarOf, setRoomAvatar, clearRoomAvatar, roomAvatarUrl } from './skins.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/**
 * The installed skin's 180×180 avatar URL, or null.
 *
 * Keyed by OPERATOR id, not by chess id: data/assets.json groups everything under `chars[charId]`.
 */
function skinAvatar(charId, skinId) {
  return data.get('assets')?.chars?.[charId]?.skins?.[skinId]?.avatar || null;
}

/**
 * The 房间头像 action of one art in the 皮肤 section (user decision 2026-10-13: 「b，但是写在干员调配换皮肤的界面」).
 *
 * The avatar is a REFERENCE (`{ chessId, skinId }`, shared/protocol.js isRoomAvatar) to the very art this button
 * sits on, so a player points at a picture instead of typing an id. The current choice is marked here; the row at
 * the top of the section previews what the rest of the room sees.
 * @param {{ chessId: string, skinId: string|null, chosen: boolean, onPick: Function }} props
 */
function RoomAvatarButton({ chessId, skinId, chosen, onPick }) {
  return html`<button type="button" class=${cx('lo-skin__avatar', chosen && 'is-on')} data-room-avatar=${skinId || ''}
      aria-pressed=${chosen ? 'true' : 'false'} title=${t('设为房间头像')}
      onClick=${(e) => { e.stopPropagation(); onPick(chessId, skinId); }}>
    ${chosen ? html`<${MicroLabel}>${t('房间头像')}<//>` : html`<span aria-hidden="true">◎</span>`}
  </button>`;
}

/**
 * 皮肤 section for one operator.
 * @param {{ chess: any }} props `chess` is the chess record of the detail panel
 */
export function SkinSection({ chess }) {
  const s = useStore((v) => v, shallowEqual, skinsStore);
  const [, bump] = useState(0);

  // 皮肤按「基础棋子」记录（与服务端 server/lobby.js freezeSkins 和对局渲染 public/js/render/app.js
  // `skinFor(baseId) ?? skinFor(piece.id)` 同一口径）：精锐（精锐卡）的 baseId 指向基础卡，
  // 而服务端会丢弃 isGolden 的键，所以这里必须用 baseId —— 否则在精锐卡上选的皮肤既不生效，
  // 换个卡看还会显示成「默认」，看起来像没保存。
  const chessId = (chess && (chess.baseId || chess.chessId)) || null;
  const charId = chess && chess.charId;
  const rawChessId = chess && chess.chessId;

  // 旧版本把选择记在精锐 id 下（服务端不会采用）：打开面板时搬到基础 id，避免玩家重调一次。
  useEffect(() => {
    if (!chessId || !rawChessId || rawChessId === chessId) return;
    const entries = skinsStore.get().entries;
    const legacy = entries[rawChessId];
    if (legacy && !entries[chessId]) { setSkin(chessId, legacy); clearSkin(rawChessId); }
    else if (legacy && entries[chessId]) clearSkin(rawChessId);
  }, [chessId, rawChessId]);

  useEffect(() => {
    let dead = false;
    loadSkinData();
    const off = data.subscribe?.(() => { if (!dead) bump((n) => n + 1); });
    const t = setInterval(() => { if (!dead) bump((n) => n + 1); }, 500);
    return () => { dead = true; clearInterval(t); off?.(); };
  }, [chessId]);

  if (!chessId || !charId) return null;
  const skinsReady = data.status('skins') === 'ready';
  if (!skinsReady) {
    return html`<section class="lo-sec lo-sec--skin" data-testid="skin-section">
      <header class="lo-sec__head">
        <h3>${t('皮肤')}<${MicroLabel}>SKIN<//></h3>
        <span class="lo-sec__note">${t('正在载入配置…')}</span>
      </header>
    </section>`;
  }

  const list = availableSkins(charId);
  if (!list.length) return null; // 确认加载完且真无皮肤才隐藏

  const chosen = s.entries[chessId] || null;
  const defaultArt = data.get('assets')?.chars?.[charId]?.avatar || null;
  // 房间头像: the reference is per operator + skin, so exactly one card in this section can carry the mark
  const avatar = roomAvatarOf();
  const isAvatar = (sid) => !!avatar && avatar.chessId === chessId && (avatar.skinId ?? null) === sid;
  const avatarArt = roomAvatarUrl(data.get('assets'), avatar);

  return html`<section class="lo-sec lo-sec--skin" data-testid="skin-section">
    <header class="lo-sec__head">
      <h3>${t('皮肤')}<${MicroLabel}>SKIN<//></h3>
      <span class="lo-sec__note">${t('{n} 款可选', { n: list.length })}</span>
    </header>
    <div class="lo-skins-avatar" data-testid="room-avatar-row">
      <span class="lo-skins-avatar__label"><${MicroLabel}>ROOM AVATAR<//>${t('房间头像')}</span>
      ${avatar
        ? html`<span class="lo-skins-avatar__art" title=${t('房间头像')}>
            ${avatarArt ? html`<img src=${avatarArt} alt="" />` : html`<span aria-hidden="true">?</span>`}
          </span>
          <span class="lo-skins-avatar__hint">${t('房间里其他人看到的就是这张')}</span>
          <button type="button" class="lo-skins-avatar__clear" data-clear-room-avatar="1"
            onClick=${() => clearRoomAvatar()}>${t('取消房间头像')}</button>`
        : html`<span class="lo-skins-avatar__hint">${t('未设置：房间座位卡显示默认头像')}</span>`}
    </div>
    <div class="lo-skins" role="radiogroup" aria-label=${t('选择皮肤')}>
      <button type="button" role="radio" aria-checked=${chosen ? 'false' : 'true'} data-skin=""
        class=${cx('lo-skin', 'lo-skin--default', !chosen && 'is-on')} onClick=${() => clearSkin(chessId)}>
        <span class="lo-skin__art">
          ${defaultArt
            ? html`<img src=${defaultArt} alt="" loading="lazy" />`
            : html`<span class="lo-skin__art--none"></span>`}
        </span>
        <span class="lo-skin__text">
          <b class="lo-skin__name">${t('默认')}</b>
          <span class="lo-skin__group">DEFAULT</span>
        </span>
        ${!chosen ? html`<span class="lo-skin__badge">${t('已装配')}</span>` : null}
        <${RoomAvatarButton} chessId=${chessId} skinId=${null} chosen=${isAvatar(null)} onPick=${setRoomAvatar} />
      </button>
      ${list.map((x) => {
        const art = skinAvatar(charId, x.id) || defaultArt;
        const isEquipped = chosen === x.id;
        return html`<button key=${x.id} type="button" role="radio" aria-checked=${isEquipped ? 'true' : 'false'}
            data-skin=${x.id}
            class=${cx('lo-skin', isEquipped && 'is-on')}
            onClick=${() => setSkin(chessId, x.id)}>
          <span class="lo-skin__art">
            ${art
              ? html`<img src=${art} alt="" loading="lazy" onError=${(e) => {
                  if (defaultArt && e.currentTarget.src !== defaultArt) {
                    e.currentTarget.src = defaultArt;
                  }
                }} />`
              : html`<span class="lo-skin__art--none"></span>`}
          </span>
          <span class="lo-skin__text">
            <b class="lo-skin__name">${x.name}</b>
            <span class="lo-skin__group">${x.group || 'SPECIAL'}</span>
          </span>
          ${isEquipped ? html`<span class="lo-skin__badge">${t('已装配')}</span>` : null}
          <${RoomAvatarButton} chessId=${chessId} skinId=${x.id} chosen=${isAvatar(x.id)} onPick=${setRoomAvatar} />
        </button>`;
      })}
    </div>
  </section>`;
}
