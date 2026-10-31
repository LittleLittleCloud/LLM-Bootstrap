// Long-context documents: neutral log lines with one access-code entry, shared by the needle, prefill, and cache tests.
import { streamChat } from './client.js';
import { seeded } from './util.js';

const SECTORS = ['blue', 'amber', 'cobalt', 'verdant', 'indigo', 'rose', 'slate', 'topaz'];
// Characters that cannot be misread for one another.
const CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const MIN_DOCUMENT_TOKENS = 256;

// None of these mention codes or sectors, so the needle is the only such line in a document.
const FILLER = [
  (r, n) => `Entry ${n}: routine telemetry sweep on module ${1 + Math.floor(r() * 48)} completed; all readings within normal range.`,
  (r, n) => `Entry ${n}: cache warm-up for shard ${1 + Math.floor(r() * 32)} finished in ${40 + Math.floor(r() * 900)} ms with no errors reported.`,
  (_r, n) => `Entry ${n}: scheduled checkpoint archived to cold storage; checksum verified.`,
  (r, n) => `Entry ${n}: background compaction merged ${1 + Math.floor(r() * 2400)} records on storage node ${1 + Math.floor(r() * 16)} without warnings.`,
  (r, n) => `Entry ${n}: queue depth settled at ${Math.floor(r() * 900)} items; consumer lag remains inside the green band.`,
  (r, n) => `Entry ${n}: index rebuild on replica ${1 + Math.floor(r() * 8)} completed; latency profile nominal.`,
  (r, n) => `Entry ${n}: disk usage on volume ${1 + Math.floor(r() * 12)} returned to ${30 + Math.floor(r() * 40)} percent after cleanup.`,
  (r, n) => `Entry ${n}: health probe round ${1 + Math.floor(r() * 4000)} passed across ${2 + Math.floor(r() * 30)} upstream targets.`,
  (r, n) => `Entry ${n}: configuration snapshot ${100 + Math.floor(r() * 800)} applied to the staging fleet.`,
  (r, n) => `Entry ${n}: throughput sample recorded at ${50 + Math.floor(r() * 4000)} requests per second over a five-minute window.`,
];

export const fillerLine = (random, number) => FILLER[Math.floor(random() * FILLER.length)](random, number);

function accessCode(random) {
  const group = () => Array.from({ length: 4 }, () => CODE_CHARSET[Math.floor(random() * CODE_CHARSET.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}

// Grows filler lines until the text reaches the target size, then replaces one line with the access-code entry.
export function buildDocument({ random, sector, code, positionPercent, targetTokens, charsPerToken }) {
  const lines = [];
  const targetCharacters = Math.max(MIN_DOCUMENT_TOKENS, targetTokens) * charsPerToken;
  let total = 0;
  while (lines.length < 8 || total < targetCharacters + 64) {
    const line = fillerLine(random, lines.length + 1);
    lines.push(line);
    total += line.length + 1;
  }
  const index = Math.max(0, Math.min(lines.length - 1, Math.round((lines.length - 1) * positionPercent / 100)));
  lines[index] = `Entry ${index + 1}: access code for sector ${sector} is ${code}.`;
  return { lines, needleIndex: index };
}

export function renderPrompt(lines, sector) {
  return [
    `The log document below contains many entries. Exactly one entry contains the access code for the ${sector} sector. Read the document and report that access code.`,
    '', '--- DOCUMENT START ---', ...lines, '--- DOCUMENT END ---', '',
    `Report the access code for the ${sector} sector.`, '',
    'Your entire response must be exactly one line containing only the access code, exactly as it appears in the document entry.',
    'Output nothing else. Do not include reasoning, explanations, labels, markdown, or any text beyond the access code.',
  ].join('\n');
}

export function generateTask({ seed, targetTokens, positionPercent, charsPerToken }) {
  const random = seeded(seed);
  const sector = SECTORS[Math.floor(random() * SECTORS.length)];
  const code = accessCode(random);
  const document = buildDocument({ random, sector, code, positionPercent, targetTokens, charsPerToken });
  return { prompt: renderPrompt(document.lines, sector), expected: code, sector, lineCount: document.lines.length, needleLine: document.needleIndex };
}

export function gradeCode(content, expected) {
  const raw = (content ?? '').trim();
  const match = /^([A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4})$/.exec(raw);
  if (!match) return { compliant: false, correct: false };
  return { compliant: true, correct: match[1].toUpperCase() === expected.toUpperCase() };
}

// How many characters of this document make a token for the model, from one probe, so documents land near their target size.
export async function calibrateCharsPerToken(env, { seed, timeoutMs, signal }) {
  const task = generateTask({ seed: `${seed}:calibrate`, targetTokens: 1500, positionPercent: 50, charsPerToken: 4 });
  const result = await streamChat(env, { messages: [{ role: 'user', content: task.prompt }], maxTokens: 16, timeoutMs, signal });
  if (!result.ok || !(result.promptTokens > 0)) return null;
  return Math.min(8, Math.max(1.5, task.prompt.length / result.promptTokens));
}
