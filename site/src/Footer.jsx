const ITEMS = [
  ['Ranked', 'Every measured run, a regression included. Conformance is shown beside it.'],
  ['Controlled', 'Same hardware, model, weights, evaluation, track, and profile.'],
  ['Tracks', 'Matched configuration and best permitted system are separate comparisons.'],
];

export function Footer() {
  return (
    <footer className="band foot">
      {ITEMS.map(([key, text]) => <div key={key}><h2>{key}</h2><p>{text}</p></div>)}
    </footer>
  );
}
