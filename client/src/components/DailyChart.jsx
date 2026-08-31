import { useState } from 'react';
import {
  STATUS_STYLE,
  axisTicks,
  longDate,
  niceMax,
  shortDate,
  useElementWidth,
} from '../lib/viz.js';

const PAD = { top: 14, right: 8, bottom: 26, left: 30 };
const HEIGHT = 240;
const MAX_BAR = 24; // never fill the band; the leftover is air
const SEGMENT_GAP = 2; // surface gap between stacked segments
const RADIUS = 4; // rounded data-end, square at the baseline

// A stacked column per day: the segments are the four statuses, so the full height of
// a column is that day's bid count. One chart answers "how many did I send" and
// "how did they land" at once, without a second axis.
export default function DailyChart({ daily, granularity = 'day' }) {
  const [hover, setHover] = useState(null);
  const [wrapRef, width] = useElementWidth();

  const max = niceMax(Math.max(...daily.map((d) => d.total), 0));
  const ticks = axisTicks(max);
  const plotW = Math.max(120, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = plotW / Math.max(1, daily.length);
  // Never wider than the band itself, or neighbouring columns would overlap.
  const barW = Math.max(1, Math.min(MAX_BAR, band - 4));
  const scale = (value) => (value / max) * plotH;

  // Thin x labels until they stop colliding.
  const labelStep = Math.max(1, Math.ceil(daily.length / Math.max(2, Math.floor(plotW / 64))));

  const totalInRange = daily.reduce((sum, d) => sum + d.total, 0);

  return (
    <div className="chart" ref={wrapRef}>
      {totalInRange === 0 ? (
        <p className="chart-empty">No applications in this range.</p>
      ) : (
        <div className="chart-plot">
          <svg width={width} height={HEIGHT} role="img" aria-label={`Applications per ${granularity} by status`}>
            {ticks.map((t) => {
              const y = PAD.top + plotH - scale(t);
              return (
                <g key={t}>
                  <line
                    x1={PAD.left}
                    x2={PAD.left + plotW}
                    y1={y}
                    y2={y}
                    className={t === 0 ? 'axis-line' : 'grid-line'}
                  />
                  <text x={PAD.left - 8} y={y + 4} className="axis-text" textAnchor="end">
                    {t}
                  </text>
                </g>
              );
            })}

            {daily.map((day, i) => {
              const x = PAD.left + i * band + (band - barW) / 2;
              const isHovered = hover === i;
              const segments = stackSegments(day, PAD.top + plotH, scale);

              return (
                <g key={day.date} opacity={hover === null || isHovered ? 1 : 0.45}>
                  {segments.map((seg, idx) => (
                    <path
                      key={seg.status.key}
                      d={roundedTop(
                        x,
                        seg.yTop,
                        barW,
                        Math.max(2, seg.yBottom - seg.yTop),
                        idx === segments.length - 1 ? RADIUS : 0,
                      )}
                      fill={seg.status.color}
                    />
                  ))}

                  {/* Hit target spans the full band so short columns stay easy to hover. */}
                  <rect
                    x={PAD.left + i * band}
                    y={PAD.top}
                    width={band}
                    height={plotH}
                    fill="transparent"
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                  />

                  {i % labelStep === 0 && (
                    <text
                      x={x + barW / 2}
                      y={HEIGHT - 8}
                      className="axis-text"
                      textAnchor="middle"
                    >
                      {shortDate(day.date)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>

          {hover !== null && daily[hover] && (
            <div
              className="tooltip"
              style={{
                left: `${Math.min(Math.max(PAD.left + hover * band + band / 2, 90), width - 90)}px`,
              }}
            >
              <strong>
                {granularity === 'week' ? 'Week of ' : ''}
                {longDate(daily[hover].date)}
              </strong>
              <span className="tooltip-total">
                {daily[hover].total} bid{daily[hover].total === 1 ? '' : 's'}
              </span>
              {STATUS_STYLE.filter((s) => daily[hover][s.key] > 0).map((s) => (
                <span key={s.key} className="tooltip-row">
                  <i className="swatch" style={{ background: s.color }} />
                  {s.label}
                  <b>{daily[hover][s.key]}</b>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Exact stack geometry first, then the 2px surface gap is taken off the bottom of every
// segment above the first — so the gaps sit between segments and the column's overall
// height still reads as the true daily total.
function stackSegments(day, baselineY, scale) {
  const segments = [];
  let acc = 0;
  STATUS_STYLE.forEach((status) => {
    const value = day[status.key] || 0;
    if (value === 0) return;
    const yBottom = baselineY - scale(acc);
    acc += value;
    segments.push({ status, yTop: baselineY - scale(acc), yBottom });
  });
  return segments.map((seg, idx) =>
    idx === 0 ? seg : { ...seg, yBottom: seg.yBottom - SEGMENT_GAP },
  );
}

// Rounded on the data-end only; the baseline end stays square.
function roundedTop(x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h);
  if (radius <= 0) return `M${x},${y} h${w} v${h} h${-w} Z`;
  return [
    `M${x},${y + radius}`,
    `a${radius},${radius} 0 0 1 ${radius},${-radius}`,
    `h${w - radius * 2}`,
    `a${radius},${radius} 0 0 1 ${radius},${radius}`,
    `v${h - radius}`,
    `h${-w}`,
    'Z',
  ].join(' ');
}
