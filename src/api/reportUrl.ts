// Accepts a bare report code or any warcraftlogs.com report URL.

export interface ReportRef {
  code: string;
  fightID?: number;
}

const CODE_RE = /^[A-Za-z0-9]{16}$/;

export function parseReportRef(input: string): ReportRef {
  const s = input.trim();
  if (CODE_RE.test(s)) return { code: s };
  const m = s.match(/reports\/([A-Za-z0-9]+)/);
  if (!m) throw new Error(`not a Warcraft Logs report code or URL: ${input}`);
  const fight = s.match(/[#?&]fight=(\d+)/);
  return fight ? { code: m[1], fightID: Number(fight[1]) } : { code: m[1] };
}
