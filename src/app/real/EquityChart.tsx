"use client";

import { useId, useRef, useState } from "react";

export interface EquityPoint {
  ts: number;
  cash: number;
  equity: number;
}
export interface VolumeBucket {
  ts: number;
  buy: number;
  sell: number;
  total: number;
}
export interface EquityData {
  points: EquityPoint[];
  maxCash: number;
  maxEquity: number;
  peakTs: number;
  volume?: VolumeBucket[];
  maxVolume?: number;
  bucketSec?: number;
}

const W = 820;
const H = 300;
const PAD = { l: 6, r: 6, t: 20 };
const MAIN_H = 176; // value panel height
const GAP = 14;
const VOL_H = 56; // volume panel height
const PLOT_W = W - PAD.l - PAD.r;
const MAIN_B = PAD.t + MAIN_H; // value baseline
const VOL_T = MAIN_B + GAP; // volume panel top
const VOL_B = VOL_T + VOL_H; // volume baseline

const fmtUsd = (n: number) => `$${(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const fmtAxis = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`);
const fmtTime = (ts: number) =>
  new Date(ts * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * Exchange-style layout: total value (gradient area + line) on top, a trade-
 * volume histogram below, sharing one time axis. Value is a single-hue
 * composite (cash = the area, total value = the line); volume bars are buys
 * over sells stacked. Peak of total value is directly labeled.
 */
export default function EquityChart({ data, showBalance }: { data: EquityData; showBalance: boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const gradId = useId();
  const [hover, setHover] = useState<number | null>(null);
  const pts = data.points;
  const vol = data.volume ?? [];
  const maxVol = data.maxVolume ?? 0;

  if (pts.length < 2) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-[var(--edge)] text-xs text-[var(--text-muted)]">
        Recording started — the chart fills in as snapshots accrue (every ~2 min).
      </div>
    );
  }

  const t0 = pts[0].ts;
  const t1 = pts[pts.length - 1].ts;
  const span = Math.max(1, t1 - t0);
  const yMax = Math.max(data.maxEquity, 1) * 1.08;

  const x = (ts: number) => PAD.l + ((ts - t0) / span) * PLOT_W;
  const y = (v: number) => PAD.t + MAIN_H - (v / yMax) * MAIN_H;
  const vy = (v: number) => VOL_B - (maxVol > 0 ? (v / maxVol) * VOL_H : 0);

  const linePath = (key: "cash" | "equity") =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.ts).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(" ");
  const areaTop = (key: "cash" | "equity") =>
    `M ${x(t0).toFixed(1)} ${MAIN_B} ` +
    pts.map((p) => `L ${x(p.ts).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(" ") +
    ` L ${x(t1).toFixed(1)} ${MAIN_B} Z`;

  const ticks = 4;
  const gridVals = Array.from({ length: ticks + 1 }, (_, i) => (yMax / ticks) * i);
  const bucketSec = data.bucketSec ?? span / 48;
  const barW = Math.max(1.5, (bucketSec / span) * PLOT_W - 1.5);

  const hp = hover !== null ? pts[hover] : null;
  // nearest volume bucket to the hovered time
  const hv = hp ? vol.reduce<VolumeBucket | null>((best, b) => {
    if (!best) return b;
    return Math.abs(b.ts - hp.ts) < Math.abs(best.ts - hp.ts) ? b : best;
  }, null) : null;

  const onMove = (clientX: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const ts = t0 + ratio * span;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < pts.length; i += 1) {
      const d = Math.abs(pts[i].ts - ts);
      if (d < bestD) { bestD = d; best = i; }
    }
    setHover(best);
  };

  const mask = (n: number) => (showBalance ? fmtUsd(n) : "••••");

  return (
    <div>
      <div ref={wrapRef} className="relative" onMouseMove={(e) => onMove(e.clientX)} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: "auto" }} role="img" aria-label="Cash, total value, and trade volume over time">
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0.02} />
            </linearGradient>
          </defs>

          {/* gridlines + y labels (value panel) */}
          {gridVals.map((v, i) => (
            <g key={i}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--edge)" strokeWidth={1} />
              {showBalance && (
                <text x={PAD.l + 2} y={y(v) - 3} fontSize={10} fill="var(--text-muted)">{fmtAxis(v)}</text>
              )}
            </g>
          ))}

          {/* total value: gradient area + line; cash: dashed line */}
          <path d={areaTop("equity")} fill={`url(#${gradId})`} stroke="none" />
          <path d={linePath("cash")} fill="none" stroke="var(--series-1)" strokeWidth={1} strokeOpacity={0.5} strokeDasharray="3 3" />
          <path d={linePath("equity")} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" />

          {/* peak marker */}
          <circle cx={x(data.peakTs)} cy={y(data.maxEquity)} r={4} fill="var(--series-1)" stroke="var(--surface-2)" strokeWidth={2} />
          {showBalance && (
            <text
              x={Math.min(W - PAD.r - 4, Math.max(PAD.l + 30, x(data.peakTs)))}
              y={Math.max(10, y(data.maxEquity) - 8)}
              fontSize={10} fontWeight={600} textAnchor="middle" fill="var(--text-secondary)"
            >
              peak {fmtUsd(data.maxEquity)}
            </text>
          )}

          {/* volume panel */}
          <line x1={PAD.l} x2={W - PAD.r} y1={VOL_B} y2={VOL_B} stroke="var(--edge)" strokeWidth={1} />
          <text x={PAD.l + 2} y={VOL_T + 9} fontSize={9} fill="var(--text-muted)">VOLUME</text>
          {vol.map((b) => {
            const bx = x(b.ts) - barW / 2;
            const sellH = VOL_B - vy(b.sell);
            const buyH = VOL_B - vy(b.total) - sellH;
            return (
              <g key={b.ts}>
                {/* sell on the bottom, buy stacked above — 1px surface gap between */}
                {b.sell > 0 && <rect x={bx} y={vy(b.sell)} width={barW} height={Math.max(0.5, sellH)} fill="var(--text-muted)" opacity={0.6} />}
                {b.buy > 0 && <rect x={bx} y={vy(b.total)} width={barW} height={Math.max(0.5, buyH - 1)} fill="var(--series-1)" opacity={0.85} />}
              </g>
            );
          })}

          {/* hover crosshair + dots */}
          {hp && (
            <g>
              <line x1={x(hp.ts)} x2={x(hp.ts)} y1={PAD.t} y2={VOL_B} stroke="var(--text-muted)" strokeWidth={1} strokeDasharray="2 2" />
              <circle cx={x(hp.ts)} cy={y(hp.equity)} r={3.5} fill="var(--series-1)" stroke="var(--surface-2)" strokeWidth={1.5} />
              <circle cx={x(hp.ts)} cy={y(hp.cash)} r={3} fill="var(--surface-2)" stroke="var(--series-1)" strokeWidth={1.5} />
            </g>
          )}

          {/* x endpoints */}
          <text x={PAD.l} y={H - 4} fontSize={10} fill="var(--text-muted)">{fmtTime(t0)}</text>
          <text x={W - PAD.r} y={H - 4} fontSize={10} textAnchor="end" fill="var(--text-muted)">{fmtTime(t1)}</text>
        </svg>

        {/* tooltip */}
        {hp && (
          <div
            className="pointer-events-none absolute z-10 rounded border border-[var(--edge)] bg-[var(--surface-3)] px-2 py-1 text-[11px] leading-tight text-[var(--text-primary)] shadow"
            style={{ left: `${((x(hp.ts)) / W) * 100}%`, top: 0, transform: "translateX(-50%)" }}
          >
            <div className="text-[var(--text-muted)]">{fmtTime(hp.ts)}</div>
            <div>Total <span className="tabular-nums font-semibold">{mask(hp.equity)}</span></div>
            <div className="text-[var(--text-secondary)]">Cash <span className="tabular-nums">{mask(hp.cash)}</span></div>
            {hv && (hv.buy > 0 || hv.sell > 0) && (
              <div className="mt-0.5 border-t border-[var(--edge)] pt-0.5 text-[var(--text-muted)]">
                Vol <span className="tabular-nums text-[var(--text-secondary)]">{mask(hv.total)}</span>
                <span className="tabular-nums"> ({mask(hv.buy)} buy / {mask(hv.sell)} sell)</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* legend */}
      <div className="mt-1 flex flex-wrap items-center gap-4 text-[11px] text-[var(--text-secondary)]">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded" style={{ background: "var(--series-1)" }} /> Total value
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-3 rounded-sm" style={{ background: "var(--series-1)", opacity: 0.28 }} /> Cash
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2 rounded-sm" style={{ background: "var(--series-1)", opacity: 0.85 }} /> Buy vol
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2 rounded-sm" style={{ background: "var(--text-muted)", opacity: 0.6 }} /> Sell vol
        </span>
        <span className="ml-auto text-[var(--text-muted)]">peak {showBalance ? fmtUsd(data.maxEquity) : "••••"}</span>
      </div>
    </div>
  );
}
