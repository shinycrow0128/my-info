import { config } from './config.js';

/**
 * appliedAt is a calendar day, not an instant. It is stored pinned to UTC
 * midnight so the date reads back the same for every client, but deciding which
 * day "now" is has to happen in a real timezone: past 8pm in New York UTC has
 * already rolled over, so a UTC-derived default would stamp tonight's bid with
 * tomorrow's date. APP_TIMEZONE is that timezone - Eastern unless it is set.
 */
const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: config.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The `YYYY-MM-DD` an instant falls on in the app's timezone. */
export function dayKeyOf(date = new Date()) {
  const found = {};
  for (const { type, value } of parts.formatToParts(date)) found[type] = value;
  return `${found.year}-${found.month}-${found.day}`;
}

/** A `YYYY-MM-DD` key as the UTC-midnight Date every appliedAt is stored as. */
export function utcMidnight(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/** Any instant flattened to the calendar day it fell on where the user is. */
export function toCalendarDay(date) {
  return utcMidnight(dayKeyOf(date));
}

/** Today's calendar day - the default appliedAt, and the analytics anchor. */
export function startOfToday() {
  return toCalendarDay(new Date());
}
