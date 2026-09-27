import { describe, expect, it } from "vitest";
import { fixtureFiles, loadDump } from "../test/fixtures.ts";
import { encounterData } from "./encounters.ts";

describe("encounter data", () => {
  it.each(fixtureFiles())("exists for the fixture %s", (file) => {
    const { fight } = loadDump(file);
    expect(encounterData(fight.encounterID)?.name).toBe(fight.name);
  });
  it("is undefined for unknown encounters", () => expect(encounterData(1)).toBeUndefined());
});
