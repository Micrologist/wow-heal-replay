import { describe, expect, it } from "vitest";
import { formatHash, parseHash } from "./hashState.ts";

describe("hash state", () => {
  it("round-trips code and fight", () => {
    expect(parseHash(formatHash({ code: "368AMJNcyTLkrPvz", fight: 16 }))).toEqual({ code: "368AMJNcyTLkrPvz", fight: 16 });
  });
  it("ignores junk", () => {
    expect(parseHash("#code=<x>&fight=abc")).toEqual({});
    expect(parseHash("")).toEqual({});
    expect(formatHash({})).toBe("");
  });
});
