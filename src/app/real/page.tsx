"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

const fmtUsd = (n: number) =>
  (n ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

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

interface RealData {
  active: boolean;
  message?: string;
  account: {
    realizedPnl: number; exposure: number; dailyPnl: number; killed: boolean; buys: number; sells: number;
    startedAt: string; updatedAt: string; mode?: string; perTradeUsdc?: number; exposureCapUsdc?: number;
    dailyLossLimitUsdc?: number; slippageBps?: number; usdcBalance?: number; usdcAllowance?: number;
  };
  openPositions: Array<{ wallet: string; title: string; outcome: string; shares: number; entryPrice: number; markPrice: number; marked: boolean; markValue: number; unrealizedPnl: number; orderId: string | null }>;
  openValue: number;
  unrealizedPnl: number;
  orders: Array<{ ts: number; side: string; wallet: string; title: string; usdc: number; price: number; status: string; reason: string; dryRun: boolean }>;
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

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="mt-1 h-2 overflow-hidden rounded bg-[var(--surface-3)]">
      <div className="h-full rounded" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  placed: "var(--good)", "dry-run": "var(--series-1)", skipped: "var(--text-muted)", error: "var(--critical)",
};

export default function RealPage() {
  const [d, setD] = useState<RealData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/real", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setD(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => void load(), 15000);
    return () => clearInterval(id);
  }, [auto, load]);

  const a = d?.account;
  const mode = a?.mode ?? "disabled";
  const modeBanner =
    mode === "live"
      ? { text: "● LIVE — REAL ORDERS ARE BEING PLACED", bg: "var(--critical)", fg: "#fff" }
      : mode === "dry-run"
        ? { text: "◐ DRY-RUN — shadowing real orders, nothing posted", bg: "var(--series-1)", fg: "#fff" }
        : { text: "○ DISABLED — executor is off", bg: "var(--surface-3)", fg: "var(--text-secondary)" };

  const totalPnl = (a?.realizedPnl ?? 0) + (d?.unrealizedPnl ?? 0);

  return (
    <main className="viz-root mx-auto w-full max-w-6xl flex-1 px-6 py-8">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[var(--text-primary)]">Live Account (Real Money)</h1>
          <p className="text-sm text-[var(--text-secondary)]">Real CLOB orders placed by the executor, with guardrail status.</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/live" className="text-[var(--series-1)] hover:underline">Paper Test</Link>
          <Link href="/" className="text-[var(--series-1)] hover:underline">Analyzer</Link>
        </div>
      </header>

      <div className="mb-6 rounded-md px-4 py-2 text-sm font-bold" style={{ background: modeBanner.bg, color: modeBanner.fg }}>
        {modeBanner.text}
      </div>

      <div className="mb-6 flex items-center gap-3 text-xs text-[var(--text-secondary)]">
        <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto-refresh 15s</label>
        <button onClick={load} className="rounded border border-[var(--edge)] px-2 py-1">refresh now</button>
        {a && <span className="text-[var(--text-muted)]">updated {ago(Math.floor(new Date(a.updatedAt).getTime() / 1000))}</span>}
      </div>

      {error && <div className="mb-6 rounded-md border border-[var(--critical)] bg-[var(--surface-2)] px-4 py-3 text-sm">⚠ {error}</div>}

      {d && !d.active && (
        <div className="rounded-md border border-[var(--edge)] bg-[var(--surface-2)] px-4 py-6 text-sm text-[var(--text-secondary)]">
          {d.message ?? "No live activity yet."} Add credentials and set <code>LIVE_ENABLED=1</code> to start (dry-run first).
        </div>
      )}

      {a && (
        <>
          {a.killed && (
            <div className="mb-6 rounded-md border border-[var(--critical)] bg-[var(--surface-2)] px-4 py-3 text-sm font-semibold" style={{ color: "var(--critical)" }}>
              🛑 KILL SWITCH ACTIVE — daily loss limit hit; buying is halted until UTC midnight reset.
            </div>
          )}

          <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <StatTile label="Total P&L" value={signed(totalPnl)} valueColor={signColor(totalPnl)} sub={`realized ${signed(a.realizedPnl)}`} />
            <StatTile label="Today's P&L" value={signed(a.dailyPnl)} valueColor={signColor(a.dailyPnl)} sub={`kill at −${fmtUsd(a.dailyLossLimitUsdc ?? 0)}`} />
            <StatTile label="USDC balance" value={fmtUsd(a.usdcBalance ?? 0)} sub={`allowance ${fmtUsd(a.usdcAllowance ?? 0)}`} valueColor={(a.usdcAllowance ?? 0) < (a.perTradeUsdc ?? 0) ? "var(--warning)" : undefined} />
            <StatTile label="Open positions" value={String(d.openPositions.length)} sub={`${fmtUsd(d.openValue)} at bid`} />
            <StatTile label="Orders" value={`${a.buys} / ${a.sells}`} sub="buys / sells" />
            <StatTile label="Per trade / slip" value={fmtUsd(a.perTradeUsdc ?? 0)} sub={`${a.slippageBps ?? 0}bps max`} />
          </section>

          <section className="mb-6 grid gap-4 rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-4 md:grid-cols-2">
            <div>
              <div className="flex justify-between text-sm"><span className="text-[var(--text-secondary)]">Exposure</span>
                <span className="tabular-nums text-[var(--text-primary)]">{fmtUsd(a.exposure)} / {fmtUsd(a.exposureCapUsdc ?? 0)}</span></div>
              <Bar value={a.exposure} max={a.exposureCapUsdc ?? 1} color="var(--series-1)" />
            </div>
            <div>
              <div className="flex justify-between text-sm"><span className="text-[var(--text-secondary)]">Daily loss vs kill limit</span>
                <span className="tabular-nums" style={{ color: signColor(a.dailyPnl) }}>{signed(a.dailyPnl)}</span></div>
              <Bar value={Math.max(0, -a.dailyPnl)} max={a.dailyLossLimitUsdc ?? 1} color="var(--critical)" />
            </div>
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="overflow-x-auto rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-4">
              <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Open positions ({d.openPositions.length})</h3>
              {d.openPositions.length === 0 ? (
                <div className="py-4 text-sm text-[var(--text-muted)]">No open positions.</div>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead><tr className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
                    <th className="py-1.5 pr-2 font-medium">Market</th><th className="py-1.5 pr-2 text-right font-medium">Entry→Bid</th>
                    <th className="py-1.5 pr-2 text-right font-medium">Value</th><th className="py-1.5 text-right font-medium">Unreal.</th>
                  </tr></thead>
                  <tbody>
                    {d.openPositions.map((p, i) => (
                      <tr key={i} className="border-t border-[var(--edge)] text-[var(--text-primary)]">
                        <td className="max-w-[12rem] truncate py-1.5 pr-2">{p.title}<span className="text-[var(--text-muted)]"> · {p.outcome}</span></td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">${p.entryPrice.toFixed(2)}→${p.markPrice.toFixed(2)}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{fmtUsd(p.markValue)}</td>
                        <td className="py-1.5 text-right tabular-nums" style={{ color: signColor(p.unrealizedPnl) }}>{signed(p.unrealizedPnl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="overflow-x-auto rounded-lg border border-[var(--edge)] bg-[var(--surface-2)] p-4">
              <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Order log ({d.orders.length})</h3>
              {d.orders.length === 0 ? (
                <div className="py-4 text-sm text-[var(--text-muted)]">No order attempts yet.</div>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead><tr className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
                    <th className="py-1.5 pr-2 font-medium">When</th><th className="py-1.5 pr-2 font-medium">Side</th>
                    <th className="py-1.5 pr-2 font-medium">Market</th><th className="py-1.5 font-medium">Status</th>
                  </tr></thead>
                  <tbody>
                    {d.orders.map((o, i) => (
                      <tr key={i} className="border-t border-[var(--edge)] text-[var(--text-primary)]">
                        <td className="py-1.5 pr-2 text-xs text-[var(--text-secondary)]">{ago(o.ts)}</td>
                        <td className="py-1.5 pr-2">{o.side}</td>
                        <td className="max-w-[10rem] truncate py-1.5 pr-2">{o.title}</td>
                        <td className="py-1.5">
                          <span style={{ color: STATUS_COLOR[o.status] ?? "var(--text-secondary)" }}>{o.status}</span>
                          {o.reason && <span className="text-[var(--text-muted)]"> · {o.reason}</span>}
                        </td>
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
