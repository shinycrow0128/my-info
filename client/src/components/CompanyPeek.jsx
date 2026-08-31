import { useCallback, useEffect, useRef, useState } from 'react';
import { lookupCompany } from '../lib/api.js';

const PANEL_WIDTH = 360;
// The panel closes itself this long after the answer lands.
const AUTO_HIDE_MS = 5000;
const PANEL_MAX_HEIGHT = 340;
const GAP = 8;

// Reads the current selection plus the rectangle to anchor the panel to.
// window.getSelection() comes back empty for text selected inside an <input>
// or <textarea>, so those are read off the element itself.
function readSelection() {
  const el = document.activeElement;
  const isField = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  if (isField && typeof el.selectionStart === 'number' && el.selectionStart !== el.selectionEnd) {
    return {
      text: el.value.slice(el.selectionStart, el.selectionEnd),
      rect: el.getBoundingClientRect(),
    };
  }

  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString();
  if (!text.trim()) return null;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  return { text, rect };
}

// Anchor under the selection, flipping above it when the bottom of the window is close.
function place(rect) {
  const left = Math.min(
    Math.max(GAP, rect.left),
    Math.max(GAP, window.innerWidth - PANEL_WIDTH - GAP),
  );
  const spaceBelow = window.innerHeight - rect.bottom;
  if (spaceBelow < PANEL_MAX_HEIGHT && rect.top > spaceBelow) {
    return { left, bottom: window.innerHeight - rect.top + GAP };
  }
  return { left, top: rect.bottom + GAP };
}

function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function CompanyPeek() {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [pos, setPos] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const [hovering, setHovering] = useState(false);

  const panelRef = useRef(null);
  // Guards against a slow earlier lookup landing on top of a newer one.
  const requestId = useRef(0);

  const close = useCallback(() => {
    requestId.current += 1;
    setOpen(false);
    setData(null);
    setError('');
    setLoading(false);
    setHovering(false);
  }, []);

  const peek = useCallback(async (selection) => {
    const text = selection.text.trim().replace(/\s+/g, ' ');
    const id = ++requestId.current;

    setTerm(text);
    setPos(place(selection.rect));
    setData(null);
    setOpen(true);

    if (text.length < 2) {
      setError('Select at least 2 characters of a company name');
      return;
    }

    setError('');
    setLoading(true);
    try {
      const result = await lookupCompany(text, 20);
      if (id !== requestId.current) return;
      setData(result);
    } catch (err) {
      if (id !== requestId.current) return;
      setError(err.message);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        close();
        return;
      }
      if (!e.ctrlKey || !e.shiftKey || e.altKey) return;
      // e.code so the shortcut survives non-QWERTY layouts.
      if (e.code !== 'KeyX' && e.key.toLowerCase() !== 'x') return;

      const selection = readSelection();
      if (!selection) return;
      e.preventDefault();
      peek(selection);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close, peek]);

  // Close 5s after there is something to read. The countdown does not run while the
  // lookup is still in flight, and reading the list keeps it open.
  useEffect(() => {
    if (!open || loading || hovering) return undefined;
    const timer = setTimeout(close, AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [open, loading, hovering, data, error, close]);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) close();
    }
    window.addEventListener('mousedown', onPointerDown);
    // The panel is pinned to where the selection was, so a page scroll orphans it.
    window.addEventListener('scroll', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('scroll', close);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  if (!open || !pos) return null;

  const items = data ? data.items : [];
  const statusEntries = data ? Object.entries(data.byStatus) : [];
  // Name the companies behind the hits when they are not just the selected text itself.
  const names = data ? data.companies : [];
  const spread =
    names.length > 1
      ? `across ${names.length} companies`
      : names.length === 1 && names[0].toLowerCase() !== term.toLowerCase()
        ? names[0]
        : '';

  return (
    <div
      className="peek"
      role="dialog"
      aria-label="Company lookup"
      ref={panelRef}
      style={pos}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <div className="peek-head">
        <div className="peek-title">
          <span className="peek-term" title={term}>
            {term}
          </span>
          {data ? (
            <span className="peek-count">
              {data.total} {data.total === 1 ? 'application' : 'applications'}
            </span>
          ) : null}
        </div>
        <button type="button" className="peek-close" onClick={close} aria-label="Close">
          &times;
        </button>
      </div>

      {statusEntries.length > 0 ? (
        <div className="peek-statuses">
          {statusEntries.map(([status, count]) => (
            <span key={status} className={`status status-${status}`}>
              {status} {count}
            </span>
          ))}
        </div>
      ) : null}

      <div className="peek-body">
        {loading ? <p className="peek-note">Looking up…</p> : null}
        {error ? <p className="peek-note peek-error">{error}</p> : null}
        {!loading && !error && items.length === 0 ? (
          <p className="peek-note">No applications filed under a company matching this.</p>
        ) : null}

        {items.map((item) => (
          <div className="peek-row" key={item.id}>
            <div className="peek-row-main">
              <span className="profile-chip">{item.profileName}</span>
              <span className={`status status-${item.status}`}>{item.status}</span>
            </div>
            <div className="peek-job">{item.jobTitle}</div>
            <div className="peek-meta">
              <span className={item.exact ? 'peek-company exact' : 'peek-company'}>
                {item.company || 'No company'}
              </span>
              {formatDate(item.appliedAt) ? <span>· {formatDate(item.appliedAt)}</span> : null}
            </div>
          </div>
        ))}
      </div>

      <div className="peek-foot">
        {data && data.total > data.shown ? (
          <span>
            showing {data.shown} of {data.total}
          </span>
        ) : (
          <span>Ctrl+Shift+X on a selection</span>
        )}
        {spread ? (
          <span className="peek-also" title={names.join(', ')}>
            {spread}
          </span>
        ) : null}
      </div>
    </div>
  );
}
