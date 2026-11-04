// What a published pelican drawing must satisfy. A drawing is model output, so the repository accepts it only when it cannot do more than
// draw: no script, no event handler, no embedded document, and no reference to anything outside the file. The site also draws it
// through an image element and serves it with a locked-down content security policy; these checks keep the file itself harmless.
export const DRAWING_MAX_BYTES = 256 * 1024;

const FORBIDDEN = [
  [/<\s*script\b/i, 'contains a script element'],
  [/<\s*(?:foreignObject|iframe|embed|object)\b/i, 'contains an embedded document'],
  [/<!\s*(?:DOCTYPE|ENTITY)/i, 'declares a DOCTYPE or an entity'],
  [/<\?(?!xml\b)/i, 'contains a processing instruction'],
  [/[\s"'/]on[a-z]+\s*=/i, 'contains an event handler attribute'],
  [/javascript\s*:/i, 'contains a javascript: URL'],
  [/@import\b/i, 'imports a stylesheet'],
];

// Reasons the text is not an acceptable drawing; an empty list accepts it.
export function drawingProblems(svg) {
  const problems = [];
  const bytes = Buffer.byteLength(svg);
  if (bytes > DRAWING_MAX_BYTES) problems.push(`is ${bytes} bytes, over the ${DRAWING_MAX_BYTES}-byte limit`);
  if (!/^\s*<svg[\s>]/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) problems.push('is not a single <svg> element');
  for (const [pattern, reason] of FORBIDDEN) if (pattern.test(svg)) problems.push(reason);
  // Only references inside the file (#id) may be followed.
  for (const match of svg.matchAll(/\b(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    if (!(match[1] ?? match[2]).trim().startsWith('#')) problems.push('references something outside the file with href');
  }
  for (const match of svg.matchAll(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi)) {
    if (!match[2].trim().startsWith('#')) problems.push('references something outside the file with url()');
  }
  return [...new Set(problems)];
}
