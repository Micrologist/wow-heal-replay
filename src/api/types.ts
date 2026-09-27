// Shapes of the WCL responses we read. Events stay `unknown`-ish raw JSON on purpose:
// the normalizer (src/model/) owns their interpretation.

export interface RateLimitData {
  limitPerHour: number;
  pointsSpentThisHour: number;
  pointsResetIn: number;
}

export interface ReportFight {
  id: number;
  encounterID: number;
  name: string;
  difficulty: number | null;
  kill: boolean | null;
  bossPercentage: number | null;
  fightPercentage: number | null;
  startTime: number;
  endTime: number;
  friendlyPlayers: number[] | null;
  size: number | null;
}

export interface ReportActor {
  id: number;
  gameID: number;
  name: string;
  type: string;
  subType: string;
  server: string | null;
  petOwner: number | null;
  icon: string;
}

export interface ReportAbility {
  gameID: number;
  name: string;
  icon: string;
  type: string;
}

export interface Report {
  code: string;
  title: string;
  startTime: number;
  endTime: number;
  zone: { id: number; name: string } | null;
  fights: ReportFight[];
  masterData: { actors: ReportActor[]; abilities: ReportAbility[] };
}

export type RawEvent = Record<string, unknown> & { timestamp: number; type: string };

export type EventDataType =
  | "All" | "Buffs" | "Casts" | "CombatantInfo" | "DamageDone" | "DamageTaken" | "Deaths"
  | "Debuffs" | "Dispels" | "Healing" | "Interrupts" | "Resources" | "Summons" | "Threat";

export type HostilityType = "Friendlies" | "Enemies";

/** One page as WCL returned it, kept untouched for fixtures. */
export interface EventPage {
  data: RawEvent[];
  nextPageTimestamp: number | null;
}

/** Everything one fight needs, as fetched (or read from cache). Events are the raw WCL objects,
 * flattened across pages but otherwise untouched; `model/` owns their interpretation. */
export interface FightData {
  code: string;
  report: Pick<Report, "code" | "title" | "startTime" | "endTime" | "zone" | "masterData">;
  fight: ReportFight;
  summaryTable: unknown;
  events: Record<string, RawEvent[]>;
  fetchedAt: number;
}
