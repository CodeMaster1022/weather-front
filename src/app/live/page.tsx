"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const fmtNum = (n: number, frac = 0) => n.toLocaleString("en-US", { maximumFractionDigits: frac });

function signColor(n: number): string {
  if (n > 0.005) return "var(--good)";
  if (n < -0.005) return "var(--critical)";
  return "var(--text-secondary)";
}
function signed(n: number): string {
  return `${n >= 0 ? "+" : "−"}${fmtUsd(Math.abs(n))}`;
}
function ago(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

interface LiveData {
  active: boolean;
  message?: string;
  account: {
    bankroll: number; stake: number; stakeMode: string; cash: number; realizedPnl: number;
    copiedBuys: number; skipped: number; sells: number; wins: number; losses: number;
    startedAt: string; updatedAt: string;
  };
  openValue: number; unrealizedPnl: number; totalEquity: number; totalPnl: number; returnPct: number;
  winRate: number | null;
  openPositions: Array<{ id: string; wallet: string; title: string; outcome: string; shares: number; entryPrice: number; markPrice: number; marked: boolean; markValue: number; unrealizedPnl: number; openedTs: number }>;
  closedTrades: Array<{ nickname: string; title: string; outcome: string; entryPrice: number; exitPrice: number; pnl: number; closedTs: number; manual?: boolean }>;
  realizedCurve: Array<{ ts: number; equity: number }>;
}

function StatTile({ label, value, sub, valueColor }: { label: string; value: string; sub?: string; valueColor?: string }) {
  return (
    <div className="rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: valueColor ?? "var(--text-primary)" }}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-[var(--text-secondary)]">{sub}</div>}
    </div>
  );
}

