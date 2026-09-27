// HP samples and deaths from raw events. Pure: FightData in, arrays out.
//
// WCL has no per-tick HP. With `includeResources`, many events carry a snapshot of one actor's
// state after the event: `hitPoints`, `maxHitPoints`, `absorb` (total shield). `resourceActor`
// says whose: 1 = the event's source, 2 = its target, absent = no snapshot. Every stream has
// them (Healing, DamageTaken, Casts, Resources…), so all streams are sampled, not just two.

import type { FightData, RawEvent } from "../api/types.ts";

export interface HealthSample {
  /** ms since fight start */
  t: number;
  hp: number;
  maxHp: number;
  /** total absorb shield on the actor at this moment, as WCL reports it */
  absorb: number;
}

export interface Death {
  t: number;
  actorID: number;
  killerID: number | null;
  abilityID: number | null;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Whose state an event's snapshot describes, or undefined if it carries none. */
export function snapshotActor(e: RawEvent): number | undefined {
  if (num(e.hitPoints) === undefined || num(e.maxHitPoints) === undefined) return undefined;
  if (e.resourceActor === 1) return num(e.sourceID);
  if (e.resourceActor === 2) return num(e.targetID);
  return undefined;
}

/** Samples per actor (only `actorIDs`), sorted by time; ties keep stream order. */
export function collectHealthSamples(data: FightData, actorIDs: ReadonlySet<number>): Map<number, HealthSample[]> {
  const t0 = data.fight.startTime;
  const out = new Map<number, HealthSample[]>();
  for (const events of Object.values(data.events)) {
    for (const e of events) {
      const actor = snapshotActor(e);
      if (actor === undefined || !actorIDs.has(actor)) continue;
      let list = out.get(actor);
      if (!list) out.set(actor, (list = []));
      list.push({ t: e.timestamp - t0, hp: e.hitPoints as number, maxHp: e.maxHitPoints as number, absorb: num(e.absorb) ?? 0 });
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.t - b.t);
  return out;
}

export function collectDeaths(data: FightData): Death[] {
  const t0 = data.fight.startTime;
  return (data.events.Deaths ?? [])
    .filter((e) => e.type === "death" && num(e.targetID) !== undefined)
    .map((e) => ({
      t: e.timestamp - t0,
      actorID: e.targetID as number,
      killerID: num(e.killerID) ?? null,
      abilityID: num(e.killingAbilityGameID) ?? null,
    }))
    .sort((a, b) => a.t - b.t);
}
