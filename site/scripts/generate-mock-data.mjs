// Deterministic generator for the leaderboard demo data. Every value is synthetic; nothing here was measured.
// Usage: node site/scripts/generate-mock-data.mjs   (rewrites site/data/runs.mock.json)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HARDWARE = {
  a: { name: 'Mock Silicon M-Pro · 48 GiB', speed: 1.0 },
  b: { name: 'Mock GPU X · 32 GiB', speed: 1.7 },
  c: { name: 'Mock APU · 128 GiB', speed: 0.65 },
};
const MODELS = {
  m35: { name: 'Mock-35B-A3B 8bit', gib: 36, decode: 62 },
  m8: { name: 'Mock-8B Q4', gib: 5.2, decode: 95 },
  m70: { name: 'Mock-70B Q4', gib: 41, decode: 14 },
};
const EVALUATIONS = { 'mock-humaneval-20': 20, 'mock-longctx-8k': 12 };
// Hardware, target model, evaluation. Every model fits in its hardware's memory.
const COHORTS = [
  ['a', 'm35', 'mock-humaneval-20'],
  ['a', 'm35', 'mock-longctx-8k'],
  ['a', 'm8', 'mock-humaneval-20'],
  ['b', 'm8', 'mock-humaneval-20'],
  ['c', 'm35', 'mock-humaneval-20'],
  ['c', 'm70', 'mock-humaneval-20'],
];
const BUILDERS = ['Mock Builder Alpha', 'Mock Builder Beta', 'Mock Builder Gamma'];
const HARNESSES = ['Mock Harness 1.0', 'Mock Harness 2.0'];
const ENGINES = ['mock-aster', 'mock-basalt', 'mock-cinder', 'mock-dune', 'mock-ember', 'mock-flint', 'mock-grove', 'mock-harbor'];
const BASELINES = [['mock-baseline-x', 0.92], ['mock-baseline-y', 1.0]];
const FIRST_DAY = Date.UTC(2026, 5, 1);
const LAST_DAY = Date.UTC(2026, 9, 26);
const DAY = 86400000;

