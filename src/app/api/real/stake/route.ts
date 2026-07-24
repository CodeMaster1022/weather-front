import { NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { resolveLive } from "@/lib/liveMode";

export const dynamic = "force-dynamic";

/**
 * Configure the signal-size stake ladder — how much WE stake given the
 * target's trade size. Stored on the live_account doc; the bot re-reads it
 * within 15s, so a change applies without a restart.
 *
 * Wire format matches .env: "floor=stake,floor=stake,...". The bot sorts by
 * floor descending and mirrors the target for trades below the lowest floor.
 */
export function validateStakeTiers(raw: string): { tiers: Array<{ floor: number; stake: number }>; error?: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { tiers: [] }; // empty = flat per-trade cap

  const tiers: Array<{ floor: number; stake: number }> = [];
  const seen = new Set<number>();
  for (const part of trimmed.split(",")) {
    const piece = part.trim();
    if (piece === "") continue;
    const bits = piece.split("=");
    if (bits.length !== 2) return { tiers: [], error: `"${piece}" must look like floor=stake, e.g. 1000=30` };
    const floor = Number(bits[0]);
    const stake = Number(bits[1]);
    if (!Number.isFinite(floor) || floor < 0) return { tiers: [], error: `"${bits[0]}" must be a trade size of 0 or more` };
    if (!Number.isFinite(stake) || stake <= 0) return { tiers: [], error: `"${bits[1]}" must be a stake above 0` };
    if (seen.has(floor)) return { tiers: [], error: `trade size $${floor} is listed twice` };
    seen.add(floor);
    tiers.push({ floor, stake });
  }
  tiers.sort((a, b) => b.floor - a.floor);
  return { tiers };
}

export async function POST(request: NextRequest) {
  let body: { mode?: string; tiersRaw?: string; ratioRaw?: string; ratioMax?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const mode = body.mode === "flat" || body.mode === "ratio" ? body.mode : "ladder";
  const raw = (body.tiersRaw ?? "").trim();
  const { tiers, error } = validateStakeTiers(raw);
  if (error) return Response.json({ error }, { status: 400 });

  // Ratio divisor ladder — same "floor=value" shape, values are divisors.
  const ratioRaw = (body.ratioRaw ?? "").trim();
  const ratio = validateStakeTiers(ratioRaw);
  if (mode === "ratio" && ratio.error) return Response.json({ error: ratio.error.replace("stake", "divisor") }, { status: 400 });
  if (mode === "ratio" && ratio.tiers.length === 0) return Response.json({ error: "Ratio mode needs at least one divisor tier" }, { status: 400 });
  const ratioMax = Number(body.ratioMax);
  if (mode === "ratio" && (!Number.isFinite(ratioMax) || ratioMax <= 0)) return Response.json({ error: "Ratio max stake must be above 0" }, { status: 400 });

  try {
    const db = await getDb();
    const scope = await resolveLive(db);
    if (!scope) return Response.json({ error: "Live executor has never run." }, { status: 409 });
    const account = await db.collection("live_account").findOne({ _id: scope.accountId as never });
    if (!account) return Response.json({ error: "Live executor has never run." }, { status: 409 });

    await db.collection("live_account").updateOne(
      { _id: scope.accountId as never },
      {
        $set: {
          stake: {
            mode,
            tiersRaw: raw,
            ratioRaw,
            ratioMax: Number.isFinite(ratioMax) && ratioMax > 0 ? ratioMax : 30,
            updatedAt: new Date(),
          },
          updatedAt: new Date(),
        },
      },
    );
    return Response.json({ ok: true, mode, tiers, ratioTiers: ratio.tiers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