function RealizedCurve({ curve, bankroll }: { curve: Array<{ ts: number; equity: number }>; bankroll: number }) {
  const W = 720, H = 160, pad = { l: 56, r: 12, t: 10, b: 20 };
  const { path, area } = useMemo(() => {
    if (curve.length < 2) return { path: "", area: "" };
    const x0 = curve[0].ts, x1 = curve[curve.length - 1].ts;
    const eqs = curve.map((p) => p.equity);
    const lo = Math.min(...eqs, bankroll), hi = Math.max(...eqs, bankroll);
    const span = hi - lo || 1;
    const sx = (t: number) => pad.l + ((t - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
    const sy = (e: number) => pad.t + (1 - (e - (lo - span * 0.1)) / (span * 1.2)) * (H - pad.t - pad.b);
    const p = curve.map((pt, i) => `${i === 0 ? "M" : "L"}${sx(pt.ts).toFixed(1)},${sy(pt.equity).toFixed(1)}`).join(" ");
    const a = `${p} L${sx(x1).toFixed(1)},${sy(lo - span * 0.1).toFixed(1)} L${sx(x0).toFixed(1)},${sy(lo - span * 0.1).toFixed(1)} Z`;
    return { path: p, area: a };
  }, [curve, bankroll]);

  if (curve.length < 2) {
    return <div className="py-8 text-center text-sm text-[var(--text-muted)]">No closed trades yet — the realized curve appears once a copied position is sold.</div>;
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <path d={area} fill="var(--series-1)" opacity="0.12" />
      <path d={path} fill="none" stroke="var(--series-1)" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

export default function LivePage() {
  const [data, setData] = useState<LiveData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [loading, setLoading] = useState(false);
  const [sellingId, setSellingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/live", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json);
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
    const id = setInterval(() => void load(), 20000);
    return () => clearInterval(id);
  }, [auto, load]);

  async function reset() {
    if (!confirm("Reset the paper portfolio back to the full bankroll? This clears all open and closed trades.")) return;
    await fetch("/api/live/reset", { method: "POST" });
    await load();
  }

  async function sellPosition(id: string, title: string) {
    if (!confirm(`Manually sell your paper position in "${title}" now, at Polymarket's current bid?`)) return;
    setSellingId(id);
    setError(null);
    try {
      const res = await fetch("/api/live/sell", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSellingId(null);
    }
  }

  const d = data;

  return (
    <main className="viz-root mx-auto w-full max-w-6xl flex-1 px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[var(--text-primary)]">Live Copy-Trade</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            The bot opens a virtual position on every BUY signal and closes it on the matching SELL — or close any position
            yourself with the Sell button.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/real" className="font-semibold text-[var(--critical)] hover:underline">Live Account</Link>
          <Link href="/simulate" className="text-[var(--series-1)] hover:underline">Backtest</Link>
          <Link href="/" className="text-[var(--series-1)] hover:underline">Analyzer</Link>
        </div>
      </header>

      <div className="mb-6 flex flex-wrap items-center gap-3 text-xs text-[var(--text-secondary)]">
        <label className="inline-flex items-center gap-1.5">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto-refresh 20s
        </label>
        <button onClick={load} disabled={loading} className="rounded border border-[var(--edge)] px-2 py-1 disabled:opacity-50">
          {loading ? "refreshing…" : "refresh now"}
        </button>
        {d?.active && <span className="text-[var(--text-muted)]">updated {ago(Math.floor(new Date(d.account.updatedAt).getTime() / 1000))}</span>}
        <button onClick={reset} className="ml-auto rounded border border-[var(--critical)] px-2 py-1 text-[var(--critical)]">reset portfolio</button>
      </div>

      {error && <div className="mb-6 rounded-md border border-[var(--critical)] bg-[var(--surface-2)] px-4 py-3 text-sm">⚠ {error}</div>}

      {d && !d.active && (
        <div className="rounded-md border border-[var(--edge)] bg-[var(--surface-2)] px-4 py-6 text-sm text-[var(--text-secondary)]">
          {d.message ?? "No paper account yet."} It will appear here as soon as a watched wallet trades.
        </div>
      )}

      {d?.active && (
        <>
          <section className="mb-6 rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-5">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Current equity</div>
                <div className="text-4xl font-bold tabular-nums" style={{ color: signColor(d.totalPnl) }}>{fmtUsd(d.totalEquity)}</div>
                <div className="text-sm tabular-nums" style={{ color: signColor(d.totalPnl) }}>
                  {signed(d.totalPnl)} ({d.returnPct >= 0 ? "+" : ""}{fmtNum(d.returnPct, 1)}%) on {fmtUsd(d.account.bankroll)} · since {new Date(d.account.startedAt).toLocaleDateString()}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                <span className="text-[var(--text-muted)]">Realized (cash)</span>
                <span className="text-right tabular-nums" style={{ color: signColor(d.account.realizedPnl) }}>{signed(d.account.realizedPnl)}</span>
                <span className="text-[var(--text-muted)]">Unrealized</span>
                <span className="text-right tabular-nums" style={{ color: signColor(d.unrealizedPnl) }}>{signed(d.unrealizedPnl)}</span>
                <span className="text-[var(--text-muted)]">Cash / open value</span>
                <span className="text-right tabular-nums text-[var(--text-primary)]">{fmtUsd(d.account.cash)} / {fmtUsd(d.openValue)}</span>
              </div>
            </div>
            <div className="mt-4">
              <h3 className="mb-1 text-sm font-medium text-[var(--text-secondary)]">Realized equity (bankroll + booked P&L)</h3>
              <RealizedCurve curve={d.realizedCurve} bankroll={d.account.bankroll} />
            </div>
          </section>

          <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <StatTile label="Open now" value={fmtNum(d.openPositions.length)} sub={`${fmtUsd(d.openValue)} at market`} />
            <StatTile label="Copied buys" value={fmtNum(d.account.copiedBuys)} sub={`${d.account.sells} sold`} />
            <StatTile label="Win / loss" value={`${d.account.wins} / ${d.account.losses}`} sub={d.winRate === null ? "no exits yet" : `${Math.round(d.winRate * 100)}% win rate`} />
            <StatTile label="Skipped (no cash)" value={fmtNum(d.account.skipped)} valueColor={d.account.skipped > d.account.copiedBuys * 2 ? "var(--warning)" : undefined} sub="bankroll-limited" />
            <StatTile label="Cash free" value={fmtUsd(d.account.cash)} sub={`${Math.floor(d.account.cash / d.account.stake)} more slots`} />
            <StatTile label="Max stake / mode" value={fmtUsd(d.account.stake)} sub={d.account.stakeMode} />
          </section>

     

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="overflow-x-auto rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-4">
              <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Open positions ({d.openPositions.length})</h3>
              {d.openPositions.length === 0 ? (
                <div className="py-4 text-sm text-[var(--text-muted)]">No open positions right now.</div>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead><tr className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
                    <th className="py-1.5 pr-2 font-medium">Wallet</th><th className="py-1.5 pr-2 font-medium">Market</th>
                    <th className="py-1.5 pr-2 text-right font-medium">Entry→Mark</th><th className="py-1.5 pr-2 text-right font-medium">Unreal.</th>
                    <th className="py-1.5 text-right font-medium"></th>
                  </tr></thead>
                  <tbody>
                    {d.openPositions.map((p) => (
                      <tr key={p.id} className="border-t border-[var(--edge)] text-[var(--text-primary)]">
                        <td className="py-1.5 pr-2 text-[var(--text-secondary)]">{p.wallet}</td>
                        <td className="max-w-[11rem] truncate py-1.5 pr-2">{p.title}<span className="text-[var(--text-muted)]"> · {p.outcome}</span></td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">${p.entryPrice.toFixed(2)}→${p.markPrice.toFixed(2)}{!p.marked && <span title="no live mark" className="text-[var(--text-muted)]">*</span>}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums" style={{ color: signColor(p.unrealizedPnl) }}>{signed(p.unrealizedPnl)}</td>
                        <td className="py-1.5 text-right">
                          <button
                            onClick={() => sellPosition(p.id, p.title)}
                            disabled={sellingId !== null}
                            className="rounded border border-[var(--edge)] px-2 py-0.5 text-xs text-[var(--series-1)] hover:bg-[var(--surface-3)] disabled:opacity-40"
                          >
                            {sellingId === p.id ? "selling…" : "Sell"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="overflow-x-auto rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-4">
              <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Closed trades ({d.closedTrades.length})</h3>
              {d.closedTrades.length === 0 ? (
                <div className="py-4 text-sm text-[var(--text-muted)]">None yet — closes when a target sells a copied market.</div>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead><tr className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
                    <th className="py-1.5 pr-2 font-medium">When</th><th className="py-1.5 pr-2 font-medium">Market</th>
                    <th className="py-1.5 pr-2 text-right font-medium">In→Out</th><th className="py-1.5 text-right font-medium">P&L</th>
                  </tr></thead>
                  <tbody>
                    {d.closedTrades.map((t, i) => (
                      <tr key={i} className="border-t border-[var(--edge)] text-[var(--text-primary)]">
                        <td className="py-1.5 pr-2 text-xs text-[var(--text-secondary)]">{ago(t.closedTs)}</td>
                        <td className="max-w-[13rem] truncate py-1.5 pr-2">{t.title}{t.manual && <span className="ml-1 rounded bg-[var(--surface-3)] px-1 text-[10px] uppercase text-[var(--text-muted)]">manual</span>}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">${t.entryPrice.toFixed(2)}→${t.exitPrice.toFixed(2)}</td>
                        <td className="py-1.5 text-right tabular-nums" style={{ color: signColor(t.pnl) }}>{signed(t.pnl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        </>
      )}
    </main>
  );
}
