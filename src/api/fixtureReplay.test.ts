// Replays recorded dumps through WclClient's paging loop with a mocked fetch: proves the loop
// requests pages in the order WCL served them and reassembles the same event counts. No network.

import { describe, expect, it } from "vitest";
import { fixtureFiles, loadDump, type Request, wclFromDump } from "../test/fixtures.ts";
import type { EventDataType } from "./types.ts";
import { WclClient } from "./WclClient.ts";

describe.each(fixtureFiles())("fixture %s", (file) => {
  const dump = loadDump(file);

  it.each(Object.keys(dump.events))("pages %s back to the recorded event count", async (dataType) => {
    const requests: Request[] = [];
    const client = new WclClient(wclFromDump(dump, requests), async () => "tok");

    const pages = await client.eventPages({
      code: dump.meta.code,
      fightID: dump.meta.fightID,
      dataType: dataType as EventDataType,
      startTime: dump.fight.startTime,
      endTime: dump.fight.endTime,
    });

    expect(pages.length).toBe(dump.meta.pageCounts[dataType]);
    expect(pages.reduce((n, p) => n + p.data.length, 0)).toBe(dump.meta.eventCounts[dataType]);
    expect(pages.at(-1)!.nextPageTimestamp).toBeNull();
    expect(requests.every((r) => r.variables.dataType === dataType && (r.variables.fightIDs as number[])[0] === dump.meta.fightID)).toBe(true);
  });
});
