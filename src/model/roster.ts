// Who was in the fight and who healed. Pure: reads FightData, no DOM or fetch.
// Roles come from the Summary table's composition (WCL's own spec/role detection), which
// avoids guessing from spec names ("Holy" is both a Priest and a Paladin spec).

import type { FightData } from "../api/types.ts";

export type Role = "healer" | "tank" | "dps" | "unknown";

export interface Player {
  id: number;
  name: string;
  /** Class, as WCL writes it in `subType` ("DeathKnight", "Evoker", …). */
  className: string;
  spec: string | null;
  role: Role;
}

interface CompositionEntry {
  id: number;
  specs?: { spec: string; role: string }[];
}

function composition(summaryTable: unknown): CompositionEntry[] {
  const data = (summaryTable as { data?: { composition?: CompositionEntry[] } } | null)?.data;
  return Array.isArray(data?.composition) ? data.composition : [];
}

const ROLE_ORDER: Record<Role, number> = { tank: 0, healer: 1, dps: 2, unknown: 3 };

export function buildRoster(data: FightData): Player[] {
  const actors = new Map(data.report.masterData.actors.map((a) => [a.id, a]));
  const specs = new Map(composition(data.summaryTable).map((c) => [c.id, c.specs?.[0]]));
  const players: Player[] = [];
  for (const id of data.fight.friendlyPlayers ?? []) {
    const actor = actors.get(id);
    if (!actor || actor.type !== "Player") continue;
    const spec = specs.get(id);
    const role = spec && spec.role in ROLE_ORDER ? (spec.role as Role) : "unknown";
    players.push({ id, name: actor.name, className: actor.subType, spec: spec?.spec ?? null, role });
  }
  return players.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name));
}

export function healers(roster: Player[]): Player[] {
  return roster.filter((p) => p.role === "healer");
}
