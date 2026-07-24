"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Analysis } from "@/lib/claude";
import type { WalletStats } from "@/lib/stats";

interface AnalysisDoc {
  id: string;
  wallet: string;
  createdAt: string;
  windowStart: number;
  windowEnd: number;
  stats: WalletStats;
  analysis: Analysis | null;
  model: string | null;
  error?: string;
}

const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const fmtNum = (n: number, frac = 1) => n.toLocaleString("en-US", { maximumFractionDigits: frac });

function pnlParts(n: number): { text: string; color: string } {
  if (n > 0.005) return { text: `+${fmtUsd(n)}`, color: "var(--good)" };
  if (n < -0.005) return { text: `−${fmtUsd(Math.abs(n))}`, color: "var(--critical)" };
  return { text: fmtUsd(0), color: "var(--text-secondary)" };
}

function StatTile({ label, value, sub, valueColor }: { label: string; value: string; sub?: string; valueColor?: string }) {
  return (
    <div className="rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: valueColor ?? "var(--text-primary)" }}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-[var(--text-secondary)]">{sub}</div>}
    </div>
  );
}

function HourlyChart({ hours }: { hours: number[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...hours, 1);
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-[var(--text-secondary)]">Trades by hour (UTC)</h3>
        <span className="h-4 text-xs tabular-nums text-[var(--text-secondary)]">
          {hover !== null ? `${String(hover).padStart(2, "0")}:00 — ${hours[hover]} trade${hours[hover] === 1 ? "" : "s"}` : ""}
        </span>
      </div>
      <div className="flex h-28 items-end gap-[2px]" role="img" aria-label="Bar chart of trade count per UTC hour">
        {hours.map((count, h) => (
          <div
            key={h}
            className="group flex h-full flex-1 cursor-default flex-col justify-end"
            onMouseEnter={() => setHover(h)}
            onMouseLeave={() => setHover(null)}
          >
            <div
              className="w-full rounded-t-[4px] transition-opacity"
              style={{
                height: `${Math.max((count / max) * 100, count > 0 ? 4 : 0)}%`,
                minHeight: count > 0 ? 3 : 0,
                background: "var(--series-1)",
                opacity: hover === null || hover === h ? 1 : 0.45,
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-[var(--text-muted)]">
        <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
      </div>
    </div>
  );
}

function PriceBuckets({ b }: { b: WalletStats["buyPriceBuckets"] }) {
  const rows = [
    { label: "Longshot <10¢", value: b.longshot, hue: "#86b6ef" },
    { label: "Underdog 10–35¢", value: b.underdog, hue: "#5598e7" },
    { label: "Toss-up 35–65¢", value: b.tossup, hue: "#3987e5" },
    { label: "Favorite 65–90¢", value: b.favorite, hue: "#2a78d6" },
    { label: "Near-certain >90¢", value: b.nearCertain, hue: "#1c5cab" },
  ];
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Buy entries by price</h3>
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2 text-xs">
            <span className="w-36 shrink-0 text-[var(--text-secondary)]">{r.label}</span>
            <div className="h-3.5 flex-1">
              <div
                className="h-full rounded-r-[4px]"
                style={{ width: `${(r.value / max) * 100}%`, background: r.hue, minWidth: r.value > 0 ? 3 : 0 }}
              />
            </div>
            <span className="w-10 text-right tabular-nums text-[var(--text-primary)]">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TrustBadge({ analysis }: { analysis: Analysis }) {
  const rec = analysis.copyRecommendation;
  const recStyle: Record<string, { bg: string; label: string }> = {
    copy: { bg: "var(--good)", label: "COPY" },
    partial_copy: { bg: "var(--series-1)", label: "PARTIAL COPY" },
    observe: { bg: "var(--warning)", label: "OBSERVE" },
    avoid: { bg: "var(--critical)", label: "AVOID" },
  };
  const s = recStyle[rec] ?? recStyle.observe;
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div>
        <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Trust score</div>
        <div className="text-4xl font-bold tabular-nums text-[var(--text-primary)]">{Math.round(analysis.trustScore)}</div>
        <div className="text-xs text-[var(--text-muted)]">/ 100 · confidence {analysis.confidence}</div>
      </div>
      <div className="h-2 min-w-32 flex-1 overflow-hidden rounded bg-[var(--surface-3)]">
        <div className="h-full rounded" style={{ width: `${Math.min(100, Math.max(0, analysis.trustScore))}%`, background: "var(--series-1)" }} />
      </div>
      <span className="rounded px-3 py-1.5 text-sm font-bold text-black" style={{ background: s.bg }}>
        {s.label}
      </span>
    </div>
  );
}

export default function Home() {
  const [wallet, setWallet] = useState("");
  const [loading, setLoading] = useState<"stats" | "full" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doc, setDoc] = useState<AnalysisDoc | null>(null);
  const [history, setHistory] = useState<AnalysisDoc[]>([]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/analyses");
      if (res.ok) setHistory(await res.json());
    } catch {
      /* history is best-effort */
    }
  }, []);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((c) => setWallet((w) => w || c.defaultWallet || ""))
      .catch(() => {});
    void loadHistory();
  }, [loadHistory]);

  async function run(skipAnalysis: boolean) {
    setLoading(skipAnalysis ? "stats" : "full");
    setError(null);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet, skipAnalysis }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setDoc(data);
      void loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  }

  const s = doc?.stats;
  const a = doc?.analysis ?? null;
  const pnl = s ? pnlParts(s.realizedPnlUsdc) : null;

  return (
    <main className="viz-root mx-auto w-full max-w-6xl flex-1 px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[var(--text-primary)]">Polymarket Wallet Analyzer</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            Past-day trading breakdown + Claude strategy &amp; trust assessment for any target wallet.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/scout" className="text-[var(--series-1)] hover:underline">Scout</Link>
          <Link href="/live" className="text-[var(--series-1)] hover:underline">Live Test</Link>
          <Link href="/simulate" className="text-[var(--series-1)] hover:underline">Backtest →</Link>
        </div>
      </header>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <input
          value={wallet}
          onChange={(e) => setWallet(e.target.value)}
          placeholder="0x… wallet address"
          spellCheck={false}
          className="w-[420px] max-w-full rounded-md border border-[var(--edge)] bg-[var(--surface-2)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] outline-none focus:border-[var(--series-1)]"
        />
        <button
          onClick={() => run(false)}
          disabled={loading !== null}
          className="rounded-md bg-[var(--series-1)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {loading === "full" ? "Analyzing…" : "Analyze with Claude"}
        </button>
        <button
          onClick={() => run(true)}
          disabled={loading !== null}
          className="rounded-md border border-[var(--edge)] px-4 py-2 text-sm text-[var(--text-secondary)] disabled:opacity-50"
        >
          {loading === "stats" ? "Fetching…" : "Stats only"}
        </button>
      </div>

      {error && (
        <div className="mb-6 rounded-md border border-[var(--critical)] bg-[var(--surface-2)] px-4 py-3 text-sm text-[var(--text-primary)]">
          ⚠ {error}
        </div>
      )}

      {s && (
        <>
          <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <StatTile label="Trades (24h)" value={fmtNum(s.totalTrades, 0)} sub={`${s.buys} buys · ${s.sells} sells`} />
            <StatTile label="Volume" value={fmtUsd(s.volumeUsdc)} sub={`avg ${fmtUsd(s.avgTradeUsdc)} · max ${fmtUsd(s.maxTradeUsdc)}`} />
            <StatTile label="Realized P&L" value={pnl!.text} valueColor={pnl!.color} sub={s.redeemedUsdc > 0 ? `incl. ${fmtUsd(s.redeemedUsdc)} redeemed` : "window basis"} />
            <StatTile
              label="Win rate"
              value={s.winRate === null ? "—" : `${Math.round(s.winRate * 100)}%`}
              sub={`${s.wins}W / ${s.losses}L of ${s.roundTrips} exits`}
            />
            <StatTile label="Markets" value={fmtNum(s.distinctMarkets, 0)} sub={s.avgHoldMinutes !== null ? `~${fmtNum(s.avgHoldMinutes, 0)}m avg hold` : "no exits timed"} />
            <StatTile
              label="Open positions"
              value={fmtNum(s.openPositions.count, 0)}
              sub={`${fmtUsd(s.openPositions.totalCurrentValue)} · P&L ${pnlParts(s.openPositions.totalCashPnl).text}`}
            />
          </section>

          <section className="mb-6 grid gap-6 rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-4 md:grid-cols-2">
            <HourlyChart hours={s.hourlyActivity} />
            <PriceBuckets b={s.buyPriceBuckets} />
          </section>

          {a && (
            <section className="mb-6 space-y-4 rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-5">
              <TrustBadge analysis={a} />
              <div>
                <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Detected strategy</div>
                <div className="mt-1 font-semibold text-[var(--text-primary)]">{a.strategyType}</div>
                <p className="mt-1 text-sm leading-relaxed text-[var(--text-secondary)]">{a.strategySummary}</p>
                <p className="mt-2 text-sm text-[var(--text-secondary)]"><span className="text-[var(--text-muted)]">Timing:</span> {a.timingPatterns}</p>
                <p className="mt-1 text-sm text-[var(--text-secondary)]"><span className="text-[var(--text-muted)]">Focus:</span> {a.marketFocus.join(", ")} · <span className="text-[var(--text-muted)]">risk:</span> {a.riskProfile}</p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <div className="mb-1 text-xs uppercase tracking-wide" style={{ color: "var(--good)" }}>✓ Strengths</div>
                  <ul className="space-y-1 text-sm text-[var(--text-secondary)]">
                    {a.strengths.map((x, i) => <li key={i}>• {x}</li>)}
                  </ul>
                </div>
                <div>
                  <div className="mb-1 text-xs uppercase tracking-wide" style={{ color: "var(--critical)" }}>⚠ Red flags</div>
                  <ul className="space-y-1 text-sm text-[var(--text-secondary)]">
                    {a.redFlags.map((x, i) => <li key={i}>• {x}</li>)}
                  </ul>
                </div>
              </div>
              <div className="rounded-md bg-[var(--surface-3)] p-3 text-sm text-[var(--text-secondary)]">
                <div className="mb-1 text-xs uppercase tracking-wide text-[var(--text-muted)]">Why this score</div>
                {a.trustRationale}
                <div className="mt-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">Sizing advice</div>
                <div className="mt-0.5">{a.copySizingAdvice}</div>
              </div>
              {doc?.model && <div className="text-right text-[10px] text-[var(--text-muted)]">analysis by {doc.model}</div>}
            </section>
          )}

          <section className="mb-6 overflow-x-auto rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-4">
            <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Markets traded (top {Math.min(s.perMarket.length, 12)})</h3>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
                  <th className="py-1.5 pr-3 font-medium">Market</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Buys</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Sells</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Volume</th>
                  <th className="py-1.5 text-right font-medium">Realized P&L</th>
                </tr>
              </thead>
              <tbody>
                {s.perMarket.slice(0, 12).map((m) => {
                  const mp = m.realizedPnl !== null ? pnlParts(m.realizedPnl) : null;
                  return (
                    <tr key={m.conditionId} className="border-t border-[var(--edge)] text-[var(--text-primary)]">
                      <td className="max-w-md truncate py-1.5 pr-3">{m.title}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{m.buys}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{m.sells}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{fmtUsd(m.volumeUsdc)}</td>
                      <td className="py-1.5 text-right tabular-nums" style={{ color: mp?.color ?? "var(--text-muted)" }}>
                        {mp?.text ?? "n/a"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </>
      )}

      {history.length > 0 && (
        <section className="rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-4">
          <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Analysis history</h3>
          <ul className="divide-y divide-[var(--edge)] text-sm">
            {history.map((h) => (
              <li key={h.id}>
                <button
                  className="flex w-full items-center gap-3 py-2 text-left hover:bg-[var(--surface-3)]"
                  onClick={() => { setDoc(h); setWallet(h.wallet); }}
                >
                  <span className="font-mono text-xs text-[var(--text-secondary)]">{h.wallet.slice(0, 6)}…{h.wallet.slice(-4)}</span>
                  <span className="text-[var(--text-muted)]">{new Date(h.createdAt).toLocaleString()}</span>
                  <span className="tabular-nums text-[var(--text-secondary)]">{h.stats.totalTrades} trades</span>
                  {h.analysis ? (
                    <span className="ml-auto tabular-nums text-[var(--text-primary)]">trust {Math.round(h.analysis.trustScore)}</span>
                  ) : (
                    <span className="ml-auto text-[var(--text-muted)]">stats only</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
