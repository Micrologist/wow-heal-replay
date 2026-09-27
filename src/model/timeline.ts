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
//
// Absorbs: WCL's snapshot `absorb` (total shield on the actor) is the authority. An event-based
// per-shield tracker agrees with it only ~50% of the time and runs low (passive absorbs never show
// up as shield buffs). Between snapshots, a shield `applybuff`/`refreshbuff` adds its amount right
// away so a fresh shield shows immediately; the next snapshot resets to WCL's exact total.
//
// Debuffs: intervals from ./debuffs.ts; `at(t)` returns the important ones active at t.

import type { FightData } from "../api/types.ts";
import { collectDebuffs, type DebuffInterval, type EncounterDebuffConfig, isImportant, lastAppliedAt, stacksAt } from "./debuffs.ts";
import { collectDeaths, collectHealthSamples, type Death, type HealthSample } from "./health.ts";
import { buildRoster, type Player } from "./roster.ts";

export const TICK_MS = 100;
export const STALE_MS = 10_000;
export const REVIVE_GRACE_MS = 1_000;
export const MAX_DEBUFF_ICONS = 3;

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
  /** at most MAX_DEBUFF_ICONS, most important first */
  debuffs: DebuffState[];
}

export interface DebuffState {
  abilityID: number;
  stacks: number;
  /** when the current application (or last refresh) started, and when it drops */
  from: number;
  until: number;
  /** 0..1 of the current application left */
  remaining: number;
}

export interface Ability {
  name: string;
  icon: string;
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
  /** name + icon for every ability id the log mentions */
  abilities: Map<number, Ability>;
  at(t: number): TimelineState;
}

interface Track {
  hp: Float64Array;
  maxHp: Float64Array;
  absorb: Float64Array;
  flags: Uint8Array;
}

interface ShieldApply {
  t: number;
  amount: number;
}

function buildTrack(samples: HealthSample[], deaths: Death[], shields: ShieldApply[], tickCount: number, tickMs: number): Track {
  const track: Track = {
    hp: new Float64Array(tickCount),
    maxHp: new Float64Array(tickCount),
    absorb: new Float64Array(tickCount),
    flags: new Uint8Array(tickCount),
  };
  // One ordered stream per actor. Same ms: sample, then shield, then death.
  type Ev = { t: number; order: number; sample?: HealthSample; shield?: ShieldApply };
  const events: Ev[] = [
    ...samples.map((sample) => ({ t: sample.t, order: 0, sample })),
    ...shields.map((shield) => ({ t: shield.t, order: 1, shield })),
    ...deaths.map((d) => ({ t: d.t, order: 2 })),
  ].sort((a, b) => a.t - b.t || a.order - b.order);

  const firstMax = samples.find((s) => s.maxHp > 0)?.maxHp ?? 1;
  let hp = firstMax;
  let maxHp = firstMax;
  let absorb = 0;
  let dead = false;
  let deathT = -Infinity;
  let lastSampleT = 0;
  let ei = 0;

  for (let tick = 0; tick < tickCount; tick++) {
    const now = tick * tickMs;
    for (; ei < events.length && events[ei].t <= now; ei++) {
      const ev = events[ei];
      if (ev.sample) {
        const s = ev.sample;
        if (dead && !(s.t >= deathT + REVIVE_GRACE_MS && s.hp > 0)) continue; // corpses stay dead until a real revive
        dead = false;
        maxHp = s.maxHp > 0 ? s.maxHp : maxHp;
        hp = Math.min(Math.max(0, s.hp), maxHp);
        absorb = s.absorb;
        lastSampleT = s.t;
      } else if (ev.shield) {
        if (!dead && ev.t > lastSampleT) absorb += ev.shield.amount;
      } else {
        dead = true;
        deathT = ev.t;
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

function collectShieldApplies(data: FightData, ids: ReadonlySet<number>): Map<number, ShieldApply[]> {
  const out = new Map<number, ShieldApply[]>();
  for (const e of data.events.Buffs ?? []) {
    if ((e.type !== "applybuff" && e.type !== "refreshbuff") || typeof e.absorb !== "number" || e.absorb <= 0) continue;
    const target = e.targetID as number;
    if (!ids.has(target)) continue;
    let list = out.get(target);
    if (!list) out.set(target, (list = []));
    list.push({ t: e.timestamp - data.fight.startTime, amount: e.absorb });
  }
  return out;
}

export interface TimelineOptions {
  tickMs?: number;
  /** per-encounter overrides from src/data/encounters/<encounterID>.json */
  debuffs?: EncounterDebuffConfig;
}

function debuffPriority(iv: DebuffInterval, config: EncounterDebuffConfig, t: number): number {
  const pinned = config.important?.includes(iv.abilityID) ? 1e9 : 0;
  return pinned + stacksAt(iv, t) * 1e6 - (iv.end - t);
}

export function buildTimeline(data: FightData, opts: TimelineOptions = {}): Timeline {
  const tickMs = opts.tickMs ?? TICK_MS;
  const durationMs = data.fight.endTime - data.fight.startTime;
  const tickCount = Math.floor(durationMs / tickMs) + 1;
  const actors = buildRoster(data);
  const ids = new Set(actors.map((a) => a.id));
  const samples = collectHealthSamples(data, ids);
  const allDeaths = collectDeaths(data).filter((d) => ids.has(d.actorID));
  const shields = collectShieldApplies(data, ids);
  const tracks = actors.map((a) =>
    buildTrack(samples.get(a.id) ?? [], allDeaths.filter((d) => d.actorID === a.id), shields.get(a.id) ?? [], tickCount, tickMs),
  );
  const names = new Map(actors.map((a) => [a.id, a.name]));
  const debuffConfig = opts.debuffs ?? {};
  const debuffsByActor = new Map<number, DebuffInterval[]>(actors.map((a) => [a.id, []]));
  for (const iv of collectDebuffs(data, ids)) if (isImportant(iv, debuffConfig)) debuffsByActor.get(iv.targetID)!.push(iv);
  const abilities = new Map(data.report.masterData.abilities.map((a) => [a.gameID, { name: a.name, icon: a.icon }]));

  return {
    durationMs,
    tickMs,
    tickCount,
    actors,
    deaths: allDeaths.map((d) => ({ ...d, name: names.get(d.actorID)! })),
    abilities,
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
        const now = tick * tickMs;
        const debuffs = dead ? [] : debuffsByActor.get(a.id)!
          .filter((iv) => iv.start <= now && now < iv.end)
          .sort((x, y) => debuffPriority(y, debuffConfig, now) - debuffPriority(x, debuffConfig, now))
          .slice(0, MAX_DEBUFF_ICONS)
          .map((iv): DebuffState => {
            const from = lastAppliedAt(iv, now);
            return { abilityID: iv.abilityID, stacks: stacksAt(iv, now), from, until: iv.end, remaining: iv.end > from ? (iv.end - now) / (iv.end - from) : 0 };
          });
        return { id: a.id, hp, maxHp, pct: maxHp > 0 ? Math.min(1, hp / maxHp) : 0, absorb: tr.absorb[tick], dead, stale: (tr.flags[tick] & STALE) !== 0, debuffs };
      });
      return { t: tick * tickMs, actors: states, alive, raidPct: maxSum > 0 ? hpSum / maxSum : 0 };
    },
  };
}
