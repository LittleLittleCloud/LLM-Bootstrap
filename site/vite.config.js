import { execSync } from 'node:child_process';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const git = command => {
  try { return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
};

// The commit that pins the evaluator build. Uncommitted changes under evaluations/ make the build unpinned.
const head = process.env.WORKERS_CI_COMMIT_SHA || git('git rev-parse HEAD');
const revision = /^[0-9a-f]{40}$/.test(head) ? head : '0'.repeat(40);
const dirty = revision === '0'.repeat(40) || git('git status --porcelain -- ../evaluations').length > 0;

export default defineConfig({
  plugins: [react()],
  define: { __EVALUATION_REVISION__: JSON.stringify(revision), __EVALUATION_DIRTY__: JSON.stringify(dirty) },
  server: { fs: { allow: ['..'] } },
});
