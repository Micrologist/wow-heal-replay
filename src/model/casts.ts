// Casts as intervals per caster: "who is casting what on whom". Pure.
//
// From the fixtures:
// - `begincast` (and Evoker `empowerstart`) never carries a target (`targetID: -1`); the completing
//   `cast` (or `empowerend`) does. A replay knows the future, so a cast in progress shows the target
//   of the `cast` that completes it.
// - `fake: true` casts are procs the player never pressed (Reclamation, Twin Flame, Soul Fragment):
//   ignored.
// - A new begincast while one is pending means the pending one was interrupted/cancelled. An instant
//   `cast` of a different spell does not end a pending hard cast (off-GCD instants happen mid-cast).
// - A begincast → cast pair under INSTANT_PAIR_MS apart is an instant proc that still logs a
//   begincast (Infusion-of-Light Flash of Light, instant Chain Heal/Vivify…): 20–30% of all pairs in
//   the fixtures are 0–49 ms, real cast times start around 300 ms. Those count as instants.
// - Channels (cast + buff on the caster) are not special-cased yet.

import type { FightData } from "../api/types.ts";

export type CastKind = "hardcast" | "instant";

export interface CastInterval {
  sourceID: number;
  abilityID: number;
  /** null: no target (AoE, self-centred, ground-targeted) */
  targetID: number | null;
  start: number;
  /** hard casts: when the cast finished or was interrupted; instants: = start */
  end: number;
  kind: CastKind;
  interrupted: boolean;
}

/** A pending hard cast older than this is assumed abandoned (logging gap). */
export const MAX_CAST_MS = 10_000;
export const INSTANT_PAIR_MS = 50;
/** `empowerend` is often followed by a `cast` of the same spell; don't count it twice. */
const EMPOWER_ECHO_MS = 250;

export function collectCasts(data: FightData, sourceIDs: ReadonlySet<number>): CastInterval[] {
  const t0 = data.fight.startTime;
  const out: CastInterval[] = [];
  const pending = new Map<number, { abilityID: number; start: number }>();
  const lastEmpowerEnd = new Map<number, { abilityID: number; t: number }>();
  const target = (id: unknown) => (typeof id === "number" && id >= 0 ? id : null);

  const interrupt = (sourceID: number, t: number) => {
    const p = pending.get(sourceID);
    if (!p) return;
    pending.delete(sourceID);
    out.push({ sourceID, abilityID: p.abilityID, targetID: null, start: p.start, end: Math.min(t, p.start + MAX_CAST_MS), kind: "hardcast", interrupted: true });
  };

  for (const e of data.events.Casts ?? []) {
    const sourceID = e.sourceID as number;
    if (!sourceIDs.has(sourceID) || e.fake) continue;
    const t = e.timestamp - t0;
    const abilityID = e.abilityGameID as number;
    switch (e.type) {
      case "begincast":
      case "empowerstart":
        interrupt(sourceID, t);
        pending.set(sourceID, { abilityID, start: t });
        break;
      case "cast":
      case "empowerend": {
        const echo = lastEmpowerEnd.get(sourceID);
        if (e.type === "cast" && echo && echo.abilityID === abilityID && t - echo.t <= EMPOWER_ECHO_MS) break;
        if (e.type === "empowerend") lastEmpowerEnd.set(sourceID, { abilityID, t });
        const p = pending.get(sourceID);
        if (p && p.abilityID === abilityID && t - p.start <= MAX_CAST_MS) {
          pending.delete(sourceID);
          const instant = t - p.start < INSTANT_PAIR_MS;
          out.push({ sourceID, abilityID, targetID: target(e.targetID), start: instant ? t : p.start, end: t, kind: instant ? "instant" : "hardcast", interrupted: false });
        } else {
          out.push({ sourceID, abilityID, targetID: target(e.targetID), start: t, end: t, kind: "instant", interrupted: false });
        }
        break;
      }
    }
  }
  for (const id of [...pending.keys()]) interrupt(id, data.fight.endTime - t0);
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}
