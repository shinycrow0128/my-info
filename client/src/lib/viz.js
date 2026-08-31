import { useEffect, useRef, useState } from 'react';

// Status hues, validated with the dataviz palette validator against the app's dark
// surface (#171a21): all four sit in the dark lightness band, clear the chroma floor
// and 3:1 contrast, and the worst adjacent CVD pair is ΔE 8.4 (protan).
// The ORDER matters — it is the stack order, bottom to top. Keeping offer (green) away
// from rejected (red) is what keeps the palette above the CVD floor, so if you reorder
// these, re-run scripts/validate_palette.js before shipping it.
export const STATUS_STYLE = [
  { key: 'rejected', label: 'Rejected', color: '#e66767' },
  { key: 'applied', label: 'Applied', color: '#3987e5' },
  { key: 'interview', label: 'Interview', color: '#c98500' },
  { key: 'offer', label: 'Offer', color: '#199e70' },
];

export const SERIES_BLUE = '#3987e5';
export const SURFACE = '#171a21';

export const statusColor = (key) => {
  const found = STATUS_STYLE.find((s) => s.key === key);
  return found ? found.color : SERIES_BLUE;
};

// Round an axis maximum up to a clean number so ticks read 0 / 5 / 10 rather than 0 / 3 / 7.
export function niceMax(value) {
  if (value <= 0) return 1;
  if (value <= 5) return value;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / (magnitude / 2)) * (magnitude / 2);
}

export function axisTicks(max, count = 4) {
  const step = max / count;
  return Array.from({ length: count + 1 }, (_, i) => Math.round(i * step));
}

// Dates are UTC calendar days, so label them in UTC to match what the table shows.
export function shortDate(iso) {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function longDate(iso) {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// SVG needs real pixel widths for text to stay the right size, so measure the container.
export function useElementWidth(fallback = 720) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0].contentRect.width;
      if (next > 0) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}
