// Fight + report cache. Re-opening a fight must cost no API points (CLAUDE.md §4), so fetched
// fights live in IndexedDB keyed by (code, fightID). Reports are cached too but can be refreshed:
// a report that is still being live-logged grows new fights.

import type { FightData, Report } from "./types.ts";

export interface CachedReport {
  report: Report;
  fetchedAt: number;
}

export interface FightStore {
  getFight(code: string, fightID: number): Promise<FightData | undefined>;
  putFight(data: FightData): Promise<void>;
  /** Fight IDs of `code` that are cached (for the "cached" badge in the fight list). */
  cachedFightIDs(code: string): Promise<number[]>;
  deleteFight(code: string, fightID: number): Promise<void>;
  getReport(code: string): Promise<CachedReport | undefined>;
  putReport(report: Report): Promise<void>;
}

export class MemoryFightStore implements FightStore {
  private fights = new Map<string, FightData>();
  private reports = new Map<string, CachedReport>();

  async getFight(code: string, fightID: number) {
    return this.fights.get(`${code}:${fightID}`);
  }
  async putFight(data: FightData) {
    this.fights.set(`${data.code}:${data.fight.id}`, data);
  }
  async cachedFightIDs(code: string) {
    return [...this.fights.values()].filter((f) => f.code === code).map((f) => f.fight.id);
  }
  async deleteFight(code: string, fightID: number) {
    this.fights.delete(`${code}:${fightID}`);
  }
  async getReport(code: string) {
    return this.reports.get(code);
  }
  async putReport(report: Report) {
    this.reports.set(report.code, { report, fetchedAt: Date.now() });
  }
}

const DB_VERSION = 1;
const FIGHTS = "fights";
const REPORTS = "reports";

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export class IdbFightStore implements FightStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(idb: IDBFactory = indexedDB, name = "wow-heal-replay"): Promise<IdbFightStore> {
    const req = idb.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FIGHTS)) {
        const store = db.createObjectStore(FIGHTS, { keyPath: ["code", "fight.id"] });
        store.createIndex("code", "code");
      }
      if (!db.objectStoreNames.contains(REPORTS)) db.createObjectStore(REPORTS, { keyPath: "report.code" });
    };
    return new IdbFightStore(await promisify(req));
  }

  async getFight(code: string, fightID: number) {
    const tx = this.db.transaction(FIGHTS, "readonly");
    return (await promisify(tx.objectStore(FIGHTS).get([code, fightID]))) as FightData | undefined;
  }

  async putFight(data: FightData) {
    const tx = this.db.transaction(FIGHTS, "readwrite");
    tx.objectStore(FIGHTS).put(data);
    await done(tx);
  }

  async cachedFightIDs(code: string) {
    const tx = this.db.transaction(FIGHTS, "readonly");
    const keys = (await promisify(tx.objectStore(FIGHTS).index("code").getAllKeys(code))) as [string, number][];
    return keys.map(([, id]) => id);
  }

  async deleteFight(code: string, fightID: number) {
    const tx = this.db.transaction(FIGHTS, "readwrite");
    tx.objectStore(FIGHTS).delete([code, fightID]);
    await done(tx);
  }

  async getReport(code: string) {
    const tx = this.db.transaction(REPORTS, "readonly");
    return (await promisify(tx.objectStore(REPORTS).get(code))) as CachedReport | undefined;
  }

  async putReport(report: Report) {
    const tx = this.db.transaction(REPORTS, "readwrite");
    tx.objectStore(REPORTS).put({ report, fetchedAt: Date.now() } satisfies CachedReport);
    await done(tx);
  }
}

/** IndexedDB when the browser allows it (private modes may not); otherwise a per-tab memory cache. */
export async function openFightStore(): Promise<{ store: FightStore; persistent: boolean }> {
  try {
    return { store: await IdbFightStore.open(), persistent: true };
  } catch {
    return { store: new MemoryFightStore(), persistent: false };
  }
}
