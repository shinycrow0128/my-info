import express from 'express';
import { Application } from '../models/Application.js';
import { PROFILES, STATUSES } from '../config.js';

export const router = express.Router();

const RANGES = new Set(['7', '30', '90', '365', 'all']);

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// appliedAt is stored as UTC midnight, so every bucket boundary is computed in UTC too.
function utcDayKey(date) {
  return date.toISOString().slice(0, 10);
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function emptyCounts() {
  return Object.fromEntries(STATUSES.map((s) => [s, 0]));
}

function rate(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

// GET /api/analytics?days=30 - everything the analytics page needs in one round trip.
router.get(
  '/',
  wrap(async (req, res) => {
    const days = RANGES.has(String(req.query.days)) ? String(req.query.days) : '30';
    const today = startOfUtcDay(new Date());

    let from = null;
    if (days !== 'all') {
      from = new Date(today);
      from.setUTCDate(from.getUTCDate() - (Number(days) - 1));
    }

    const match = from ? { appliedAt: { $gte: from } } : {};

    const [facets] = await Application.aggregate([
      { $match: match },
      {
        $facet: {
          byDay: [
            {
              $group: {
                _id: {
                  date: {
                    $dateToString: { format: '%Y-%m-%d', date: '$appliedAt', timezone: 'UTC' },
                  },
                  status: '$status',
                },
                count: { $sum: 1 },
              },
            },
          ],
          byProfile: [
            {
              $group: {
                _id: { profile: '$profileName', status: '$status' },
                count: { $sum: 1 },
              },
            },
          ],
          byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
          total: [{ $count: 'n' }],
        },
      },
    ]);

    const total = facets.total.length ? facets.total[0].n : 0;

    // ---- totals by status ----
    const totals = emptyCounts();
    facets.byStatus.forEach((row) => {
      if (row._id in totals) totals[row._id] = row.count;
    });

    // ---- daily series, with empty days filled in so the chart has no gaps ----
    const dayMap = new Map();
    facets.byDay.forEach((row) => {
      const key = row._id.date;
      if (!dayMap.has(key)) dayMap.set(key, emptyCounts());
      const bucket = dayMap.get(key);
      if (row._id.status in bucket) bucket[row._id.status] = row.count;
    });

    let firstDay = from;
    if (!firstDay) {
      // "All time" starts at the earliest record, capped so the chart stays readable.
      const keys = [...dayMap.keys()].sort();
      firstDay = keys.length ? new Date(`${keys[0]}T00:00:00.000Z`) : today;
      const maxSpan = new Date(today);
      maxSpan.setUTCDate(maxSpan.getUTCDate() - 364);
      if (firstDay < maxSpan) firstDay = maxSpan;
    }

    const perDay = [];
    for (let d = new Date(firstDay); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = utcDayKey(d);
      const counts = dayMap.get(key) || emptyCounts();
      const dayTotal = STATUSES.reduce((sum, s) => sum + counts[s], 0);
      perDay.push({ date: key, total: dayTotal, ...counts });
    }

    // Past a few months there are more days than the chart has pixels, so roll them up
    // into weeks. Below that the daily detail is what makes the chart worth reading.
    const granularity = perDay.length > 120 ? 'week' : 'day';
    const daily =
      granularity === 'day'
        ? perDay
        : perDay.reduce((weeks, day, i) => {
            if (i % 7 === 0) weeks.push({ date: day.date, total: 0, ...emptyCounts() });
            const week = weeks[weeks.length - 1];
            week.total += day.total;
            STATUSES.forEach((s) => {
              week[s] += day[s];
            });
            return weeks;
          }, []);

    // ---- per profile, ranked by interviews ----
    const profileMap = new Map(PROFILES.map((name) => [name, emptyCounts()]));
    facets.byProfile.forEach((row) => {
      if (!profileMap.has(row._id.profile)) profileMap.set(row._id.profile, emptyCounts());
      const bucket = profileMap.get(row._id.profile);
      if (row._id.status in bucket) bucket[row._id.status] = row.count;
    });

    const byProfile = [...profileMap.entries()]
      .map(([profileName, counts]) => {
        const profileTotal = STATUSES.reduce((sum, s) => sum + counts[s], 0);
        return {
          profileName,
          total: profileTotal,
          ...counts,
          // Interviews and offers both count as "got a reply worth having".
          interviewRate: rate(counts.interview + counts.offer, profileTotal),
        };
      })
      .sort((a, b) => b.interview - a.interview || b.total - a.total);

    const contenders = byProfile.filter((p) => p.interview > 0);
    const topInterviewProfile = contenders.length ? contenders[0] : null;
    // A tie means there is no single leader to crown.
    const topIsTied =
      contenders.length > 1 && contenders[0].interview === contenders[1].interview;

    const activeDays = perDay.filter((d) => d.total > 0).length;
    const busiest = perDay.reduce(
      (best, d) => (best === null || d.total > best.total ? d : best),
      null,
    );

    res.json({
      range: { days, from: firstDay ? utcDayKey(firstDay) : null, to: utcDayKey(today), granularity },
      total,
      totals,
      rates: {
        interview: rate(totals.interview + totals.offer, total),
        offer: rate(totals.offer, total),
        rejected: rate(totals.rejected, total),
      },
      daily,
      byProfile,
      topInterviewProfile,
      topIsTied,
      pace: {
        activeDays,
        perActiveDay: activeDays > 0 ? Math.round((total / activeDays) * 10) / 10 : 0,
        busiestDay: busiest && busiest.total > 0 ? busiest : null,
      },
    });
  }),
);
