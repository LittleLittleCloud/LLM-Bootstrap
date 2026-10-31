import { summarize } from './lib/model.js';

const REPO = 'https://github.com/LittleLittleCloud/LLM-Bootstrap';

const TIMELINE = [
  ['Now', 'Assist', 'Closed-source LLMs or humans build an open model\u2019s inference engine and hill-climb it.'],
  ['Next', 'Learn', 'The next open models learn the necessary techniques from this repository.'],
  ['Goal', 'Self-host', 'An LLM completes its own inference engine.'],
];

const STEPS = [
  ['Install', 'Add the plugin to your agent.', [
    ['Claude Code', null, '/plugin marketplace add LittleLittleCloud/LLM-Bootstrap'],
    ['Codex', null, 'codex plugin marketplace add LittleLittleCloud/LLM-Bootstrap'],
  ]],
  ['Choose', 'Start in your own project workspace.', [
    ['New engine', 'A new hardware, target model, or goal.', 'Use bootstrap-experiment-sop to start a new experiment'],
    ['Improve an engine', 'Same target model, something else changes.', 'Use bootstrap-experiment-sop to derive an experiment from <experiment-id>'],
    ['Evaluate an engine', 'Measure an existing engine in your browser and export the report.', 'page:evaluate'],
  ]],
  ['Submit', 'Every run goes in, failures included.', [
    ['Pull request', null, 'Use bootstrap-submit-results to submit my results'],
  ]],
];

const FAQ = [
  ['What is LLM inference bootstrapping?', 'In a local environment, an LLM writes, validates, and optimizes the inference engine that runs its own inference on that machine, then keeps developing on it.'],
  ['Why bootstrap inference?', 'An engine built for one local environment and one model can outperform a general-purpose engine, because it is free to specialize for that hardware and that model.'],
  ['Why three steps?', 'Open models are not yet strong enough to build the engine they need. Closed-source LLMs or humans assist first, the next open models learn the techniques from this repository, and only then can an LLM self-host.'],
  ['How do I participate?', 'Install the plugin, start a new engine, improve one, or evaluate one, then submit every run as a pull request. The steps are above.'],
];

export function Home({ runs, patch }) {
  const all = summarize(runs, 'decode_tok_s');
  const kpis = [
    ['Experiments', all.experiments],
    ['Runs', all.runs],
    ['Passed gate', all.passRate == null ? '—' : `${Math.round(all.passRate * 100)}%`],
  ];
  return (
    <>
      <header className="band intro">
        <h1>Can an LLM build its own inference engine?</h1>
        <p>Experiments on one fixed platform each: hardware, target model, harness, and workload.</p>
        <div className="actions">
          <button type="button" className="primary" onClick={() => patch({ page: 'leaderboard' })}>Leaderboard</button>
          <a href={REPO} target="_blank" rel="noopener noreferrer">GitHub</a>
        </div>
        <dl className="stats">
          {kpis.map(([key, value]) => <div key={key}><dd>{value}</dd><dt>{key}</dt></div>)}
        </dl>
      </header>

      <section className="band section">
        <h2>Motivation</h2>
        <p className="why">Open models still trail closed ones. None is strong enough yet to build the engine it needs, so it needs assistance first.</p>
        <ol className="timeline">
          {TIMELINE.map(([when, title, text]) => <li key={title}><time>{when}</time><h3>{title}</h3><p>{text}</p></li>)}
        </ol>
      </section>

      <section className="band section">
        <h2>Participate</h2>
        <ol className="steps">
          {STEPS.map(([title, text, items], index) => (
            <li key={title}>
              <div className="step"><span>{index + 1}</span><h3>{title}</h3><p>{text}</p></div>
              <ul className="items">
                {items.map(([label, note, command]) => (
                  <li key={label}>
                    <b>{label}</b>{note && <p>{note}</p>}
                    {command.startsWith('page:')
                      ? <button type="button" className="ghost" onClick={() => patch({ page: command.slice(5) })}>Open Evaluate</button>
                      : <code>{command}</code>}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </section>

      <section className="band section">
        <h2>Q&amp;A</h2>
        <div className="faq">
          {FAQ.map(([question, answer]) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}
        </div>
      </section>
    </>
  );
}
