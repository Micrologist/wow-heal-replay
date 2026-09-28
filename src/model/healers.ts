// Per-healer state at time t: current cast, recent heals, healing done so far, mana. Pure.

import type { FightData } from "../api/types.ts";
import { type CastInterval, collectCasts } from "./casts.ts";
import { collectHeals, type HealEvent } from "./heals.ts";

export const INSTANT_FLASH_MS = 400;
export const RECENT_HEALS_MS = 5_000;
export const MAX_RECENT_HEALS = 8;
const MANA = 0; // classResources type for mana

export interface CastState extends CastInterval {
  /** 0..1 through a hard cast; 1 while an instant (or a just-finished cast) flashes */
  progress: number;
  /** false while the hard cast is still going */
  finished: boolean;
}

export interface HealerState {
  id: number;
  cast: CastState | null;
  /** last RECENT_HEALS_MS, newest first, at most MAX_RECENT_HEALS */
  recent: HealEvent[];
  healingDone: number;
  /** healing done / elapsed seconds */
  hps: number;
  /** 0..1, null until the first mana snapshot */
  mana: number | null;
}

/** Index of the first element with key > t (elements sorted by key). */
function upperBound<T>(arr: T[], t: number, key: (x: T) => number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface HealerTrack {
  casts: CastInterval[];
  heals: HealEvent[];
  /** cumulative effective healing after heals[i] */
  cumulative: Float64Array;
  mana: { t: number; pct: number }[];
}

function manaSamples(data: FightData, id: number): { t: number; pct: number }[] {
  const out: { t: number; pct: number }[] = [];
  for (const events of Object.values(data.events)) {
    for (const e of events) {
      const owner = e.resourceActor === 1 ? e.sourceID : e.resourceActor === 2 ? e.targetID : undefined;
      if (owner !== id || !Array.isArray(e.classResources)) continue;
      const r = (e.classResources as { type: number; amount: number; max: number }[]).find((c) => c.type === MANA);
      if (r && r.max > 0) out.push({ t: e.timestamp - data.fight.startTime, pct: Math.min(1, Math.max(0, r.amount / r.max)) });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface Healers {
  ids: number[];
  at(id: number, t: number): HealerState;
  /** all casts of a healer (for later: cooldown tracking, contribution view) */
  casts(id: number): CastInterval[];
  heals(id: number): HealEvent[];
}

export function buildHealers(data: FightData, healerIDs: number[]): Healers {
  const ids = new Set(healerIDs);
  const casts = collectCasts(data, ids);
  const heals = collectHeals(data, ids);
  const tracks = new Map<number, HealerTrack>();
  for (const id of healerIDs) {
    const hs = heals.filter((h) => h.healerID === id);
    const cumulative = new Float64Array(hs.length);
    let sum = 0;
    hs.forEach((h, i) => (cumulative[i] = sum += h.amount));
    tracks.set(id, { casts: casts.filter((c) => c.sourceID === id), heals: hs, cumulative, mana: manaSamples(data, id) });
  }

  return {
    ids: healerIDs,
    casts: (id) => tracks.get(id)?.casts ?? [],
    heals: (id) => tracks.get(id)?.heals ?? [],
    at(id, t) {
      const tr = tracks.get(id);
      if (!tr) return { id, cast: null, recent: [], healingDone: 0, hps: 0, mana: null };

      // Current cast: a hard cast in progress wins; else the latest cast that ended < flash ago.
      let cast: CastState | null = null;
      const started = upperBound(tr.casts, t, (c) => c.start);
      for (let i = started - 1; i >= 0 && i >= started - 8; i--) {
        const c = tr.casts[i];
        if (c.kind === "hardcast" && t < c.end) {
          cast = { ...c, progress: (t - c.start) / Math.max(1, c.end - c.start), finished: false };
          break;
        }
        if (t - c.end < INSTANT_FLASH_MS && (!cast || c.end > cast.end)) cast = { ...c, progress: 1, finished: true };
      }

      const n = upperBound(tr.heals, t, (h) => h.t);
      const recent: HealEvent[] = [];
      for (let i = n - 1; i >= 0 && recent.length < MAX_RECENT_HEALS && t - tr.heals[i].t <= RECENT_HEALS_MS; i--) recent.push(tr.heals[i]);
      const healingDone = n > 0 ? tr.cumulative[n - 1] : 0;

      const m = upperBound(tr.mana, t, (s) => s.t);
      return { id, cast, recent, healingDone, hps: healingDone / Math.max(1, t / 1000), mana: m > 0 ? tr.mana[m - 1].pct : null };
    },
  };
}
