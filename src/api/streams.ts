// The event streams one fight needs (CLAUDE.md §4). Shared by the Node dump and the browser loader
// so both fetch exactly the same data.

import type { EventDataType, HostilityType } from "./types.ts";

export const FIGHT_STREAMS: { dataType: EventDataType; hostilityType: HostilityType }[] = [
  { dataType: "Healing", hostilityType: "Friendlies" },
  { dataType: "DamageTaken", hostilityType: "Friendlies" },
  { dataType: "Casts", hostilityType: "Friendlies" },
  { dataType: "Buffs", hostilityType: "Friendlies" },
  { dataType: "Debuffs", hostilityType: "Friendlies" },
  { dataType: "Deaths", hostilityType: "Friendlies" },
  { dataType: "Resources", hostilityType: "Friendlies" },
];

export const DIFFICULTY: Record<number, string> = { 1: "LFR", 3: "Normal", 4: "Heroic", 5: "Mythic" };
