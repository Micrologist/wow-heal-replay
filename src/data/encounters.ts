// Per-encounter data: src/data/encounters/<encounterID>.json (hand-tuned, data only).
//   debuffs.important: ability IDs always shown on frames, ahead of the default rule
//   debuffs.ignore:    ability IDs never shown
// Default rule without an entry: from an enemy and (stacking or lasting ≥ 5 s). See model/debuffs.ts.

import type { EncounterDebuffConfig } from "../model/debuffs.ts";

export interface EncounterData {
  name: string;
  debuffs?: EncounterDebuffConfig;
}

const files = import.meta.glob<EncounterData>("./encounters/*.json", { eager: true, import: "default" });

export function encounterData(encounterID: number): EncounterData | undefined {
  return files[`./encounters/${encounterID}.json`];
}
