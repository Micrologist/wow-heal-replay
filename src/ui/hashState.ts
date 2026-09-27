// Shareable state in the URL hash (CLAUDE.md §2): #code=…&fight=12. More keys (t, healer) come later.

export interface HashState {
  code?: string;
  fight?: number;
}

export function parseHash(hash: string): HashState {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const code = params.get("code") ?? undefined;
  const fight = Number(params.get("fight"));
  return { ...(code && /^[A-Za-z0-9]+$/.test(code) ? { code } : {}), ...(Number.isInteger(fight) && fight > 0 ? { fight } : {}) };
}

export function formatHash(state: HashState): string {
  const params = new URLSearchParams();
  if (state.code) params.set("code", state.code);
  if (state.fight !== undefined) params.set("fight", String(state.fight));
  const s = params.toString();
  return s ? `#${s}` : "";
}
