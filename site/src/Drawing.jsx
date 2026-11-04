import { useEffect, useRef } from 'react';

// Where the site build puts the drawing of an entry (tools/leaderboard/build-index.mjs --drawings).
export const drawingUrl = run => `/data/drawings/${run.entry_id}.svg`;

const fmt = value => (value == null ? '—' : Number(value).toLocaleString('en'));

// The label shown with a row: a link when the drawing is published, a plain note when the report has none. Null when no pelican test ran.
export function DrawingLink({ run, onOpen }) {
  if (!run.drawing) return null;
  return run.drawing.available
    ? <button type="button" className="text drawing-link" onClick={() => onOpen(run)}>Pelican drawing</button>
    : <small className="drawing-link" title="The report records the drawing's size and hash, but its SVG was not submitted.">drawing unavailable</small>;
}

// Drawn through <img>, which never runs script or loads anything the file points to, and offered as a download rather than opened as a page.
export function DrawingDialog({ run, onClose }) {
  const dialog = useRef(null);
  useEffect(() => {
    const element = dialog.current;
    if (run && element && !element.open) element.showModal();
    if (!run && element?.open) element.close();
  }, [run]);
  const drawing = run?.drawing;
  const stamp = run?.entry_id.split('/').at(-1);
  return (
    <dialog ref={dialog} className="drawing-dialog" onClose={onClose} onClick={event => { if (event.target === dialog.current) onClose(); }}>
      {run && (
        <>
          <header>
            <strong>{run.experiment_id}</strong>
            <small>report {stamp} · {run.engine.name}</small>
          </header>
          <img src={drawingUrl(run)} alt={`The pelican riding a bicycle drawn in report ${stamp}`} />
          <p className="muted">An unscored picture to look at: it is not ranked and says nothing about quality by itself.</p>
          <dl className="facts">
            <div><dt>Size</dt><dd>{fmt(drawing.bytes)} bytes</dd></div>
            <div><dt>Elements</dt><dd>{fmt(drawing.elements)}</dd></div>
            <div><dt>SHA-256</dt><dd title={drawing.sha256}>{drawing.sha256?.slice(0, 16)}…</dd></div>
          </dl>
          <div className="actions">
            <a className="ghost" href={drawingUrl(run)} download={`${stamp}.pelican.svg`}>Download SVG</a>
            <button type="button" className="primary" onClick={onClose}>Close</button>
          </div>
        </>
      )}
    </dialog>
  );
}
