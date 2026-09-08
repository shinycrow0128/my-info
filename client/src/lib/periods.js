// The date-period filter behind the applications table, and the one formatter
// every screen prints an applied date with.
//
// appliedAt is a calendar day, not an instant: it is stored pinned to UTC
// midnight so the date reads back the same everywhere. Which day "now" falls on
// is a separate question, and UTC is the wrong place to ask it - past 8pm in New
// York UTC has already rolled over, so a UTC "today" would ask the API for
// tomorrow and hide the bid that was just filed. Every window below is anchored
// on the browser's own calendar day and then pinned to UTC, so the arithmetic
// and the keys stay in one frame.

export const PERIODS = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: 'month', label: 'This month' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom' },
];

// Landing on the table should answer "what did I send today?" without a click.
export const DEFAULT_PERIOD = 'today';

const MS_PER_DAY = 86400000;

/** A UTC-pinned Date as the `YYYY-MM-DD` key the API and <input type="date"> both speak. */
export function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

/** Today where the user is, pinned to UTC midnight. */
function startOfToday() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

export function todayKey() {
  return dayKey(startOfToday());
}

function shiftDays(date, amount) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + amount);
  return next;
}

/**
 * The `{ from, to }` day keys a period covers - both inclusive, both '' for all
 * time. `custom` passes the user's own two dates straight through, so a half
 * filled range (only a start, or only an end) is still a valid open-ended window.
 */
export function periodRange(period, custom = {}) {
  const today = startOfToday();
  switch (period) {
    case 'today':
      return { from: dayKey(today), to: dayKey(today) };
    case 'yesterday': {
      const key = dayKey(shiftDays(today, -1));
      return { from: key, to: key };
    }
    case '7':
    case '30':
      // Inclusive of today, so "7 days" is today plus the six before it.
      return { from: dayKey(shiftDays(today, -(Number(period) - 1))), to: dayKey(today) };
    case 'month':
      return {
        from: dayKey(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))),
        to: dayKey(today),
      };
    case 'custom':
      return { from: custom.from || '', to: custom.to || '' };
    default:
      return { from: '', to: '' };
  }
}

/**
 * How a stored appliedAt reads on screen. A value sitting exactly on UTC
 * midnight is a calendar day, so print it in UTC - reading it locally shows the
 * day before for anyone behind UTC. Anything else is a genuine instant (rows
 * filed through the API before the day was pinned), so print it where the
 * reader is rather than shifting it into UTC.
 */
export function formatDay(value, fallback = '—') {
  if (!value) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return fallback;
  const options = { year: 'numeric', month: 'short', day: 'numeric' };
  if (d.getTime() % MS_PER_DAY === 0) options.timeZone = 'UTC';
  return d.toLocaleDateString(undefined, options);
}

function prettyDay(key) {
  return new Date(`${key}T00:00:00.000Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Human wording for the window in play - shown under the page title. */
export function rangeLabel({ from, to }) {
  if (!from && !to) return 'all time';
  if (from && to) return from === to ? prettyDay(from) : `${prettyDay(from)} – ${prettyDay(to)}`;
  return from ? `since ${prettyDay(from)}` : `up to ${prettyDay(to)}`;
}
