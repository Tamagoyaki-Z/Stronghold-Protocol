// Capacity rules shared by the server and browser. See docs/PLAYER_CAPACITY.md for the fork's rules.
import { BASE_SEATS, MAX_SEATS, MAX_DRAFT_CARDS } from './constants.js';

export const MIN_COOP_DRAFT_CARDS = MAX_DRAFT_CARDS;
export const GROUPED_POOL_MIN_PLAYERS = 6;
export const MAX_UNITE_ROUNDS = 5;
export const MAX_UNITE_HELPERS = MAX_UNITE_ROUNDS * 2;

/** Each fixed co-op group has its own six-card page, independent of room or living-player count. */
export function coopDraftCardCount() { return MIN_COOP_DRAFT_CARDS; }

// User-approved seat-ordered groups. Return a copy so callers cannot alter later matches.
const POOL_GROUP_LAYOUTS = {
  6: [3, 3],
  7: [4, 3],
  8: [4, 4],
  9: [4, 5],
  10: [4, 3, 3],
  11: [4, 4, 3],
  12: [4, 4, 4],
  13: [5, 4, 4],
  14: [4, 4, 3, 3],
  15: [4, 4, 4, 3],
  16: [4, 4, 4, 4],
  17: [5, 4, 4, 4],
  18: [4, 4, 4, 3, 3],
  19: [4, 4, 4, 4, 3],
  20: [4, 4, 4, 4, 4],
};

/** One shared pool for up to five; six or more use fixed groups of three, four or five. */
export function poolGroupSizes(players) {
  if (!Number.isInteger(players) || players < 1 || players > MAX_SEATS) throw new RangeError('invalid player count');
  if (players < GROUPED_POOL_MIN_PLAYERS) return [players];
  return POOL_GROUP_LAYOUTS[players].slice();
}

/**
 * The 0-based fixed pool group a seat belongs to, or -1 without a valid seat and occupied count. Groups follow
 * the occupied SEAT order (the same order server/match/pool.js createPoolGroups uses), so the room's seat cards
 * can label them before the match exists. `poolGroupSizes` throws on an unknown count: -1 instead.
 */
export function poolGroupOf(seat, occupied) {
  if (!Number.isInteger(seat) || seat < 0) return -1;
  let sizes;
  try { sizes = poolGroupSizes(occupied); } catch { return -1; }
  let offset = 0;
  for (let g = 0; g < sizes.length; g++) {
    offset += sizes[g];
    if (seat < offset) return g;
  }
  return -1;
}

/** A three-player group keeps the complete original pool; only a five-player group expands. */
export const poolCopyScale = (groupSize) => Math.max(1, groupSize / BASE_SEATS);

/** The opening pool-group count sets the Unite limit; later departures never lower it. */
export const uniteRoundLimit = (poolGroupCount) => Number.isInteger(poolGroupCount)
  ? Math.max(1, Math.min(MAX_UNITE_ROUNDS, poolGroupCount)) : 1;

/** Keep the original <=4 player unlock requirement; larger teams need proportionally more layers. */
export const coopHiddenLayerThreshold = (baseline, players) => Math.ceil(baseline * Math.max(1, players / BASE_SEATS));
