import { useEffect, useMemo, useState } from 'react';
import FileDrop from './FileDrop.jsx';
import { createApplication, updateApplication } from '../lib/api.js';

const EMPTY = {
  profileName: '',
  jobTitle: '',
  company: '',
  jobLink: '',
  jobDescription: '',
  status: 'applied',
  appliedAt: '',
  notes: '',
};

// Stored dates are UTC midnight, so read them back in UTC to get the same calendar day.
function toDateInput(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

// "Today" means today where the user is. Going through toISOString here would
// hand back tomorrow's date once it is past 8pm for anyone behind UTC.
function todayInput() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export default function ApplicationForm({ profiles, statuses, editing, onClose, onSaved }) {
  const [form, setForm] = useState(EMPTY);
  const [file, setFile] = useState(null);
  const [coverFile, setCoverFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isEdit = Boolean(editing);

  useEffect(() => {
    if (editing) {
      setForm({
        profileName: editing.profileName || '',
        jobTitle: editing.jobTitle || '',
        company: editing.company || '',
        jobLink: editing.jobLink || '',
        jobDescription: editing.jobDescription || '',
        status: editing.status || 'applied',
        appliedAt: toDateInput(editing.appliedAt),
        notes: editing.notes || '',
      });
    } else {
      setForm({ ...EMPTY, appliedAt: todayInput() });
    }
    setFile(null);
    setCoverFile(null);
    setError('');
  }, [editing]);

  const existingResume = useMemo(
    () => (editing && editing.resume ? editing.resume.originalName : ''),
    [editing],
  );

  const existingCover = useMemo(
    () => (editing && editing.coverLetter ? editing.coverLetter.originalName : ''),
    [editing],
  );

  function set(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');

    if (!form.profileName) return setError('Pick a profile name.');
    if (!form.jobTitle.trim()) return setError('Job title is required.');

    const data = new FormData();
    Object.entries(form).forEach(([key, value]) => data.append(key, value));
    if (file) data.append('resume', file);
    if (coverFile) data.append('coverLetter', coverFile);

    setSaving(true);
    try {
      const saved = isEdit
        ? await updateApplication(editing.id, data)
        : await createApplication(data);
      onSaved(saved, isEdit);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={isEdit ? 'Edit application' : 'New application'}>
        <header className="modal-head">
          <h2>{isEdit ? 'Edit application' : 'Add application'}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </header>

        <form className="form" onSubmit={handleSubmit}>
          <div className="grid-2">
            <label className="field">
              <span>
                Profile name <em>*</em>
              </span>
              <select
                value={form.profileName}
                onChange={(e) => set('profileName', e.target.value)}
                required
              >
                <option value="">Select a profile…</option>
                {profiles.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Status</span>
              <select value={form.status} onChange={(e) => set('status', e.target.value)}>
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>
                Job title <em>*</em>
              </span>
              <input
                value={form.jobTitle}
                onChange={(e) => set('jobTitle', e.target.value)}
                placeholder="Senior React Developer"
                required
              />
            </label>

            <label className="field">
              <span>Company</span>
              <input
                value={form.company}
                onChange={(e) => set('company', e.target.value)}
                placeholder="Acme Inc."
              />
            </label>
          </div>

          <label className="field">
            <span>Job link</span>
            <input
              type="url"
              value={form.jobLink}
              onChange={(e) => set('jobLink', e.target.value)}
              placeholder="https://boards.greenhouse.io/…"
            />
          </label>

          <label className="field">
            <span>Job description</span>
            <textarea
              rows={7}
              value={form.jobDescription}
              onChange={(e) => set('jobDescription', e.target.value)}
              placeholder="Paste the full posting here…"
            />
          </label>

          <div className="grid-2">
            <FileDrop
              label="Resume"
              file={file}
              existingName={existingResume}
              onPick={setFile}
              hint="Optional — the extension files this one itself."
            />

            <FileDrop
              label="Cover letter"
              file={coverFile}
              existingName={existingCover}
              onPick={setCoverFile}
              hint="Optional — the extension files this one itself."
            />
          </div>

          <label className="field half">
            <span>Applied on</span>
            <input
              type="date"
              value={form.appliedAt}
              onChange={(e) => set('appliedAt', e.target.value)}
            />
          </label>

          <label className="field">
            <span>Notes</span>
            <textarea
              rows={3}
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              placeholder="Recruiter name, referral, follow-up date…"
            />
          </label>

          {error && <p className="alert">{error}</p>}

          <footer className="modal-foot">
            <button type="button" className="btn ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={saving}>
              {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add application'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
