import { describe, expect, it } from "vitest";
import { fightDataFromDump } from "../api/fightData.ts";
import { fixtureFiles, loadDump } from "../test/fixtures.ts";
import { buildRoster, healers } from "./roster.ts";

describe.each(fixtureFiles())("roster of %s", (file) => {
  const data = fightDataFromDump(loadDump(file));
  const roster = buildRoster(data);

  it("has one entry per friendly player, each with a class", () => {
    expect(roster).toHaveLength(data.fight.friendlyPlayers!.length);
    expect(roster.every((p) => p.className && p.name)).toBe(true);
  });

  it("finds the healers from the Summary table roles", () => {
    expect(healers(roster).map((p) => `${p.spec} ${p.className}`).sort()).toEqual(
      ["Holy Priest", "Mistweaver Monk", "Preservation Evoker", "Restoration Druid"].sort(),
    );
  });
});
