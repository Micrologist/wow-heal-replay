import { describe, expect, it } from "vitest";
import { formatHash, parseHash } from "./hashState.ts";

describe("hash state", () => {
  it("round-trips code, fight and healer (including non-ASCII names)", () => {
    const s = { code: "t7Jz29RwvfQhYKLg", fight: 40, healer: "Bâlti" };
    expect(parseHash(formatHash(s))).toEqual(s);
  });
  it("ignores junk", () => {
    expect(parseHash("#code=<x>&fight=abc")).toEqual({});
    expect(parseHash("")).toEqual({});
    expect(formatHash({})).toBe("");
  });
});
