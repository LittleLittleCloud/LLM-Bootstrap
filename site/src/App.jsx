import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Board } from './Board.jsx';
import { Footer } from './Footer.jsx';
import { Home } from './Home.jsx';
import { Nav } from './Nav.jsx';
import { hashToState, stateToHash } from './lib/model.js';
import { useIndex } from './useIndex.js';

const Evaluate = lazy(() => import('./Evaluate.jsx'));

export default function App() {
  const index = useIndex();
  const [state, setState] = useState(() => hashToState(location.hash));
  const [evaluateSeen, setEvaluateSeen] = useState(false);
  const patch = useMemo(() => changes => setState(current => ({ ...current, ...changes })), []);

  useEffect(() => { if (state.page === 'evaluate') setEvaluateSeen(true); }, [state.page]);

  useEffect(() => {
    const hash = stateToHash(state);
    history.replaceState(null, '', hash ? `#${hash}` : `${location.pathname}${location.search}`);
  }, [state]);

  if (index.status !== 'ready') {
    return <p className="status">{index.status === 'loading' ? 'Loading' : `Could not load the run data: ${index.message}`}</p>;
  }
  const props = { runs: index.runs, synthetic: index.synthetic, state, patch, setState };
  return (
    <>
      <Nav {...props} />
      {state.page === 'home' && <Home {...props} />}
      {state.page === 'leaderboard' && <><Board {...props} /><Footer /></>}
      {evaluateSeen && (
        <div hidden={state.page !== 'evaluate'}>
          <Suspense fallback={<p className="status">Loading</p>}><Evaluate /></Suspense>
        </div>
      )}
    </>
  );
}
