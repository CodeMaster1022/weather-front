export const dynamic = "force-dynamic";

const GAMMA = "https://gamma-api.polymarket.com";

/** How long after tip-off we still treat an open market as "in play" rather
 * than a stale/finished game the API hasn't closed yet. */
const LIVE_WINDOW_MS = 4 * 60 * 60 * 1000;

export interface EsportsMatch {
  id: string;
  game: string; // LoL / Dota 2 / Valorant / CS2 / StarCraft II / …
  title: string; // full event title
  slug: string;
  status: "live" | "upcoming";
  startMs: number; // gameStartTime epoch ms
  favorite: string;
  favoritePct: number; // 0..1
  underdog: string;
  underdogPct: number;
  gap: number; // favoritePct - underdogPct, 0..1
  volume: number;
  liquidity: number;
}

/** "2026-07-25 10:15:00+00" → epoch ms (0 if unparseable). */
function parseGameStart(raw: unknown): number {
  if (typeof raw !== "string" || !raw) return 0;
  const iso = raw.replace(" ", "T").replace(/\+00$/, "Z");
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** Game label from the title prefix ("LoL: A vs B …" → "LoL"). */
function gameOf(title: string): string {
  const idx = title.indexOf(":");
  if (idx > 0 && idx < 20) return title.slice(0, idx).trim();
  return "Esports";
}

function jsonArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  return [];
}

interface GammaMarket {
  outcomes?: unknown;
  outcomePrices?: unknown;
  closed?: boolean;
  acceptingOrders?: boolean;
  volumeNum?: number;
  volume?: string | number;
  liquidityNum?: number;
  liquidity?: string | number;
  gameStartTime?: string;
}
interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  live?: boolean;
  closed?: boolean;
  startDate?: string;
  markets?: GammaMarket[];
}

/**
 * The moneyline (match-winner) market: the two-outcome market whose outcomes
 * are the team names (not Yes/No), with the most volume — an event also carries
 * map-winner and total-maps markets we don't want.
 */
function moneyline(ev: GammaEvent): GammaMarket | null {
  let best: GammaMarket | null = null;
  let bestVol = -1;
  for (const m of ev.markets ?? []) {
    if (m.closed || m.acceptingOrders === false) continue;
    const outs = jsonArray(m.outcomes).map(String);
    if (outs.length !== 2) continue;
    if (outs.some((o) => /^(yes|no)$/i.test(o))) continue;
    const vol = Number(m.volumeNum ?? m.volume ?? 0);
    if (vol > bestVol) {
      bestVol = vol;
      best = m;
    }
  }
  return best;
}

async function fetchEsports(): Promise<GammaEvent[]> {
  // Newest-first so the near-future slate is in the first page; ascending would
  // start months in the past and never reach today within the limit.
  const res = await fetch(
    `${GAMMA}/events?tag_slug=esports&closed=false&active=true&limit=500&order=startDate&ascending=false`,
    { cache: "no-store", headers: { accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`Gamma ${res.status}`);
  const data = (await res.json()) as unknown;
  return Array.isArray(data) ? (data as GammaEvent[]) : [];
}

export async function GET() {
  try {
    const events = await fetchEsports();
    const now = Date.now();
    const matches: EsportsMatch[] = [];

    for (const ev of events) {
      if (!/ vs /i.test(ev.title)) continue; // only head-to-head matches
      const mk = moneyline(ev);
      if (!mk) continue;

      const outs = jsonArray(mk.outcomes).map(String);
      const prices = jsonArray(mk.outcomePrices).map(Number);
      if (prices.length !== 2 || prices.some((p) => !Number.isFinite(p))) continue;

      const startMs = parseGameStart(mk.gameStartTime) || (ev.startDate ? Date.parse(ev.startDate) : 0);
      let status: "live" | "upcoming";
      if (startMs > now) status = "upcoming";
      else if (startMs > 0 && now - startMs < LIVE_WINDOW_MS) status = "live";
      else continue; // finished, or so old the API just hasn't closed it

      const favIdx = prices[0] >= prices[1] ? 0 : 1;
      matches.push({
        id: ev.id,
        game: gameOf(ev.title),
        title: ev.title,
        slug: ev.slug,
        status,
        startMs,
        favorite: outs[favIdx],
        favoritePct: prices[favIdx],
        underdog: outs[1 - favIdx],
        underdogPct: prices[1 - favIdx],
        gap: Math.abs(prices[0] - prices[1]),
        volume: Number(mk.volumeNum ?? mk.volume ?? 0),
        liquidity: Number(mk.liquidityNum ?? mk.liquidity ?? 0),
      });
    }

    // Live first, then by gap (biggest mismatch on top).
    matches.sort((a, b) => Number(b.status === "live") - Number(a.status === "live") || b.gap - a.gap);
    return Response.json({ matches, fetchedAt: now });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
