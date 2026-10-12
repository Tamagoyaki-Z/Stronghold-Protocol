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

/**
 * The pool-copy scale of one fixed group: the share of the four-person baseline it fields.
 *
 * Proportional in BOTH directions (user decision 2026-10-13: the 3-person group was taking a full four-person
 * pool, so 6 seats = 3 + 3 handed each half-room the whole baseline and per-head supply went UP): a 3-person
 * group fields 0.75x and a 5-person group 1.25x. One exception is kept: a room below the four-person baseline
 * (a solo or duo run) keeps the complete pool, because `max(1, .)` is what those rooms have always had. Three
 * is the smallest group the fixed layouts can produce (6 seats = 3 + 3), so only a real group is scaled down.
 */
export const poolCopyScale = (groupSize) => groupSize / BASE_SEATS;

/**
 * How many copies one GROUP actually fields: `poolCopyScale` with the below-baseline floor applied.
 *
 * Only a real fixed group is ever scaled down. Three is the smallest the layouts can produce (6 seats = 3 + 3),
 * so in practice a 3-person group gets 0.75x while a room below the four-person baseline (solo / duo, whose
 * layouts are [1] and [2]) keeps the complete four-person pool — the behaviour those rooms always had. The
 * floor lives here, and only here, so `poolCopyScale(3)` stays the honest 0.75 while every consumer of the
 * actual sizes shares one definition.
 */
export const poolGroupScale = (groupSize) => (groupSize >= 3 ? poolCopyScale(groupSize) : 1);

/**
 * Copies of one pool entry at `scale`: the group's share of the four-person baseline.
 *
 * Rounding is the fork's existing convention (docs/PLAYER_CAPACITY.md, D028), generalised to every scale
 * so that "a group of N is worth N/4 of the baseline" holds above and below 1 alike:
 *   * tier III is FLOORED — the measured 0.2.4 identity (36 at scale 1) is a ceiling for that tier, so a
 *     five-person group's 36 * 1.25 = 45 and a three-person group's 36 * 0.75 = 27;
 *   * every other tier is CEILED, and identity overrides follow the same rule
 *     (the measured `poolCopiesOverrides` values are the shipped numbers, never rounded below).
 *
 * A zero copy count drops the chess from the group's pool (SharedPool's `cap <= 0` guard): at 0.75 no
 * tier reaches zero, the floor only matters for a future scale below 1/10.
 * @param {number} base the four-person baseline count of one chess / equipment
 * @param {number} scale the group's share of BASE_SEATS (`poolCopyScale`)
 * @param {number} tier the chess's tier (1-6); equipment passes 0
 */
export function scaleCopies(base, scale, tier) {
  const scaled = base * scale;
  return tier === 3 ? Math.floor(scaled) : Math.ceil(scaled);
}

/** The opening pool-group count sets the Unite limit; later departures never lower it. */
export const uniteRoundLimit = (poolGroupCount) => Number.isInteger(poolGroupCount)
  ? Math.max(1, Math.min(MAX_UNITE_ROUNDS, poolGroupCount)) : 1;

/** Keep the original <=4 player unlock requirement; larger teams need proportionally more layers. */
export const coopHiddenLayerThreshold = (baseline, players) => Math.ceil(baseline * Math.max(1, players / BASE_SEATS));
