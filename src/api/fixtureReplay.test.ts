// Replays a recorded dump through WclClient's paging loop with a mocked fetch: proves the loop
// requests pages in the same order WCL served them and reassembles the same event counts. No network.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { EventDataType, EventPage, ReportFight } from "./types.ts";
import { WclClient } from "./WclClient.ts";

const FIXTURES = join(import.meta.dirname, "../../fixtures");

interface Fixture {
  meta: { code: string; fightID: number; eventCounts: Record<string, number>; pageCounts: Record<string, number> };
  fight: ReportFight;
  events: Record<string, EventPage[]>;
}

function loadFixture(file: string): Fixture {
  return JSON.parse(gunzipSync(readFileSync(join(FIXTURES, file))).toString("utf8"));
}

/** Serves the recorded pages: page n is only returned for the startTime the client should send for it. */
function replayFetch(fx: Fixture, requested: { dataType: string; startTime: number }[]): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const { variables } = JSON.parse(init.body as string);
    requested.push({ dataType: variables.dataType, startTime: variables.startTime });
    expect(variables.fightIDs).toEqual([fx.meta.fightID]);
    const pages = fx.events[variables.dataType];
    const index = pages.findIndex((_, i) =>
      (i === 0 ? fx.fight.startTime : pages[i - 1].nextPageTimestamp) === variables.startTime,
    );
    if (index < 0) return new Response(JSON.stringify({ errors: [{ message: `unexpected startTime ${variables.startTime}` }] }));
    return new Response(JSON.stringify({ data: { reportData: { report: { events: pages[index] } } } }));
  }) as typeof fetch;
}

const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".json.gz"));

describe.each(files)("fixture %s", (file) => {
  const fx = loadFixture(file);

  it.each(Object.keys(fx.events))("pages %s back to the recorded event count", async (dataType) => {
    const requested: { dataType: string; startTime: number }[] = [];
    const client = new WclClient(replayFetch(fx, requested), async () => "tok");

    const pages = await client.eventPages({
      code: fx.meta.code,
      fightID: fx.meta.fightID,
      dataType: dataType as EventDataType,
      startTime: fx.fight.startTime,
      endTime: fx.fight.endTime,
    });

    expect(pages.length).toBe(fx.meta.pageCounts[dataType]);
    expect(pages.reduce((n, p) => n + p.data.length, 0)).toBe(fx.meta.eventCounts[dataType]);
    expect(pages.at(-1)!.nextPageTimestamp).toBeNull();
    expect(requested.every((r) => r.dataType === dataType)).toBe(true);
  });
});
