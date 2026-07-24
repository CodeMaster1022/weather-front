"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

interface EsportsMatch {
  id: string;
  game: string;
  title: string;
  slug: string;
  status: "live" | "upcoming";
  startMs: number;
  favorite: string;
  favoritePct: number;
  underdog: string;
  underdogPct: number;
  gap: number;
  volume: number;
  liquidity: number;
}

const fmtUsd0 = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function whenLabel(m: EsportsMatch): string {
  if (m.status === "live") return "LIVE";
  const mins = Math.round((m.startMs - Date.now()) / 60000);
  if (mins < 60) return `in ${Math.max(0, mins)}m`;
  if (mins < 1440) return `in ${Math.round(mins / 60)}h`;
  return `in ${Math.round(mins / 1440)}d`;
}

/** Two-team split bar: favorite fills from the left, underdog from the right. */
function OddsBar({ favPct }: { favPct: number }) {
  const pct = Math.round(favPct * 100);
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-[var(--surface-3)]">
      <div className="h-full" style={{ width: `${pct}%`, background: "var(--series-1)" }} />
      <div className="h-full w-0.5 bg-[var(--surface-2)]" />
      <div className="h-full flex-1" style={{ background: "var(--serious)" }} />
    </div>
  );
}

export default function EsportsPage() {
  const [matches, setMatches] = useState<EsportsMatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [auto, setAuto] = useState(true);

  // Filters. minGap is the headline control — how lopsided a match must be to
  // show. hideLocked drops near-decided (>95%) games that aren't worth a bet.
  const [minGap, setMinGap] = useState(40); // percentage points
  const [hideLocked, setHideLocked] = useState(true);
  const [onlyLive, setOnlyLive] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/esports", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setMatches(json.matches);
      setFetchedAt(json.fetchedAt);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => void load(), 60_000);
    return () => clearInterval(id);
  }, [auto, load]);

  const shown = useMemo(() => {
    if (!matches) return [];
    return matches.filter(
      (m) =>
        m.gap * 100 >= minGap &&
        (!hideLocked || m.favoritePct < 0.95) &&
        (!onlyLive || m.status === "live"),
    );
  }, [matches, minGap, hideLocked, onlyLive]);

  const liveCount = matches?.filter((m) => m.status === "live").length ?? 0;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-[var(--text-primary)]">Live Esports</h1>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Live and upcoming matches where one team is a heavy favorite — the market&apos;s own price gap.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/real" className="font-semibold text-[var(--critical)] hover:underline">Live Account</Link>
          <Link href="/watchlist" className="text-[var(--series-1)] hover:underline">Watchlist</Link>
          <Link href="/" className="text-[var(--series-1)] hover:underline">Analyzer</Link>
        </div>
      </header>

      {error && (
        <div className="mb-6 rounded-md border border-[var(--critical)] bg-[var(--surface-2)] px-4 py-3 text-sm">⚠ {error}</div>
      )}

      {/* Filters */}
      <section className="mb-6 rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <label className="flex items-center gap-3 text-xs text-[var(--text-secondary)]">
            <span className="whitespace-nowrap font-medium">Min gap</span>
            <input
              type="range" min={0} max={90} step={5}
              value={minGap}
              onChange={(e) => setMinGap(Number(e.target.value))}
              className="w-40"
            />
            <span className="w-14 tabular-nums text-[var(--text-primary)]">{minGap} pts</span>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
            <input type="checkbox" checked={hideLocked} onChange={(e) => setHideLocked(e.target.checked)} />
            hide near-decided (&gt;95%)
          </label>
          <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
            <input type="checkbox" checked={onlyLive} onChange={(e) => setOnlyLive(e.target.checked)} />
            live only
          </label>
          <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            auto-refresh 60s
          </label>
          <button
            onClick={load}
            disabled={loading}
            className="rounded border border-[var(--edge)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-3)] disabled:opacity-50"
          >
            {loading ? "checking…" : "refresh"}
          </button>
          <span className="ml-auto text-xs text-[var(--text-muted)]">
            {matches ? (
              <>
                {shown.length} shown · {liveCount} live
                {fetchedAt ? ` · updated ${new Date(fetchedAt).toLocaleTimeString()}` : ""}
              </>
            ) : (
              "loading…"
            )}
          </span>
        </div>
      </section>

      {matches && shown.length === 0 && (
        <div className="rounded-lg border border-dashed border-[var(--edge)] bg-[var(--surface-2)] px-4 py-10 text-center text-sm text-[var(--text-secondary)]">
          No matches meet the filter. Lower the min gap{onlyLive ? " or turn off “live only”" : ""}.
        </div>
      )}

      {shown.length > 0 && (
        <section className="overflow-x-auto rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-4">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="uppercase tracking-wide text-[var(--text-muted)]">
                <th className="py-1.5 pr-3 font-medium">When</th>
                <th className="py-1.5 pr-3 font-medium">Game</th>
                <th className="py-1.5 pr-3 font-medium">Favorite → Underdog</th>
                <th className="min-w-[8rem] py-1.5 pr-3 font-medium">Odds</th>
                <th className="py-1.5 pr-3 text-right font-medium">Gap</th>
                <th className="py-1.5 pr-3 text-right font-medium">Volume</th>
                <th className="py-1.5 text-right font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => (
                <tr key={m.id} className="border-t border-[var(--edge)] text-[var(--text-primary)]">
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {m.status === "live" ? (
                      <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: "var(--critical)" }}>
                        <span className="h-2 w-2 animate-pulse rounded-full" style={{ background: "var(--critical)" }} />
                        LIVE
                      </span>
                    ) : (
                      <span className="text-[var(--text-secondary)]">{whenLabel(m)}</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap text-[var(--text-muted)]">{m.game}</td>
                  <td className="py-2 pr-3">
                    <div>
                      <span style={{ color: "var(--series-1)" }}>{m.favorite}</span>
                      <span className="text-[var(--text-muted)]"> {(m.favoritePct * 100).toFixed(0)}%</span>
                      <span className="text-[var(--text-muted)]"> → </span>
                      <span style={{ color: "var(--serious)" }}>{m.underdog}</span>
                      <span className="text-[var(--text-muted)]"> {(m.underdogPct * 100).toFixed(0)}%</span>
                    </div>
                    <div className="truncate text-[10px] text-[var(--text-muted)]">{m.title}</div>
                  </td>
                  <td className="py-2 pr-3"><OddsBar favPct={m.favoritePct} /></td>
                  <td className="py-2 pr-3 text-right font-semibold tabular-nums">{(m.gap * 100).toFixed(0)} pts</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-[var(--text-secondary)]">
                    {m.volume > 0 ? fmtUsd0(m.volume) : "—"}
                  </td>
                  <td className="py-2 text-right">
                    <a
                      href={`https://polymarket.com/event/${m.slug}`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded border border-[var(--edge)] px-2 py-0.5 text-[var(--text-secondary)] hover:border-[var(--series-1)] hover:text-[var(--series-1)]"
                    >
                      open
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
            Percentages are the market&apos;s implied win probability. A big gap means a strong favorite — it is not a sign
            of value; a 90% favorite is priced to win 9 times in 10 and pays only ~11¢ on the dollar. Low-volume markets
            (thin books) move on tiny trades.
          </p>
        </section>
      )}
    </main>
  );
}
