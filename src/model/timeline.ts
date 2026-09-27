// The Timeline: per-actor state precomputed on a fixed tick grid, so `at(t)` is an array lookup
// and scrubbing is instant. Pure and deterministic: FightData in, Timeline out. The renderer
// only ever reads `at(t)` (CLAUDE.md §3).
//
// Health rules (CLAUDE.md §5, checked against the fixtures):
// - before an actor's first sample: full HP (fight start → assume full)
// - between samples: hold the last value, never interpolate
// - death event → HP 0, dead until a sample with HP > 0 at least REVIVE_GRACE_MS later (a resurrect
//   takes a cast; in the fixtures the first sample after a death is always ≥ 2.5 s later, so this
//   only guards against a stale snapshot logged just after the killing blow)
// - HP is clamped to max HP (samples occasionally exceed it by ~1%, e.g. as a max-HP buff drops)
// - tick i is the state at i·TICK_MS: `at(t)` never shows events later than t
// - alive with no sample for > STALE_MS → `stale` (out of logging range, or simply untouched);
//   the dead are never stale, they just stop producing events

import type { FightData } from "../api/types.ts";
import { collectDeaths, collectHealthSamples, type Death, type HealthSample } from "./health.ts";
import { buildRoster, type Player } from "./roster.ts";

export const TICK_MS = 100;
export const STALE_MS = 10_000;
export const REVIVE_GRACE_MS = 1_000;

const DEAD = 1;
const STALE = 2;

export interface ActorState {
  id: number;
  hp: number;
  maxHp: number;
  /** 0..1 */
  pct: number;
  absorb: number;
  dead: boolean;
  stale: boolean;
}

export interface TimelineState {
  /** ms since fight start, snapped to the tick */
  t: number;
  actors: ActorState[];
  alive: number;
  /** sum(hp) / sum(maxHp) over all tracked actors, dead counting as 0 */
  raidPct: number;
}

export interface Timeline {
  durationMs: number;
  tickMs: number;
  tickCount: number;
  actors: Player[];
  deaths: (Death & { name: string })[];
  at(t: number): TimelineState;
}

interface Track {
  hp: Float64Array;
  maxHp: Float64Array;
  absorb: Float64Array;
  flags: Uint8Array;
}

function buildTrack(samples: HealthSample[], deaths: Death[], tickCount: number, tickMs: number): Track {
  const track: Track = {
    hp: new Float64Array(tickCount),
    maxHp: new Float64Array(tickCount),
    absorb: new Float64Array(tickCount),
    flags: new Uint8Array(tickCount),
  };
  const firstMax = samples.find((s) => s.maxHp > 0)?.maxHp ?? 1;
  let hp = firstMax;
  let maxHp = firstMax;
  let absorb = 0;
  let dead = false;
  let deathT = -Infinity;
  let lastSampleT = 0;
  let si = 0;
  let di = 0;

  for (let tick = 0; tick < tickCount; tick++) {
    const now = tick * tickMs;
    // Apply everything up to and including `now`, samples and deaths in time order
    // (a death and a sample at the same ms: the sample first, then the death).
    while ((si < samples.length && samples[si].t <= now) || (di < deaths.length && deaths[di].t <= now)) {
      const takeSample = si < samples.length && samples[si].t <= now && (di >= deaths.length || samples[si].t <= deaths[di].t);
      if (takeSample) {
        const s = samples[si++];
        if (dead && !(s.t >= deathT + REVIVE_GRACE_MS && s.hp > 0)) continue; // corpses stay dead until a real revive
        dead = false;
        maxHp = s.maxHp > 0 ? s.maxHp : maxHp;
        hp = Math.min(Math.max(0, s.hp), maxHp);
        absorb = s.absorb;
        lastSampleT = s.t;
      } else {
        const d = deaths[di++];
        dead = true;
        deathT = d.t;
        hp = 0;
        absorb = 0;
      }
    }
    track.hp[tick] = hp;
    track.maxHp[tick] = maxHp;
    track.absorb[tick] = absorb;
    track.flags[tick] = (dead ? DEAD : 0) | (!dead && now - lastSampleT > STALE_MS ? STALE : 0);
  }
  return track;
}

export function buildTimeline(data: FightData, tickMs = TICK_MS): Timeline {
  const durationMs = data.fight.endTime - data.fight.startTime;
  const tickCount = Math.floor(durationMs / tickMs) + 1;
  const actors = buildRoster(data);
  const ids = new Set(actors.map((a) => a.id));
  const samples = collectHealthSamples(data, ids);
  const allDeaths = collectDeaths(data).filter((d) => ids.has(d.actorID));
  const tracks = actors.map((a) =>
    buildTrack(samples.get(a.id) ?? [], allDeaths.filter((d) => d.actorID === a.id), tickCount, tickMs),
  );
  const names = new Map(actors.map((a) => [a.id, a.name]));

  return {
    durationMs,
    tickMs,
    tickCount,
    actors,
    deaths: allDeaths.map((d) => ({ ...d, name: names.get(d.actorID)! })),
    at(t: number): TimelineState {
      const tick = Math.min(tickCount - 1, Math.max(0, Math.floor(t / tickMs)));
      let hpSum = 0;
      let maxSum = 0;
      let alive = 0;
      const states = actors.map((a, i) => {
        const tr = tracks[i];
        const hp = tr.hp[tick];
        const maxHp = tr.maxHp[tick];
        const dead = (tr.flags[tick] & DEAD) !== 0;
        hpSum += hp;
        maxSum += maxHp;
        if (!dead) alive++;
        return { id: a.id, hp, maxHp, pct: maxHp > 0 ? Math.min(1, hp / maxHp) : 0, absorb: tr.absorb[tick], dead, stale: (tr.flags[tick] & STALE) !== 0 };
      });
      return { t: tick * tickMs, actors: states, alive, raidPct: maxSum > 0 ? hpSum / maxSum : 0 };
    },
  };
}
