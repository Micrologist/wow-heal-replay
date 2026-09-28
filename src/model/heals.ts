// Healing done per healer, pets and totems credited to their owner. Pure.
//
// Effective healing = `heal.amount` (already excludes overheal) + `absorbed.amount` (damage soaked
// by the healer's shields). On the fixtures this matches the Summary table's `healingDone` within
// −0.6…+3.2% for all 8 healers; heals alone are 15–20% short because shields are real healing.

import type { FightData } from "../api/types.ts";

export interface HealEvent {
  t: number;
  /** the healer (owner, when a pet/totem did it) */
  healerID: number;
  /** the pet/totem that did it, if not the healer */
  viaID: number | null;
  abilityID: number;
  targetID: number;
  /** effective */
  amount: number;
  overheal: number;
  kind: "heal" | "absorb";
  tick: boolean;
}

export function petOwners(data: FightData): Map<number, number> {
  const out = new Map<number, number>();
  for (const a of data.report.masterData.actors) if (a.petOwner !== null) out.set(a.id, a.petOwner);
  return out;
}

export function collectHeals(data: FightData, healerIDs: ReadonlySet<number>): HealEvent[] {
  const t0 = data.fight.startTime;
  const owners = petOwners(data);
  const out: HealEvent[] = [];
  for (const e of data.events.Healing ?? []) {
    if (e.type !== "heal" && e.type !== "absorbed") continue;
    const src = e.sourceID as number;
    const healerID = owners.get(src) ?? src;
    if (!healerIDs.has(healerID)) continue;
    out.push({
      t: e.timestamp - t0,
      healerID,
      viaID: healerID === src ? null : src,
      abilityID: e.abilityGameID as number,
      targetID: e.targetID as number,
      amount: typeof e.amount === "number" ? e.amount : 0,
      overheal: typeof e.overheal === "number" ? e.overheal : 0,
      kind: e.type === "heal" ? "heal" : "absorb",
      tick: e.tick === true,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}
