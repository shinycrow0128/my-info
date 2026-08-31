import { useEffect, useState } from 'react';
import DailyChart from '../components/DailyChart.jsx';
import ProfileChart from '../components/ProfileChart.jsx';
import { getAnalytics } from '../lib/api.js';
import { STATUS_STYLE, longDate, shortDate } from '../lib/viz.js';

const RANGES = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'all', label: 'All time' },
];

export default function AnalyticsPage() {
  const [days, setDays] = useState('30');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    getAnalytics(days)
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  if (error) return <p className="alert">{error}</p>;
  if (!data) return <p className="muted">Loading analytics…</p>;

  const { totals, rates, pace, byProfile, topInterviewProfile, topIsTied } = data;
  const rangeLabel = RANGES.find((r) => r.value === days).label.toLowerCase();

  return (
    <>
      <header className="page-head">
        <div>
          <h2 className="page-title">Analytics</h2>
          <p className="muted">
            {data.total} bid{data.total === 1 ? '' : 's'}
            {data.range.from ? ` from ${shortDate(data.range.from)} to ${shortDate(data.range.to)}` : ''}
          </p>
        </div>
        {/* Filters sit in one row above the charts. */}
        <div className="range-picker" role="group" aria-label="Date range">
          {RANGES.map((r) => (
            <button
              key={r.value}
              type="button"
              className={`range-btn${days === r.value ? ' active' : ''}`}
              onClick={() => setDays(r.value)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </header>

      <section className={`tiles${loading ? ' is-loading' : ''}`}>
        <div className="tile hero-tile">
          <span className="tile-label">Total bids</span>
          <span className="hero-value">{data.total}</span>
          <span className="tile-foot">
            {pace.activeDays} active day{pace.activeDays === 1 ? '' : 's'} · {pace.perActiveDay} per
            active day
          </span>
        </div>
        <Tile label="Interviews" value={totals.interview} foot={`${rates.interview}% reply rate`} />
        <Tile label="Offers" value={totals.offer} foot={`${rates.offer}% of bids`} />
        <Tile label="Rejected" value={totals.rejected} foot={`${rates.rejected}% of bids`} />
        <Tile label="Awaiting reply" value={totals.applied} foot="still open" />
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h3>Bids per {data.range.granularity}</h3>
            <p className="muted">
              Column height is that {data.range.granularity}&apos;s bid count, split by where each one
              stands now.
            </p>
          </div>
          <button type="button" className="btn ghost small" onClick={() => setShowTable((v) => !v)}>
            {showTable ? 'Show chart' : 'Show table'}
          </button>
        </div>

        {/* Legend is always present for 2+ series, so identity is never colour-alone. */}
        <div className="legend">
          {STATUS_STYLE.map((s) => (
            <span key={s.key} className="legend-item">
              <i className="swatch" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>

        {showTable ? <DailyTable daily={data.daily} granularity={data.range.granularity} /> : <DailyChart daily={data.daily} granularity={data.range.granularity} />}
      </section>

      <div className="card-grid">
        <section className="card">
          <div className="card-head">
            <div>
              <h3>Interviews by profile</h3>
              <p className="muted">
                {topInterviewProfile
                  ? topIsTied
                    ? `${topInterviewProfile.interview} interviews — tied at the top.`
                    : `${topInterviewProfile.profileName} leads with ${topInterviewProfile.interview}.`
                  : 'No interviews in this range yet.'}
              </p>
            </div>
          </div>
          <ProfileChart profiles={byProfile} metric="interview" />
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h3>Profile breakdown</h3>
              <p className="muted">Reply rate counts interviews and offers together.</p>
            </div>
          </div>
          <div className="table-wrap flush">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Profile</th>
                  <th className="num">Bids</th>
                  <th className="num">Interview</th>
                  <th className="num">Offer</th>
                  <th className="num">Rejected</th>
                  <th className="num">Reply rate</th>
                </tr>
              </thead>
              <tbody>
                {byProfile.map((p) => (
                  <tr key={p.profileName}>
                    <td className="strong">
                      {p.profileName}
                      {topInterviewProfile &&
                        !topIsTied &&
                        p.profileName === topInterviewProfile.profileName && (
                          <span className="crown" title="Most interviews">
                            top
                          </span>
                        )}
                    </td>
                    <td className="num">{p.total}</td>
                    <td className="num">{p.interview}</td>
                    <td className="num">{p.offer}</td>
                    <td className="num">{p.rejected}</td>
                    <td className="num">{p.interviewRate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {pace.busiestDay && (
        <p className="muted footnote">
          Busiest day in the last {rangeLabel}: {longDate(pace.busiestDay.date)} with{' '}
          {pace.busiestDay.total} bid{pace.busiestDay.total === 1 ? '' : 's'}. Status counts reflect
          where each application stands today, not the day its status changed.
        </p>
      )}
    </>
  );
}

function Tile({ label, value, foot }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      <span className="tile-foot">{foot}</span>
    </div>
  );
}

// The table view the chart's numbers are always available in.
function DailyTable({ daily, granularity }) {
  const rows = daily.filter((d) => d.total > 0).reverse();
  if (rows.length === 0) return <p className="chart-empty">No applications in this range.</p>;
  return (
    <div className="table-wrap flush">
      <table className="table compact">
        <thead>
          <tr>
            <th>{granularity === 'week' ? 'Week of' : 'Date'}</th>
            <th className="num">Bids</th>
            {STATUS_STYLE.map((s) => (
              <th key={s.key} className="num">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.date}>
              <td className="nowrap">{longDate(d.date)}</td>
              <td className="num strong">{d.total}</td>
              {STATUS_STYLE.map((s) => (
                <td key={s.key} className="num">
                  {d[s.key] || '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
