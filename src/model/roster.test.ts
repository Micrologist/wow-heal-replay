import { describe, expect, it } from "vitest";
import { fightDataFromDump } from "../api/fightData.ts";
import { fixtureFiles, loadDump } from "../test/fixtures.ts";
import { buildRoster, healers } from "./roster.ts";

// Healers per fixture as WCL's Summary table reports them (checked against the dumps).
const EXPECTED_HEALERS: Record<string, string[]> = {
  "nek-zali-the-soulcoiler-368AMJNcyTLkrPvz-15.json.gz": ["Bâlti Holy Priest", "Musu Restoration Druid", "Timing Preservation Evoker", "Trafysett Mistweaver Monk"],
  "nek-zali-the-soulcoiler-368AMJNcyTLkrPvz-16.json.gz": ["Bâlti Holy Priest", "Musu Restoration Druid", "Timing Preservation Evoker", "Trafysett Mistweaver Monk"],
  "the-lost-explorers-t7Jz29RwvfQhYKLg-38.json.gz": ["Balotan Holy Paladin", "Goreki Restoration Shaman", "Timing Preservation Evoker"],
  "the-lost-explorers-t7Jz29RwvfQhYKLg-40.json.gz": ["Balotan Holy Paladin", "Bâlti Discipline Priest", "Goreki Restoration Shaman", "Timing Preservation Evoker"],
};

describe.each(fixtureFiles())("roster of %s", (file) => {
  const data = fightDataFromDump(loadDump(file));
  const roster = buildRoster(data);

  it("has one entry per friendly player, each with a class", () => {
    expect(roster).toHaveLength(data.fight.friendlyPlayers!.length);
    expect(roster.every((p) => p.className && p.name)).toBe(true);
  });

  it("finds the healers from the Summary table roles", () => {
    expect(EXPECTED_HEALERS[file], `add ${file} to EXPECTED_HEALERS`).toBeDefined();
    expect(healers(roster).map((p) => `${p.name} ${p.spec} ${p.className}`).sort()).toEqual([...EXPECTED_HEALERS[file]].sort());
  });
});
