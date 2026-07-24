import { getDb } from "@/lib/mongo";
import { resolveLive } from "@/lib/liveMode";

export const dynamic = "force-dynamic";

interface Target {
  address: string;
  nickname: string;
  role?: "copy" | "signal";
}
interface Activity {
  side: string;
  title: string;
  outcome: string;
  price: number;
  size: number;
  usdcSize: number;
  timestamp: number;
  asset: string;
  eventSlug: string;
}
interface OrderRow {
  ts: number;
  side: string;
  asset: string;
  status: string;
  reason?: string;
}

/**
 * The target wallets' recent BUYS — the raw signal stream, shown regardless of
 * mode. In live/dry the bot only copies a subset (caps, skips, take-profit), so
 * this feed keeps the full picture visible and tags which buys the bot acted on.
 */
export async function GET() {
  try {
    const db = await getDb();
    const scope = await resolveLive(db);
    if (!scope) return Response.json({ signals: [], targets: [] });
    const account = await db.collection("live_account").findOne({ _id: scope.accountId as never });
    const targets = ((account as { targets?: Target[] })?.targets ?? []).filter((t) => t?.address);
    if (targets.length === 0) return Response.json({ signals: [], targets: [], message: "No targets recorded yet — start the executor once." });

    // The bot's own recent BUY orders, to tag whether each signal was copied.
    const orders = (await db
      .collection(scope.orders)
      .find({ side: "BUY" })
      .sort({ ts: -1 })
      .limit(300)
      .toArray()) as unknown as OrderRow[];

    // Fetch each target's recent trades from the Data API and keep the BUYs.
    const perTarget = await Promise.all(
      targets.map(async (t) => {
        try {
          const res = await fetch(
            `https://data-api.polymarket.com/activity?user=${t.address}&type=TRADE&limit=40&sortDirection=DESC`,
            { cache: "no-store" },
          );
          if (!res.ok) return [];
          const arr = (await res.json()) as Activity[];
          if (!Array.isArray(arr)) return [];
          return arr
            .filter((a) => a.side === "BUY")
            .map((a) => {
              // Did the bot act on this buy? Match asset + a BUY order shortly after.
              const hit = orders.find((o) => o.asset === a.asset && o.ts >= a.timestamp - 5 && o.ts <= a.timestamp + 180);
              return {
                nickname: t.nickname,
                role: t.role ?? "copy",
                title: a.title,
                outcome: a.outcome,
                price: a.price,
                usdcSize: a.usdcSize,
                size: a.size,
                timestamp: a.timestamp,
                eventSlug: a.eventSlug,
                // Signal-only wallets are never traded — mark them so, else the bot's status.
                botStatus: (t.role === "signal" ? "signal" : hit?.status ?? null) as string | null,
                botReason: hit?.reason ?? null,
              };
            });
        } catch {
          return [];
        }
      }),
    );

    const signals = perTarget.flat().sort((a, b) => b.timestamp - a.timestamp).slice(0, 60);
    return Response.json({ signals, targets: targets.map((t) => t.nickname) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
