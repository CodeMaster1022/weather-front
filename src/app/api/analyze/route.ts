import { NextRequest } from "next/server";
import { analyzeWallet } from "@/lib/claude";
import { getDb } from "@/lib/mongo";
import { fetchPositions, fetchRedeems, fetchTrades } from "@/lib/polymarket";
import { computeStats } from "@/lib/stats";

export const maxDuration = 300; // Claude + pagination can take a while

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export async function POST(request: NextRequest) {
  let body: { wallet?: string; skipAnalysis?: boolean };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const wallet = body.wallet?.trim().toLowerCase() ?? "";
  if (!ADDRESS_RE.test(wallet)) {
    return Response.json({ error: "wallet must be a 0x… address" }, { status: 400 });
  }

  const windowEnd = Math.floor(Date.now() / 1000);
  const windowStart = windowEnd - 86400;

  try {
    const [trades, redeems, positions] = await Promise.all([
      fetchTrades(wallet, windowStart, windowEnd),
      fetchRedeems(wallet, windowStart),
      fetchPositions(wallet),
    ]);

    if (trades.length === 0 && redeems.length === 0) {
      return Response.json(
        { error: "No trades in the past 24 hours for this wallet - nothing to analyze." },
        { status: 404 },
      );
    }

    const stats = computeStats(wallet, trades, redeems, positions, windowStart, windowEnd);

    // skipAnalysis lets the UI show stats instantly (and works without an API key).
    let analysis = null;
    let model = null;
    let usage = null;
    if (!body.skipAnalysis) {
      const result = await analyzeWallet(stats, trades);
      analysis = result.analysis;
      model = result.model;
      usage = { inputTokens: result.inputTokens, outputTokens: result.outputTokens };
    }

    const db = await getDb();
    const doc = {
      wallet,
      createdAt: new Date(),
      windowStart,
      windowEnd,
      stats,
      analysis,
      model,
      usage,
    };
    const { insertedId } = await db.collection("analyses").insertOne(doc);

    return Response.json({ id: insertedId.toString(), ...doc });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
