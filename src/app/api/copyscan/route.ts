import { NextRequest } from "next/server";

/**
 * Proxy to the Python copy-target scanner (scout-py/server.py).
 *
 * The scan streams NDJSON progress over several minutes, so this route pipes
 * the upstream body straight through rather than buffering it — the page
 * renders each wallet's grade as it lands.
 */

const SCANNER = (process.env.COPYSCAN_URL ?? "http://127.0.0.1:8100").replace(/\/+$/, "");

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams;

  // `scans` lists saved runs, `scanId` replays one from Mongo, `wallet` returns
  // one wallet's score history — none of these re-hit the Polymarket API.
  const scanId = p.get("scanId");
  const walletHistory = p.get("wallet");
  const path =
    p.get("leaderboardOnly") === "1"
      ? "/leaderboard"
      : p.get("scans") === "1"
        ? "/scans"
        : scanId
          ? `/scans/${encodeURIComponent(scanId)}`
          : walletHistory
            ? `/wallet/${encodeURIComponent(walletHistory)}`
            : "/scan";

  const upstream = new URL(SCANNER + path);
  for (const key of ["windows", "limit", "days", "maxTrade", "bankroll", "perPosition", "concurrency", "refresh"]) {
    const v = p.get(key);
    if (v !== null) upstream.searchParams.set(key, v);
  }

  try {
    const res = await fetch(upstream, {
      cache: "no-store",
      // Abandon the upstream scan if the browser navigates away.
      signal: request.signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      return Response.json(
        { error: `scanner ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}` },
        { status: 502 },
      );
    }
    return new Response(res.body, {
      headers: {
        "Content-Type": res.headers.get("content-type") ?? "application/x-ndjson",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      {
        error: message.includes("fetch failed")
          ? `Cannot reach the scanner at ${SCANNER}. Start it with: python -m uvicorn server:app --port 8100 (in scout-py/)`
          : message,
      },
      { status: 502 },
    );
  }
}
