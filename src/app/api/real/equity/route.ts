import { NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { resolveLive } from "@/lib/liveMode";

export const dynamic = "force-dynamic";

interface EquityDoc {
  ts: number;
  cash: number;
  openValue: number;
  equity: number;
}

interface OrderDoc {
  ts: number;
  side: string;
  usdc: number;
  status: string;
}

/**
 * Cash / total-value time series for the dashboard chart. The bot appends a
 * snapshot every ~2 min; here we window it, downsample to keep the payload
 * light, and report the peak (high-water mark) of each line.
 */
export async function GET(request: NextRequest) {
  const days = Math.min(90, Math.max(1, Number(request.nextUrl.searchParams.get("days")) || 7));
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  try {
    const db = await getDb();
    const scope = await resolveLive(db);
    if (!scope) return Response.json({ points: [], maxCash: 0, maxEquity: 0, peakTs: 0 });
    const raw = (await db
      .collection<EquityDoc>(scope.equity)
      .find({ ts: { $gte: since } })
      .sort({ ts: 1 })
      .toArray()) as unknown as EquityDoc[];

    if (raw.length === 0) return Response.json({ points: [], maxCash: 0, maxEquity: 0, peakTs: 0 });

    // Downsample to ~500 evenly-spaced points so the chart stays snappy.
    const target = 500;
    const step = Math.ceil(raw.length / target);
    const points = raw
      .filter((_, i) => i % step === 0 || i === raw.length - 1)
      .map((p) => ({ ts: p.ts, cash: p.cash, equity: p.equity }));

    // Peaks computed over the FULL window, not the downsampled set, so the
    // high-water mark is never missed between sampled points.
    let maxCash = 0;
    let maxEquity = 0;
    let peakTs = raw[0].ts;
    for (const p of raw) {
      if (p.cash > maxCash) maxCash = p.cash;
      if (p.equity > maxEquity) {
        maxEquity = p.equity;
        peakTs = p.ts;
      }
    }

    // Trade-volume histogram from executed orders, bucketed to align with the
    // value chart. "Volume" = USDC we actually traded (filled buys + sells).
    const span = Math.max(1, (points[points.length - 1]?.ts ?? since) - points[0].ts);
    const bucketSec = Math.max(3600, Math.ceil(span / 48)); // ~48 bars max, min 1h
    const orders = (await db
      .collection<OrderDoc>(scope.orders)
      .find({ ts: { $gte: since }, status: { $in: ["placed", "reconciled"] } })
      .project({ ts: 1, side: 1, usdc: 1, status: 1 })
      .toArray()) as unknown as OrderDoc[];

    const buckets = new Map<number, { buy: number; sell: number }>();
    for (const o of orders) {
      const usd = Number(o.usdc) || 0;
      if (usd <= 0) continue;
      const b = Math.floor(o.ts / bucketSec) * bucketSec;
      const cur = buckets.get(b) ?? { buy: 0, sell: 0 };
      if (o.side === "BUY") cur.buy += usd;
      else cur.sell += usd;
      buckets.set(b, cur);
    }
    const volume = [...buckets.entries()]
      .map(([ts, v]) => ({ ts, buy: v.buy, sell: v.sell, total: v.buy + v.sell }))
      .sort((a, b) => a.ts - b.ts);
    const maxVolume = volume.reduce((m, v) => Math.max(m, v.total), 0);

    return Response.json({ points, maxCash, maxEquity, peakTs, volume, maxVolume, bucketSec });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
