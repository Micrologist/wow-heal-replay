import { describe, expect, it } from "vitest";
import { parseReportRef } from "./reportUrl.ts";
import { WclClient } from "./WclClient.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function eventsBody(data: unknown[], nextPageTimestamp: number | null) {
  return { data: { reportData: { report: { events: { data, nextPageTimestamp } } } } };
}

describe("WclClient.eventPages", () => {
  it("follows nextPageTimestamp until null and passes it as the next startTime", async () => {
    const startTimes: number[] = [];
    const pages = [
      eventsBody([{ timestamp: 100, type: "heal" }], 200),
      eventsBody([{ timestamp: 200, type: "heal" }], 300),
      eventsBody([{ timestamp: 300, type: "heal" }], null),
    ];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const { variables } = JSON.parse(init.body as string);
      startTimes.push(variables.startTime);
      return jsonResponse(pages[startTimes.length - 1]);
    }) as typeof fetch;

    const client = new WclClient(fetchImpl, async () => "tok");
    const result = await client.eventPages({ code: "abc", fightID: 1, dataType: "Healing", startTime: 100, endTime: 400 });

    expect(startTimes).toEqual([100, 200, 300]);
    expect(result.flatMap((p) => p.data).map((e) => e.timestamp)).toEqual([100, 200, 300]);
  });

  it("retries on 429 and surfaces GraphQL errors", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls === 1 ? jsonResponse({ error: "slow down" }, 429) : jsonResponse({ errors: [{ message: "bad field" }] });
    }) as typeof fetch;
    const client = new WclClient(fetchImpl, async () => "tok", { sleep: async () => {} });

    await expect(client.rateLimit()).rejects.toThrow("bad field");
    expect(calls).toBe(2);
  });

  it("fails fast on a long Retry-After instead of sleeping", async () => {
    const fetchImpl = (async () =>
      new Response("{}", { status: 429, headers: { "Retry-After": "3299" } })) as typeof fetch;
    const client = new WclClient(fetchImpl, async () => "tok", {
      sleep: async () => { throw new Error("should not sleep"); },
    });

    await expect(client.rateLimit()).rejects.toThrow("retry after 3299s");
  });
});

describe("parseReportRef", () => {
  it("accepts codes and URLs with a fight id", () => {
    expect(parseReportRef("aBcD1234eFgH5678")).toEqual({ code: "aBcD1234eFgH5678" });
    expect(parseReportRef("https://www.warcraftlogs.com/reports/aBcD1234eFgH5678#fight=12&type=healing")).toEqual({
      code: "aBcD1234eFgH5678",
      fightID: 12,
    });
    expect(() => parseReportRef("nope")).toThrow();
  });
});
