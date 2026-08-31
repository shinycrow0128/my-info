import { Fragment, useState } from 'react';
import { resumeUrl } from '../lib/api.js';

const COLUMNS = [
  { key: 'profileName', label: 'Profile', sortable: true },
  { key: 'jobTitle', label: 'Job title', sortable: true },
  { key: 'company', label: 'Company', sortable: true },
  { key: 'jobLink', label: 'Job link', sortable: false },
  { key: 'jobDescription', label: 'Description', sortable: false },
  { key: 'resume', label: 'Resume', sortable: false },
  { key: 'status', label: 'Status', sortable: true },
  { key: 'appliedAt', label: 'Applied', sortable: true },
  { key: 'actions', label: '', sortable: false },
];

// appliedAt is a calendar date stored as UTC midnight, so it has to be rendered in UTC.
// Formatting it in local time shows the previous day for anyone behind UTC.
function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      });
}

function formatSize(bytes) {
  if (!bytes) return '';
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

function hostOf(link) {
  try {
    return new URL(link).hostname.replace(/^www\./, '');
  } catch {
    return 'link';
  }
}

export default function ApplicationTable({ items, loading, sortBy, sortDir, onSort, onEdit, onDelete }) {
  const [expanded, setExpanded] = useState(null);

  function toggle(id) {
    setExpanded((current) => (current === id ? null : id));
  }

  if (!loading && items.length === 0) {
    return (
      <div className="empty">
        <p>No applications yet.</p>
        <p className="muted">Add one with the button above and it will show up in this table.</p>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {COLUMNS.map((col) => (
              <th
                key={col.key}
                className={col.sortable ? 'sortable' : undefined}
                onClick={col.sortable ? () => onSort(col.key) : undefined}
                aria-sort={
                  sortBy === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'
                }
              >
                {col.label}
                {col.sortable && sortBy === col.key && (
                  <span className="arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={loading ? 'is-loading' : undefined}>
          {items.map((row) => {
            const isOpen = expanded === row.id;
            return (
              <Fragment key={row.id}>
                <tr>
                  <td>
                    <span className="profile-chip">{row.profileName}</span>
                  </td>
                  <td className="strong">{row.jobTitle}</td>
                  <td>{row.company || '—'}</td>
                  <td>
                    {row.jobLink ? (
                      <a href={row.jobLink} target="_blank" rel="noreferrer noopener">
                        {hostOf(row.jobLink)} ↗
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    {row.jobDescription ? (
                      <button type="button" className="link-btn" onClick={() => toggle(row.id)}>
                        {isOpen ? 'Hide' : 'View'}
                      </button>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    {row.resume ? (
                      <a
                        className="file-link"
                        href={resumeUrl(row.id)}
                        title={`${row.resume.originalName} (${formatSize(row.resume.size)})`}
                      >
                        {row.resume.originalName}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    <span className={`status status-${row.status}`}>{row.status}</span>
                  </td>
                  <td className="nowrap">{formatDate(row.appliedAt)}</td>
                  <td className="nowrap actions">
                    <button type="button" className="link-btn" onClick={() => onEdit(row)}>
                      Edit
                    </button>
                    <button type="button" className="link-btn danger" onClick={() => onDelete(row)}>
                      Delete
                    </button>
                  </td>
                </tr>
                {isOpen && (
                  <tr className="detail-row">
                    <td colSpan={COLUMNS.length}>
                      <div className="detail">
                        <h4>Job description</h4>
                        <pre>{row.jobDescription}</pre>
                        {row.notes && (
                          <>
                            <h4>Notes</h4>
                            <pre>{row.notes}</pre>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
