import { useState } from 'react';
import { SERIES_BLUE, STATUS_STYLE, niceMax, useElementWidth } from '../lib/viz.js';

const ROW = 34;
const BAR = 20; // <= 24px; the band's leftover is air
const RADIUS = 4;
const LABEL_W = 130;
const VALUE_W = 34;

// One measure across three profiles, so it is one color — not three. Color would be
// encoding the row label a second time and would imply the profiles are series.
export default function ProfileChart({ profiles, metric = 'interview' }) {
  const [hover, setHover] = useState(null);
  const [wrapRef, width] = useElementWidth();

  const rows = [...profiles].sort((a, b) => b[metric] - a[metric]);
  const max = niceMax(Math.max(...rows.map((p) => p[metric]), 0));
  const plotW = Math.max(60, width - LABEL_W - VALUE_W);
  const height = rows.length * ROW;

  return (
    <div className="chart" ref={wrapRef}>
      <div className="chart-plot">
        <svg width={width} height={height} role="img" aria-label="Interviews by profile">
          {rows.map((row, i) => {
            const y = i * ROW;
            const w = max > 0 ? (row[metric] / max) * plotW : 0;
            return (
              <g
                key={row.profileName}
                opacity={hover === null || hover === i ? 1 : 0.45}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                <rect x={0} y={y} width={width} height={ROW} fill="transparent" />
                <text x={0} y={y + ROW / 2 + 4} className="axis-text strong-text">
                  {row.profileName}
                </text>
                {row[metric] > 0 && (
                  <path
                    d={roundedEnd(LABEL_W, y + (ROW - BAR) / 2, Math.max(2, w), BAR, RADIUS)}
                    fill={SERIES_BLUE}
                  />
                )}
                <text
                  x={LABEL_W + Math.max(2, w) + 8}
                  y={y + ROW / 2 + 4}
                  className="axis-text value-text"
                >
                  {row[metric]}
                </text>
              </g>
            );
          })}
        </svg>

        {hover !== null && rows[hover] && (
          <div className="tooltip tooltip-left" style={{ top: `${hover * ROW + ROW}px` }}>
            <strong>{rows[hover].profileName}</strong>
            <span className="tooltip-total">
              {rows[hover].total} bid{rows[hover].total === 1 ? '' : 's'} ·{' '}
              {rows[hover].interviewRate}% reply rate
            </span>
            {STATUS_STYLE.filter((s) => rows[hover][s.key] > 0).map((s) => (
              <span key={s.key} className="tooltip-row">
                <i className="swatch" style={{ background: s.color }} />
                {s.label}
                <b>{rows[hover][s.key]}</b>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Rounded on the data-end (right); square where it meets the baseline (left).
function roundedEnd(x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  if (radius <= 0) return `M${x},${y} h${w} v${h} h${-w} Z`;
  return [
    `M${x},${y}`,
    `h${w - radius}`,
    `a${radius},${radius} 0 0 1 ${radius},${radius}`,
    `v${h - radius * 2}`,
    `a${radius},${radius} 0 0 1 ${-radius},${radius}`,
    `h${-(w - radius)}`,
    'Z',
  ].join(' ');
}
