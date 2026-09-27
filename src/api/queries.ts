// GraphQL query strings shared by the browser and the Node script.
// Field names follow CLAUDE.md §4; verify against the live schema (`npm run wcl -- schema`).

export const RATE_LIMIT_QUERY = /* GraphQL */ `
  query RateLimit {
    rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn }
  }
`;

export const REPORT_QUERY = /* GraphQL */ `
  query Report($code: String!) {
    reportData {
      report(code: $code) {
        code title startTime endTime
        zone { id name }
        fights(killType: Encounters) {
          id encounterID name difficulty kill bossPercentage fightPercentage
          startTime endTime friendlyPlayers size
        }
        masterData {
          actors { id gameID name type subType server petOwner icon }
          abilities { gameID name icon type }
        }
      }
    }
  }
`;

export const EVENTS_QUERY = /* GraphQL */ `
  query Events(
    $code: String!
    $fightIDs: [Int]!
    $dataType: EventDataType!
    $hostilityType: HostilityType
    $startTime: Float!
    $endTime: Float!
    $limit: Int
  ) {
    reportData {
      report(code: $code) {
        events(
          fightIDs: $fightIDs
          dataType: $dataType
          hostilityType: $hostilityType
          startTime: $startTime
          endTime: $endTime
          limit: $limit
          useAbilityIDs: true
          includeResources: true
        ) {
          data
          nextPageTimestamp
        }
      }
    }
  }
`;

export const SUMMARY_TABLE_QUERY = /* GraphQL */ `
  query Summary($code: String!, $fightIDs: [Int]!, $startTime: Float!, $endTime: Float!) {
    reportData {
      report(code: $code) {
        table(fightIDs: $fightIDs, dataType: Summary, startTime: $startTime, endTime: $endTime)
      }
    }
  }
`;

/** Schema introspection for the handful of types we depend on. */
export const SCHEMA_QUERY = /* GraphQL */ `
  query Schema {
    report: __type(name: "Report") { fields { name args { name type { name kind ofType { name kind } } } } }
    fight: __type(name: "ReportFight") { fields { name } }
    actor: __type(name: "ReportActor") { fields { name } }
    ability: __type(name: "ReportAbility") { fields { name } }
    paginator: __type(name: "ReportEventPaginator") { fields { name } }
    dataTypes: __type(name: "EventDataType") { enumValues { name } }
    hostility: __type(name: "HostilityType") { enumValues { name } }
  }
`;
