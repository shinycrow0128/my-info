import { useCallback, useEffect, useState } from 'react';
import ApplicationForm from '../components/ApplicationForm.jsx';
import ApplicationTable from '../components/ApplicationTable.jsx';
import { deleteApplication, getMeta, getStats, listApplications } from '../lib/api.js';

const PAGE_SIZE = 25;

export default function ApplicationsPage() {
  const [profiles, setProfiles] = useState([]);
  const [statuses, setStatuses] = useState([]);

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [stats, setStats] = useState(null);

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [profileFilter, setProfileFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sortBy, setSortBy] = useState('createdAt');
  const [sortDir, setSortDir] = useState('desc');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);

  useEffect(() => {
    getMeta()
      .then((meta) => {
        setProfiles(meta.profiles);
        setStatuses(meta.statuses);
      })
      .catch((err) => setError(err.message));
  }, []);

  // Debounce the search box so typing does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [data, nextStats] = await Promise.all([
        listApplications({
          page,
          limit: PAGE_SIZE,
          q: query,
          profileName: profileFilter,
          status: statusFilter,
          sortBy,
          sortDir,
        }),
        getStats(),
      ]);
      setItems(data.items);
      setTotal(data.total);
      setPages(data.pages);
      setStats(nextStats);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [page, query, profileFilter, statusFilter, sortBy, sortDir]);

  useEffect(() => {
    load();
  }, [load]);

  function handleSort(key) {
    if (sortBy === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(key);
      setSortDir('asc');
    }
    setPage(1);
  }

  async function handleDelete(row) {
    const label = `${row.jobTitle}${row.company ? ` at ${row.company}` : ''}`;
    if (!window.confirm(`Delete "${label}"? The stored resume file is removed too.`)) return;
    try {
      await deleteApplication(row.id);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  function handleSaved() {
    setFormOpen(false);
    setEditing(null);
    load();
  }

  function openNew() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(row) {
    setEditing(row);
    setFormOpen(true);
  }

  const filtersActive = Boolean(query || profileFilter || statusFilter);

  return (
    <>
      <header className="page-head">
        <div>
          <h2 className="page-title">Applications</h2>
          <p className="muted">Every resume you sent, the job it went to, and where it stands.</p>
        </div>
        <button type="button" className="btn primary" onClick={openNew}>
          + Add application
        </button>
      </header>

      {stats && (
        <section className="stats">
          <div className="stat">
            <span className="stat-value">{stats.total}</span>
            <span className="stat-label">Total</span>
          </div>
          {profiles.map((name) => (
            <button
              key={name}
              type="button"
              className={`stat clickable${profileFilter === name ? ' active' : ''}`}
              onClick={() => {
                setProfileFilter((current) => (current === name ? '' : name));
                setPage(1);
              }}
            >
              <span className="stat-value">{stats.byProfile[name] || 0}</span>
              <span className="stat-label">{name}</span>
            </button>
          ))}
        </section>
      )}

      <section className="toolbar">
        <input
          className="search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search job title, company, description or resume text…"
        />
        <select
          value={profileFilter}
          onChange={(e) => {
            setProfileFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All profiles</option>
          {profiles.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {filtersActive && (
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              setSearch('');
              setProfileFilter('');
              setStatusFilter('');
              setPage(1);
            }}
          >
            Clear
          </button>
        )}
      </section>

      {error && <p className="alert">{error}</p>}

      <ApplicationTable
        items={items}
        loading={loading}
        sortBy={sortBy}
        sortDir={sortDir}
        onSort={handleSort}
        onEdit={openEdit}
        onDelete={handleDelete}
      />

      <footer className="pager">
        <span className="muted">
          {loading ? 'Loading…' : `${total} application${total === 1 ? '' : 's'}`}
        </span>
        <div className="pager-controls">
          <button
            type="button"
            className="btn ghost"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </button>
          <span className="muted">
            Page {page} of {pages}
          </span>
          <button
            type="button"
            className="btn ghost"
            disabled={page >= pages || loading}
            onClick={() => setPage((p) => Math.min(pages, p + 1))}
          >
            Next
          </button>
        </div>
      </footer>

      {formOpen && (
        <ApplicationForm
          profiles={profiles}
          statuses={statuses}
          editing={editing}
          onClose={() => {
            setFormOpen(false);
            setEditing(null);
          }}
          onSaved={handleSaved}
        />
      )}
    </>
  );
}
