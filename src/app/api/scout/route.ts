import { NextRequest } from "next/server";
import { simulateCopy } from "@/lib/copysim";
import { computeDaily } from "@/lib/daily";
import { fetchPositions, fetchRedeems, fetchTrades } from "@/lib/polymarket";

export const maxDuration = 300; // multi-day pagination is slow for busy wallets

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * GET /api/scout?wallet=0x…&days=30&maxTrade=10
 * Per-day win/loss for a candidate target, plus what copying it at `maxTrade`
 * USDC per buy would have returned.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const wallet = params.get("wallet")?.trim().toLowerCase() ?? "";
  if (!ADDRESS_RE.test(wallet)) {
    return Response.json({ error: "wallet must be a 0x… address" }, { status: 400 });
  }

  const rawMax = params.get("maxTrade");
  const maxTrade = rawMax === null ? 10 : Number(rawMax);
  if (!Number.isFinite(maxTrade) || maxTrade <= 0) {
    return Response.json({ error: "maxTrade must be a positive number" }, { status: 400 });
  }

  const days = Math.min(Math.max(Number(params.get("days")) || 30, 1), 90);
  const windowEnd = Math.floor(Date.now() / 1000);
  const windowStart = windowEnd - days * 86400;

  try {
    const [trades, redeems, positions] = await Promise.all([
      fetchTrades(wallet, windowStart, windowEnd),
      fetchRedeems(wallet, windowStart, windowEnd),
      fetchPositions(wallet),
    ]);

    if (trades.length === 0 && redeems.length === 0) {
      return Response.json(
        { error: `No activity in the past ${days} days for this wallet.` },
        { status: 404 },
      );
    }

    const report = computeDaily(wallet, trades, redeems, positions, windowStart, windowEnd);
    const copy = simulateCopy(trades, redeems, positions, maxTrade, report.days.map((d) => d.day));
    return Response.json({ ...report, copy });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
