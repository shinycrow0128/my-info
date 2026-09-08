import { Fragment, useRef, useState } from 'react';
import { coverLetterUrl, resumeUrl, updateApplication } from '../lib/api.js';
import { formatDay } from '../lib/periods.js';

const COLUMNS = [
  { key: 'profileName', label: 'Profile', sortable: true },
  { key: 'jobTitle', label: 'Job title', sortable: true },
  { key: 'company', label: 'Company', sortable: true },
  { key: 'jobLink', label: 'Link', sortable: false, className: 'col-link' },
  { key: 'jobDescription', label: 'Description', sortable: false },
  { key: 'resume', label: 'Resume', sortable: false },
  { key: 'coverLetter', label: 'Cover letter', sortable: false },
  { key: 'status', label: 'Status', sortable: true },
  { key: 'appliedAt', label: 'Applied', sortable: true },
  { key: 'actions', label: '', sortable: false },
];

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

/**
 * One document on one row: the file if it is there, and either way a picker
 * that uploads straight into the record. Most rows are filed by the extension
 * before ChatGPT has written anything, so this is the short way to put a
 * missing resume or cover letter on one - no edit dialog in between.
 */
function DocumentCell({ row, field, href, label, onChanged }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const stored = row[field];

  async function upload(file) {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const data = new FormData();
      data.append(field, file);
      await updateApplication(row.id, data);
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      // Cleared so picking the same file again still fires a change.
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div className="doc-cell">
      <input
        ref={inputRef}
        type="file"
        accept=".docx,.doc,.pdf"
        className="filedrop-input"
        onChange={(e) => upload(e.target.files[0])}
      />
      {stored ? (
        <a className="file-link" href={href} title={`${stored.originalName} (${formatSize(stored.size)})`}>
          {stored.originalName}
        </a>
      ) : (
        <span className="muted-inline">—</span>
      )}
      <button
        type="button"
        className="link-btn doc-upload"
        disabled={busy}
        onClick={() => inputRef.current.click()}
        title={`Upload a ${label} for this application`}
      >
        {busy ? 'Uploading…' : stored ? 'Replace' : 'Upload'}
      </button>
      {error && <span className="doc-error">{error}</span>}
    </div>
  );
}

export default function ApplicationTable({
  items,
  loading,
  sortBy,
  sortDir,
  onSort,
  onEdit,
  onDelete,
  onChanged,
  // An empty table usually means the active period holds nothing, not that the
  // tracker is empty - the page passes wording that says which.
  emptyTitle = 'No applications yet.',
  emptyHint = 'Add one with the button above and it will show up in this table.',
}) {
  const [expanded, setExpanded] = useState(null);

  function toggle(id) {
    setExpanded((current) => (current === id ? null : id));
  }

  if (!loading && items.length === 0) {
    return (
      <div className="empty">
        <p>{emptyTitle}</p>
        <p className="muted">{emptyHint}</p>
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
                className={[col.sortable ? 'sortable' : '', col.className || ''].join(' ').trim() || undefined}
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
                  {/* 50px lane: only the arrow fits, so the host lives in the tooltip. */}
                  <td className="col-link">
                    {row.jobLink ? (
                      <a
                        href={row.jobLink}
                        target="_blank"
                        rel="noreferrer noopener"
                        title={hostOf(row.jobLink)}
                      >
                        ↗
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
                    <DocumentCell
                      row={row}
                      field="resume"
                      href={resumeUrl(row.id)}
                      label="resume"
                      onChanged={onChanged}
                    />
                  </td>
                  <td>
                    <DocumentCell
                      row={row}
                      field="coverLetter"
                      href={coverLetterUrl(row.id)}
                      label="cover letter"
                      onChanged={onChanged}
                    />
                  </td>
                  <td>
                    <span className={`status status-${row.status}`}>{row.status}</span>
                  </td>
                  <td className="nowrap">{formatDay(row.appliedAt)}</td>
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
