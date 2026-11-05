import { useState } from 'react';
import { DrawingDialog, drawingUrl } from './Drawing.jsx';
import { galleryRuns } from './lib/model.js';

function Thumb({ run }) {
  const [failed, setFailed] = useState(false);
  return failed
    ? <span className="thumb missing">Drawing could not be loaded</span>
    : <img className="thumb" src={drawingUrl(run)} alt={`Pelican drawing from ${run.experiment_id}, report ${run.entry_id.split('/').at(-1)}`} loading="lazy" onError={() => setFailed(true)} />;
}

// Published pelican drawings side by side. Nothing here is ranked or scored; a drawing is a picture to look at.
export function Gallery({ runs }) {
  const [open, setOpen] = useState(null);
  const items = galleryRuns(runs);
  if (!items.length) return <p className="empty">No published pelican drawings match.</p>;
  return (
    <>
      <ul className="gallery" aria-label="Pelican drawings">
        {items.map(run => (
          <li key={run.entry_id}>
            <button type="button" onClick={() => setOpen(run)} aria-label={`Open the pelican drawing of ${run.experiment_id}, ${run.date}`}>
              <Thumb run={run} />
              <span className="caption">
                <strong>{run.experiment_id}</strong>
                <small>{run.engine.name}{run.engine.revision ? ` · ${run.engine.revision.slice(0, 7)}` : ''}</small>
                <small>{run.hardware} · {run.target_model}</small>
                <small>{run.date}</small>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <DrawingDialog run={open} onClose={() => setOpen(null)} />
    </>
  );
}
