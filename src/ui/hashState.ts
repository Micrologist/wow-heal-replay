// Shareable state in the URL hash (CLAUDE.md §2): #code=…&fight=12&healer=Balotan. `t` comes later.

export interface HashState {
  code?: string;
  fight?: number;
  /** selected healer's name */
  healer?: string;
}

export function parseHash(hash: string): HashState {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const code = params.get("code") ?? undefined;
  const fight = Number(params.get("fight"));
  const healer = params.get("healer")?.trim();
  return {
    ...(code && /^[A-Za-z0-9]+$/.test(code) ? { code } : {}),
    ...(Number.isInteger(fight) && fight > 0 ? { fight } : {}),
    ...(healer && healer.length <= 40 ? { healer } : {}),
  };
}

export function formatHash(state: HashState): string {
  const params = new URLSearchParams();
  if (state.code) params.set("code", state.code);
  if (state.fight !== undefined) params.set("fight", String(state.fight));
  if (state.healer) params.set("healer", state.healer);
  const s = params.toString();
  return s ? `#${s}` : "";
}
