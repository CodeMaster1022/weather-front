import { NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { resolveLive } from "@/lib/liveMode";

export const dynamic = "force-dynamic";

/**
 * Live slippage tuning. Stored on the live_account doc; the bot re-reads it
 * every 15s, so a change here takes effect without a restart.
 *
 * The raw tier string is stored as typed and parsed bot-side by the same
 * parser .env uses — one source of truth for the format. This route only
 * validates the shape so bad input is rejected with a useful message instead
 * of being silently dropped.
 */

export interface Tier {
  ceiling: number;
  bps: number;
}

/**
 * Strict validation of the price-anchor list — unlike the bot's lenient parser,
 * this REPORTS problems rather than skipping malformed entries so the UI can
 * explain the mistake.
 *
 * Anchors are fixed price points, each with its own tolerance; the bot picks
 * the nearest one for a signal. So there is no ordering or coverage
 * requirement — only that each price is in (0,1], each bps is sane, and no
 * price is listed twice.
 */
export function validateTiers(raw: string): { tiers: Tier[]; error?: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { tiers: [] }; // empty = use the flat fallback

  const tiers: Tier[] = [];
  const seen = new Set<number>();
  for (const part of trimmed.split(",")) {
    const piece = part.trim();
    if (piece === "") continue;
    const bits = piece.split("=");
    if (bits.length !== 2) return { tiers: [], error: `"${piece}" must look like price=bps, e.g. 0.15=2000` };
    const ceiling = Number(bits[0]);
    const bps = Number(bits[1]);
    if (!Number.isFinite(ceiling) || ceiling <= 0 || ceiling > 1) {
      return { tiers: [], error: `"${bits[0]}" must be a price above 0 and at most 1` };
    }
    if (!Number.isFinite(bps) || bps < 0 || bps > 100_000) {
      return { tiers: [], error: `"${bits[1]}" must be a tolerance between 0 and 1000%` };
    }
    if (seen.has(ceiling)) return { tiers: [], error: `price $${ceiling} is listed twice` };
    seen.add(ceiling);
    tiers.push({ ceiling, bps });
  }
  tiers.sort((a, b) => a.ceiling - b.ceiling);
  return { tiers };
}

export async function POST(request: NextRequest) {
  let body: { tiersRaw?: string; bps?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const bps = Number(body.bps);
  if (!Number.isFinite(bps) || bps < 0 || bps > 100_000) {
    return Response.json({ error: "Flat fallback must be between 0 and 100000 bps" }, { status: 400 });
  }
  const raw = (body.tiersRaw ?? "").trim();
  const { tiers, error } = validateTiers(raw);
  if (error) return Response.json({ error }, { status: 400 });

  try {
    const db = await getDb();
    const scope = await resolveLive(db);
    if (!scope) return Response.json({ error: "Live executor has never run." }, { status: 409 });
    const account = await db.collection("live_account").findOne({ _id: scope.accountId as never });
    if (!account) return Response.json({ error: "Live executor has never run." }, { status: 409 });

    await db.collection("live_account").updateOne(
      { _id: scope.accountId as never },
      { $set: { slippage: { bps, tiersRaw: raw, updatedAt: new Date() }, updatedAt: new Date() } },
    );
    return Response.json({ ok: true, tiers, bps });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