export function generate() {
  const rand = seeded(20261028);
  const between = (low, high) => low + (high - low) * rand();
  const pick = list => list[Math.floor(rand() * list.length)];
  const hex = length => Array.from({ length }, () => Math.floor(rand() * 16).toString(16)).join('');
  const round = (value, digits) => Number(value.toFixed(digits));
  const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
  const runs = [];

  COHORTS.forEach(([hardwareKey, modelKey, evaluation], cohortIndex) => {
    const hardware = HARDWARE[hardwareKey];
    const model = MODELS[modelKey];
    const total = EVALUATIONS[evaluation];
    const code = `${hardwareKey}${modelKey.slice(1)}${evaluation === 'mock-longctx-8k' ? 'l' : ''}`;
    const base = model.decode * hardware.speed;

    function record(fields) {
      const ratio = fields.ratio;
      const decode = base * ratio * (1 + between(-0.025, 0.025));
      const failed = fields.failed;
      runs.push({
        run_id: '',
        experiment_id: fields.experiment,
        derived_from: fields.parent ?? null,
        date: isoDay(fields.day),
        role: fields.role,
        comparison_track: fields.track,
        engine: { name: fields.engine, revision: fields.revision, backend: fields.backend },
        hardware: hardware.name,
        target_model: model.name,
        builder: fields.builder,
        harness: fields.harness,
        evaluation,
        metrics: {
          decode_tok_s: round(decode, 1),
          prefill_tok_s: round(decode * fields.prefillFactor * (1 + between(-0.04, 0.04)), 1),
          ttft_ms_p50: Math.round((1800 / ratio) * (model.gib / 36) * between(0.92, 1.08)),
          peak_memory_gib: round(model.gib * fields.memoryFactor, 1),
        },
        quality_gate: failed ? 'failed' : 'passed',
        quality: {
          task_pass: failed ? total - Math.ceil(between(1, 6)) : total,
          task_total: total,
          numerical_max_abs_error: round(failed ? between(0.04, 0.3) : Math.pow(10, between(-3, -2.2)), 4),
        },
        autonomy: fields.autonomy,
        evidence: rand() < 0.7 ? 'public' : 'local-only',
        synthetic: true,
      });
    }

    // Baselines are measured early and again later under the same matched conditions.
    BASELINES.forEach(([engine, ratio], index) => {
      const revision = hex(40);
      [FIRST_DAY + between(0, 20) * DAY, FIRST_DAY + between(70, 110) * DAY].forEach(day => {
        record({
          experiment: `mock-${code}-baselines`, role: 'baseline', track: 'matched', engine, revision, backend: 'reference',
          builder: 'n/a', harness: HARNESSES[index % 2], ratio: ratio * (1 + between(-0.015, 0.015)), day, failed: false,
          prefillFactor: 10 + index, memoryFactor: 1.1 + index * 0.04,
          autonomy: { human_interventions: 0, hardware_hours: 0, builder_tokens_m: 0, self_hosting: false },
        });
      });
    });

    // Two independent lineages per cohort; each has a root experiment and one or two derived experiments.
    for (let lineage = 0; lineage < 2; lineage += 1) {
      const engine = ENGINES[(cohortIndex * 2 + lineage) % ENGINES.length];
      const track = rand() < 0.3 ? 'best-permitted' : 'matched';
      const selfHosting = rand() < 0.25;
      const prefillFactor = between(9, 13);
      let builder = pick(BUILDERS);
      let harness = pick(HARNESSES);
      let level = between(0.3, 0.45);
      let day = FIRST_DAY + between(0, 40) * DAY;
      let memoryFactor = between(1.08, 1.2);
      let parent = null;
      const root = `mock-${code}-${lineage + 1}`;
      const chain = [root, ...Array.from({ length: 1 + Math.floor(rand() * 2) }, (_, i) => `${root}-d${i + 1}`)];

      chain.forEach(experiment => {
        const revisions = parent ? 3 + Math.floor(rand() * 3) : 5 + Math.floor(rand() * 3);
        const target = parent ? level * between(0.97, 1.22) : between(0.8, 1.3);
        const start = level;
        let hours = 0;
        let tokens = 0;
        if (parent && rand() < 0.4) builder = pick(BUILDERS);
        for (let k = 0; k < revisions; k += 1) {
          day += between(4, 12) * DAY;
          if (day > LAST_DAY) break;
          const progress = (1 - Math.exp(-2.2 * ((k + 1) / revisions))) / (1 - Math.exp(-2.2));
          level = start + (target - start) * progress;
          const ratio = level * (track === 'best-permitted' ? 1.08 : 1);
          memoryFactor = Math.max(1.03, memoryFactor - between(0, 0.02));
          hours += between(0.5, 3);
          tokens += between(2, 9);
          record({
            experiment, parent, role: 'candidate', track, engine, revision: hex(40), backend: 'native', builder, harness,
            ratio, day, failed: rand() < 0.22 - 0.16 * (k / revisions), prefillFactor, memoryFactor,
            autonomy: {
              human_interventions: Math.max(0, Math.round(between(0, 6) - k * 0.5)),
              hardware_hours: round(hours, 1),
              builder_tokens_m: round(tokens, 1),
              self_hosting: selfHosting && k >= Math.ceil(revisions * 0.6),
            },
          });
        }
        day += between(3, 10) * DAY;
        parent = experiment;
      });
    }
  });

  runs.sort((x, y) => x.date.localeCompare(y.date) || x.experiment_id.localeCompare(y.experiment_id));
  runs.forEach((run, index) => { run.run_id = `mock-run-${String(index + 1).padStart(4, '0')}`; });

  const head = [
    '"schema_version": "0.1.0"',
    '"synthetic": true',
    '"note": "Synthetic demo data generated by site/scripts/generate-mock-data.mjs. No value was measured."',
  ];
  return `{\n${head.join(',\n')},\n"runs": [\n${runs.map(run => JSON.stringify(run)).join(',\n')}\n]\n}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = new URL('../data/runs.mock.json', import.meta.url);
  writeFileSync(target, generate());
  console.log(`wrote ${fileURLToPath(target)}`);
}
