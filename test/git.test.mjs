import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rename, rm, mkdir, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectGit, githubSlug, matchingPRs } from '../lib/git.js';
import { sharedFile } from '../lib/state.js';
const exec = promisify(execFile);
const run = async args => {
  try { const result = await exec(args[0], args.slice(1)); return { exitCode: 0, stdout: result.stdout }; }
  catch (error) { return { exitCode: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '' }; }
};

test('real Git collection distinguishes unpublished commits, target drift, renames, detached HEAD and missing history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'repo-state-git-'));
  const git = async (...args) => {
    const result = await run(['git', '-C', dir, ...args]);
    assert.equal(result.exitCode, 0, args.join(' ')); return result.stdout.trim();
  };
  try {
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'test@example.invalid');
    await git('config', 'user.name', 'Repo State Test');
    await git('remote', 'add', 'origin', 'https://github.com/example/project.git');
    await writeFile(join(dir, 'original name.txt'), 'base\n');
    await git('add', '.'); await git('commit', '-m', 'base');
    const base = await git('rev-parse', 'HEAD');
    await git('checkout', '-b', 'feature');
    await writeFile(join(dir, 'feature.txt'), 'unpublished\n');
    await git('add', '.'); await git('commit', '-m', 'feature');
    const head = await git('rev-parse', 'HEAD');
    const repository = { slug: 'example/project', defaultBranch: 'main', prs: [], refs: {
      'example/project:main': { sha: base, exists: true, observedAt: Date.now() },
      'example/project:feature': { sha: base, exists: true, observedAt: Date.now() },
    } };
    let sample = await collectGit(run, dir, repository);
    assert.equal(sample.git.head, head);
    assert.deepEqual(sample.git.publishedComparison, { ahead: 1, behind: 0, contains: true });
    assert.deepEqual(sample.git.files.map(file => [file.path, file.status]), [['feature.txt', 'A']]);
    await rename(join(dir, 'original name.txt'), join(dir, 'renamed\nfile.txt'));
    await git('add', '-A');
    await writeFile(join(dir, 'loose.txt'), 'outside Claude\n');
    sample = await collectGit(run, dir, repository);
    assert.deepEqual(sample.git.staged, ['original name.txt', 'renamed\nfile.txt']);
    assert.deepEqual(sample.git.untracked, ['loose.txt']);
    await git('reset', '--hard', 'HEAD');
    await git('checkout', 'main');
    await writeFile(join(dir, 'target.txt'), 'new target\n');
    await git('add', 'target.txt'); await git('commit', '-m', 'target update');
    const target = await git('rev-parse', 'HEAD');
    await git('checkout', 'feature');
    repository.refs['example/project:main'] = { sha: target, exists: true, observedAt: Date.now() };
    sample = await collectGit(run, dir, repository);
    assert.deepEqual(sample.git.targetComparison, { ahead: 1, behind: 1, contains: false });
    repository.refs['example/project:main'].sha = 'f'.repeat(40);
    sample = await collectGit(run, dir, repository);
    assert.equal(sample.git.targetComparison, null);
    assert.equal(sample.git.filesBase, null);
    await git('checkout', '--detach', head);
    sample = await collectGit(run, dir, repository);
    assert.equal(sample.git.branch, null);
    assert.equal(sample.git.head, head);
    const shallow = join(dir, 'shallow-copy');
    await run(['git', 'clone', '--depth', '1', `file://${dir}`, shallow]);
    sample = await collectGit(run, shallow, repository);
    assert.equal(sample.git.shallow, true);
    assert.equal(sample.git.targetComparison, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('metadata collection neither lazy-fetches missing promisor objects nor rewrites the index', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'repo-state-promisor-'));
  const source = join(dir, 'source'), client = join(dir, 'client');
  const git = async (cwd, ...args) => {
    const result = await run(['git', '-C', cwd, ...args]);
    assert.equal(result.exitCode, 0, args.join(' ')); return result.stdout.trim();
  };
  try {
    await mkdir(source);
    await git(source, 'init', '-b', 'main');
    await git(source, 'config', 'user.email', 'test@example.invalid');
    await git(source, 'config', 'user.name', 'Repo State Test');
    await writeFile(join(source, 'base.txt'), 'base\n');
    await git(source, 'add', '.'); await git(source, 'commit', '-m', 'base');
    await run(['git', 'clone', '--no-local', source, client]);
    await writeFile(join(source, 'target.txt'), 'new target\n');
    await git(source, 'add', '.'); await git(source, 'commit', '-m', 'target update');
    const target = await git(source, 'rev-parse', 'HEAD');
    await git(client, 'config', 'remote.origin.promisor', 'true');
    await git(client, 'config', 'remote.origin.partialclonefilter', 'blob:none');
    await git(client, 'config', 'extensions.partialclone', 'origin');
    const index = join(client, '.git', 'index');
    const before = await readFile(index);
    await utimes(join(client, 'base.txt'), new Date(1), new Date(1));
    const repository = { slug: 'example/project', defaultBranch: 'main', prs: [], refs: {
      'example/project:main': { sha: target, exists: true, observedAt: Date.now() },
    } };
    const sample = await collectGit(run, client, repository, 'example/project');
    assert.equal(sample.git.targetComparison, null);
    assert.equal(sample.git.filesBase, null);
    assert.notEqual((await run(['git', '--no-lazy-fetch', '-C', client, 'cat-file', '-e', target])).exitCode, 0);
    assert.deepEqual(await readFile(index), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('changed lines map onto the current target so branches from older bases compare by real line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'repo-state-lines-'));
  const git = async (...args) => {
    const result = await run(['git', '-C', dir, ...args]);
    assert.equal(result.exitCode, 0, args.join(' ')); return result.stdout.trim();
  };
  const original = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const moved = [...['a', 'b', 'c', 'd', 'e'].map(name => `new ${name}`), ...original];
  const write = rows => writeFile(join(dir, 'api.txt'), `${rows.join('\n')}\n`);
  const sample = async repository => (await collectGit(run, dir, repository, 'example/project')).git;
  try {
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'test@example.invalid');
    await git('config', 'user.name', 'Repo State Test');
    await git('remote', 'add', 'origin', 'https://github.com/example/project.git');
    await write(original); await git('add', '.'); await git('commit', '-m', 'base');
    await git('checkout', '-b', 'alice');
    await write(original.map((row, i) => i >= 19 && i <= 21 ? 'alice' : row)); await git('commit', '-am', 'alice');
    await git('checkout', 'main');
    await write(moved); await git('commit', '-am', 'target moved down five lines');
    const target = await git('rev-parse', 'HEAD');
    const repository = { slug: 'example/project', defaultBranch: 'main', prs: [],
      refs: { 'example/project:main': { sha: target, exists: true, observedAt: Date.now() } } };
    await write(moved.map((row, i) => i === 26 ? 'bob' : row));
    const bob = await sample(repository);
    await write(moved.map((row, i) => i === 1 ? 'carol' : row));
    const carol = await sample(repository);
    await git('checkout', '--', 'api.txt'); await git('checkout', 'alice');
    const alice = await sample(repository);
    assert.deepEqual(alice.files, [{ path: 'api.txt', status: 'M', added: 3, removed: 3, lines: [[25, 27]] }]);
    assert.equal(alice.filesBase, target);
    assert.deepEqual(sharedFile(alice.files[0], bob.files[0], alice.filesBase, bob.filesBase), { kind: 'lines', lines: [[27, 27]] });
    assert.equal(sharedFile(alice.files[0], carol.files[0], alice.filesBase, carol.filesBase).kind, 'areas');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('PR association includes source repository, not just a matching branch name', () => {
  const prs = [{ number: 1, headRepo: 'example/project', headBranch: 'feature' }, { number: 2, headRepo: 'other/fork', headBranch: 'feature' }];
  assert.deepEqual(matchingPRs({ prs }, 'other/fork', 'feature').map(pr => pr.number), [2]);
  assert.equal(githubSlug('https://credential@example.com/example/project.git'), null);
  assert.equal(githubSlug('git@github.com:example/project.git'), 'example/project');
});
