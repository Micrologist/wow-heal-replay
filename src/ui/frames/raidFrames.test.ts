import { describe, expect, it } from "vitest";
import { fmtFightTime } from "../controls/playback.ts";
import { groupPlayers } from "./raidFrames.ts";

describe("raid frame helpers", () => {
  it("fills groups of 5 in order", () => {
    expect(groupPlayers([1, 2, 3, 4, 5, 6, 7]).map((g) => g.length)).toEqual([5, 2]);
    expect(groupPlayers(Array.from({ length: 20 }, (_, i) => i))).toHaveLength(4);
  });
  it("formats fight time as m:ss.s", () => {
    expect(fmtFightTime(0)).toBe("0:00.0");
    expect(fmtFightTime(97_640)).toBe("1:37.6");
    expect(fmtFightTime(406_160)).toBe("6:46.2");
  });
});
