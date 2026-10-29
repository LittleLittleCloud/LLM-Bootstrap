import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const schema = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const skills = ['bootstrap-build', 'bootstrap-evaluate', 'bootstrap-experiment-sop', 'bootstrap-plan'];
const resources = ['README.md', 'AGENTS.md', 'docs', 'evaluations', 'experiments', 'schema', 'skills'];
const read = (base, path) => readFileSync(join(base, path), 'utf8');
const json = (base, path) => JSON.parse(read(base, path));

function containedFile(base, path) {
  const resolved = realpathSync(path);
  const rel = relative(realpathSync(base), resolved);
  assert.ok(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), `Path escapes plugin: ${path}`);
  assert.ok(statSync(resolved).isFile(), `Not a file: ${path}`);
}

function files(base) {
  return readdirSync(base, { withFileTypes: true }).flatMap(entry => {
    const path = join(base, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

function checkManifests(base) {
  const agent = json(base, 'plugin.json');
  const claude = json(base, '.claude-plugin/plugin.json');
  assert.equal(agent.$schema, schema);
  // This package deliberately uses only the shared metadata subset, not runtime components.
  const { $schema, ...metadata } = agent;
  const fields = ['name', 'version', 'description', 'author', 'homepage', 'repository', 'keywords'];
  assert.deepEqual(Object.keys(metadata).sort(), fields.sort());
  assert.deepEqual(metadata, claude);
  assert.match(agent.name, /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
  assert.ok(agent.name.length <= 64);
  assert.match(agent.version, /^\d+\.\d+\.\d+$/);
  for (const field of ['description', 'homepage', 'repository']) {
    assert.equal(typeof agent[field], 'string');
    assert.ok(agent[field].length > 0);
  }
  assert.deepEqual(Object.keys(agent.author).sort(), ['name', 'url']);
  assert.equal(typeof agent.author.name, 'string');
  assert.equal(typeof agent.author.url, 'string');
  assert.ok(Array.isArray(agent.keywords) && agent.keywords.every(word => typeof word === 'string'));

  const marketplace = json(base, '.claude-plugin/marketplace.json');
  assert.equal(marketplace.name, 'llm-bootstrap-marketplace');
  assert.equal(marketplace.owner.name, agent.author.name);
  assert.deepEqual(marketplace.plugins, [{
    name: agent.name, source: './', version: agent.version, description: agent.description,
  }]);
  assert.equal(realpathSync(resolve(base, marketplace.plugins[0].source)), realpathSync(base));
}

function checkResources(base) {
  const skillDirs = readdirSync(join(base, 'skills')).sort();
  assert.deepEqual(skillDirs, skills);
  for (const name of skills) {
    const content = read(base, `skills/${name}/SKILL.md`);
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    assert.ok(frontmatter, `Missing skill frontmatter: ${name}`);
    assert.match(frontmatter[1], new RegExp(`^name: ${name}$`, 'm'));
    const description = frontmatter[1].match(/^description: (.+)$/m)?.[1];
    assert.ok(description && description.length <= 1024, `Missing/invalid description: ${name}`);
    assert.ok(content.includes('../../docs/experiment-protocol.md'));
    assert.match(content, /relative to this SKILL\.md file/);
    assert.match(content, /read-only/);
    assert.match(content, /codex\//);
  }

  for (const path of resources.flatMap(entry => {
    const target = join(base, entry);
    return statSync(target).isDirectory() ? files(target) : [target];
  })) {
    containedFile(base, path);
    if (path.endsWith('.json')) JSON.parse(readFileSync(path, 'utf8'));
    if (!path.endsWith('.md')) continue;
    const content = readFileSync(path, 'utf8');
    for (const [, target] of content.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)) {
      if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('#')) continue;
      const local = decodeURIComponent(target.split('#')[0]);
      containedFile(base, resolve(dirname(path), local));
    }
  }
}

test('Agent Plugins and Claude manifests share valid package metadata and marketplace source', () => {
  checkManifests(root);
});

test('all skills and their bundled Markdown/JSON resources resolve within the package', () => {
  checkResources(root);
});

test('the complete plugin remains readable after relocation, independently of the session workspace', () => {
  const temp = mkdtempSync(join(tmpdir(), 'llm-bootstrap-plugin-'));
  try {
    const installed = join(temp, 'plugin cache with spaces');
    for (const entry of ['plugin.json', '.claude-plugin', ...resources]) {
      cpSync(join(root, entry), join(installed, entry), { recursive: true });
    }
    checkManifests(installed);
    checkResources(installed);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});