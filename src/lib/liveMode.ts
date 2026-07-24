import type { Db } from "mongodb";

/**
 * Live and dry-run keep fully separate datasets: dry-run writes to a
 * "live-account-dry" doc + "*_dry" collections, live to the unsuffixed ones.
 * Only one mode's bot runs at a time, so the ACTIVE dataset is whichever
 * account doc was updated most recently. Resolve it once and every route reads
 * / writes the matching collections.
 */
export interface LiveScope {
  accountId: string;
  sfx: string;
  positions: string;
  orders: string;
  equity: string;
  commands: string;
}

function scopeFor(dry: boolean): LiveScope {
  const sfx = dry ? "_dry" : "";
  return {
    accountId: dry ? "live-account-dry" : "live-account",
    sfx,
    positions: `live_positions${sfx}`,
    orders: `live_orders${sfx}`,
    equity: `live_equity${sfx}`,
    commands: `live_commands${sfx}`,
  };
}

/** The active scope (most recently updated account), or null if neither ran. */
export async function resolveLive(db: Db): Promise<LiveScope | null> {
  const col = db.collection("live_account");
  const [live, dry] = await Promise.all([
    col.findOne({ _id: "live-account" as never }),
    col.findOne({ _id: "live-account-dry" as never }),
  ]);
  if (!live && !dry) return null;
  const t = (d: Record<string, unknown> | null) => (d?.updatedAt ? new Date(d.updatedAt as string).getTime() : 0);
  const useDry = !!dry && (!live || t(dry) > t(live));
  return scopeFor(useDry);
}
