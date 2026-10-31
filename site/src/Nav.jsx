const PAGES = [['home', 'Home'], ['leaderboard', 'Leaderboard'], ['evaluate', 'Evaluate']];

export function Nav({ synthetic, state, patch }) {
  return (
    <nav className="nav">
      <div className="band bar">
        <span className="mark">LLM Bootstrap</span>
        <div className="pages" role="tablist" aria-label="Pages">
          {PAGES.map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={state.page === key} onClick={() => patch({ page: key })}>{label}</button>
          ))}
        </div>
        {synthetic && <span className="pill" title="Every number on this page is made up">Synthetic data</span>}
      </div>
    </nav>
  );
}
