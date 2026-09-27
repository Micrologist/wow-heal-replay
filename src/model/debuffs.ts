// Debuffs on raid members as intervals, and which ones deserve a frame icon. Pure.
//
// WCL events carry no aura duration, but a replay knows the whole log: an aura's real lifetime is
// its apply → remove interval, so the sweep shows time until it actually drops (a dispel included).
// Dispel type (magic/curse/…) is not in the log; ability `type` is the spell school.

import type { FightData } from "../api/types.ts";

export interface DebuffInterval {
  targetID: number;
  abilityID: number;
  sourceID: number | null;
  /** first applied (ms since fight start; 0 if it was already up at the pull) */
  start: number;
  /** removed, or fight end */
  end: number;
  /** apply + refresh times: the sweep restarts at the latest one */
  applied: number[];
  /** (t, stacks) changes, first entry at `start` */
  stacks: { t: number; n: number }[];
  maxStacks: number;
  fromEnemy: boolean;
}

export interface EncounterDebuffConfig {
  /** always shown, ahead of everything else */
  important?: number[];
  /** never shown */
  ignore?: number[];
}

export const MIN_IMPORTANT_MS = 5_000;

/** Friendly = the fight's players and their pets/guardians. Everything else (NPCs, environment) is enemy. */
export function friendlyActorIDs(data: FightData): Set<number> {
  const players = new Set(data.fight.friendlyPlayers ?? []);
  const ids = new Set(players);
  for (const a of data.report.masterData.actors) if (a.petOwner !== null && players.has(a.petOwner)) ids.add(a.id);
  return ids;
}

export function collectDebuffs(data: FightData, targetIDs: ReadonlySet<number>): DebuffInterval[] {
  const t0 = data.fight.startTime;
  const duration = data.fight.endTime - t0;
  const friendly = friendlyActorIDs(data);
  const open = new Map<string, DebuffInterval>();
  const done: DebuffInterval[] = [];

  const openInterval = (key: string, targetID: number, abilityID: number, sourceID: number | null, t: number, n: number) => {
    const iv: DebuffInterval = {
      targetID, abilityID, sourceID, start: t, end: duration, applied: [t], stacks: [{ t, n }], maxStacks: n,
      fromEnemy: sourceID === null || !friendly.has(sourceID),
    };
    open.set(key, iv);
    return iv;
  };

  for (const e of data.events.Debuffs ?? []) {
    const targetID = e.targetID as number;
    if (!targetIDs.has(targetID)) continue;
    const abilityID = e.abilityGameID as number;
    const sourceID = typeof e.sourceID === "number" ? e.sourceID : null;
    const key = `${targetID}:${abilityID}:${sourceID}`;
    const t = Math.min(duration, Math.max(0, e.timestamp - t0));
    const stack = typeof e.stack === "number" ? e.stack : 1;
    let iv = open.get(key);
    switch (e.type) {
      case "applydebuff":
        if (iv) iv.applied.push(t); // re-applied while up: treat as a refresh
        else openInterval(key, targetID, abilityID, sourceID, t, 1);
        break;
      case "refreshdebuff":
        (iv ?? openInterval(key, targetID, abilityID, sourceID, 0, 1)).applied.push(t);
        break;
      case "applydebuffstack":
      case "removedebuffstack":
        iv ??= openInterval(key, targetID, abilityID, sourceID, 0, stack);
        iv.stacks.push({ t, n: stack });
        iv.maxStacks = Math.max(iv.maxStacks, stack);
        if (e.type === "applydebuffstack") iv.applied.push(t);
        break;
      case "removedebuff":
        iv ??= openInterval(key, targetID, abilityID, sourceID, 0, 1); // up since before the pull
        iv.end = t;
        open.delete(key);
        done.push(iv);
        break;
    }
  }
  done.push(...open.values());
  return done.sort((a, b) => a.start - b.start);
}

export function isImportant(iv: DebuffInterval, config: EncounterDebuffConfig = {}): boolean {
  if (config.ignore?.includes(iv.abilityID)) return false;
  if (config.important?.includes(iv.abilityID)) return true;
  return iv.fromEnemy && (iv.maxStacks > 1 || iv.end - iv.start >= MIN_IMPORTANT_MS);
}

export function stacksAt(iv: DebuffInterval, t: number): number {
  let n = iv.stacks[0].n;
  for (const s of iv.stacks) {
    if (s.t > t) break;
    n = s.n;
  }
  return n;
}

export function lastAppliedAt(iv: DebuffInterval, t: number): number {
  let a = iv.start;
  for (const x of iv.applied) {
    if (x > t) break;
    a = x;
  }
  return a;
}
