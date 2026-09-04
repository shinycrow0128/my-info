import { useId, useRef, useState } from 'react';

/**
 * One document, picked either way round: drop it on the box, or click to
 * browse. The box always says what it is holding - the file you just chose,
 * or the one already on the record - so nothing has to be guessed from an
 * empty native input.
 */

const ACCEPT = '.docx,.doc,.pdf';

function formatSize(bytes) {
  if (!bytes) return '';
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

export default function FileDrop({ label, required, file, existingName, onPick, hint }) {
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);
  const id = useId();

  function pickFrom(list) {
    const picked = list && list[0];
    if (picked) onPick(picked);
  }

  function handleDrop(event) {
    event.preventDefault();
    setOver(false);
    pickFrom(event.dataTransfer.files);
  }

  function clear(event) {
    // The box itself opens the picker; clearing must not reopen it.
    event.stopPropagation();
    onPick(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  const state = file ? 'picked' : existingName ? 'stored' : 'empty';

  return (
    <div className="field">
      <span id={id}>
        {label} {required && <em>*</em>}
      </span>

      <div
        className={`filedrop${over ? ' is-over' : ''}`}
        data-state={state}
        role="button"
        tabIndex={0}
        aria-labelledby={id}
        onClick={() => inputRef.current.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={handleDrop}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="filedrop-input"
          tabIndex={-1}
          onChange={(e) => pickFrom(e.target.files)}
        />

        {file ? (
          <>
            <span className="filedrop-name" title={file.name}>
              {file.name}
            </span>
            <span className="filedrop-note">{formatSize(file.size)} — ready to upload</span>
            <button type="button" className="link-btn danger filedrop-clear" onClick={clear}>
              Remove
            </button>
          </>
        ) : existingName ? (
          <>
            <span className="filedrop-name" title={existingName}>
              {existingName}
            </span>
            <span className="filedrop-note">On file — drop a file here to replace it</span>
          </>
        ) : (
          <>
            <span className="filedrop-name">Drop a file here, or click to browse</span>
            <span className="filedrop-note">{hint || '.docx, .doc or .pdf'}</span>
          </>
        )}
      </div>
    </div>
  );
}
