import test from 'node:test';
import assert from 'node:assert/strict';
import { dependencies, dependencyStates, overlaps, checkedCI } from '../lib/state.js';

test('dependencies are explicit, ignore examples, and retain invalid or unsupported declarations', () => {
  const body = 'Uses #8.\n```\nDepends-On: #9\n```\n> Depends-On: #10\nDepends-On: #42, #44\nDepends-On: #42 other/repo#7 bad\n';
  assert.deepEqual(dependencies(body), [
    { ref: '#42', number: 42, kind: 'local' }, { ref: '#44', number: 44, kind: 'local' },
    { ref: 'other/repo#7', number: null, kind: 'unsupported' }, { ref: 'bad', number: null, kind: 'invalid' },
  ]);
});

test('cycles, self-dependencies, and closed-unmerged prerequisites never appear satisfied', () => {
  const pr = (number, body, state = 'OPEN', baseBranch = 'main') => ({ number, state, baseBranch, dependencies: dependencies(body) });
  const result = dependencyStates([pr(1, 'Depends-On: #2'), pr(2, 'Depends-On: #1'), pr(3, 'Depends-On: #3, #4, #5, #6')], [pr(4, '', 'CLOSED'), pr(5, '', 'MERGED', 'release')]);
  assert.deepEqual(result.map(item => item.cycle), [true, true, true]);
  assert.deepEqual(result[2].dependencies.map(item => item.status), ['self-dependency', 'closed-unmerged', 'merged', 'unknown']);
  assert.equal(result[2].dependencies[2].baseBranch, 'release');
});

test('CI coverage excludes newer commits, dirty working trees, and checks for an older published head', () => {
  const pr = { headSha: 'a'.repeat(40), ci: { sha: 'a'.repeat(40), state: 'SUCCESS' } };
  const clean = { head: pr.headSha, staged: [], unstaged: [], untracked: [], conflicted: [] };
  assert.equal(checkedCI(pr, clean)?.localChecked, true);
  assert.equal(checkedCI(pr, { ...clean, head: 'b'.repeat(40) })?.localChecked, false);
  assert.equal(checkedCI(pr, { ...clean, untracked: ['new.ts'] })?.localChecked, false);
  assert.equal(checkedCI({ ...pr, headSha: 'c'.repeat(40) }), null);
});

test('overlap is exact-path metadata and excludes stale observations', () => {
  const workspace = (id, files, stale = false) => ({ id, stale, git: { branchFiles: files, staged: [], unstaged: [], untracked: [], conflicted: [] } });
  const rows = [workspace('a', ['auth.ts']), workspace('b', ['auth.ts', 'auth.ts']), workspace('c', ['auth.ts'], true), workspace('d', ['other.ts'])];
  assert.deepEqual(overlaps(rows), [{ a: 'a', b: 'b', paths: ['auth.ts'] }]);
});
