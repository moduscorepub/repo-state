export function githubSlug(remote) {
  if (!remote) return null;
  let path;
  const ssh = /^git@github\.com:(.+)$/.exec(remote.trim());
  if (ssh) path = ssh[1];
  else {
    try {
      const url = new URL(remote.trim());
      if (url.hostname !== 'github.com' || !['https:', 'ssh:'].includes(url.protocol)) return null;
      path = url.pathname.replace(/^\//, '');
    } catch { return null; }
  }
  path = path.replace(/\.git$/, '').replace(/\/$/, '');
  return /^[\w.-]+\/[\w.-]+$/.test(path) ? path : null;
}

export function parseStatus(output) {
  const staged = new Set(), unstaged = new Set(), untracked = new Set(), conflicted = new Set();
  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const status = record.slice(0, 2);
    const paths = [record.slice(3)];
    if (status.includes('R') || status.includes('C')) paths.push(records[++i]);
    for (const path of paths) {
      if (!path) continue;
      if (status === '??') untracked.add(path);
      else if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(status)) conflicted.add(path);
      else {
        if (status[0] !== ' ' && status[0] !== '?') staged.add(path);
        if (status[1] !== ' ' && status[1] !== '?') unstaged.add(path);
      }
    }
  }
  return {
    staged: [...staged].sort(), unstaged: [...unstaged].sort(),
    untracked: [...untracked].sort(), conflicted: [...conflicted].sort(),
  };
}

export const DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'];
// Read-only: no lazy object fetches, optional index locks, fsmonitor hooks, or diff index refresh writes.
export const gitArgs = (cwd, args) => ['git', '--no-lazy-fetch', '--no-optional-locks', '-c', 'core.fsmonitor=false',
  '-c', 'diff.autoRefreshIndex=false', '-C', cwd, ...args];

// `--name-only -z` and `-U0` list one diff queue in the same order; names stay exact even when quoted in headers.
export function parseDiff(names, patch) {
  const paths = names.split('\0').filter(Boolean);
  const sections = patch.split(/^diff --git /m).slice(1);
  if (sections.length !== paths.length) return null;
  return new Map(paths.map((path, index) => {
    const section = sections[index];
    const file = { status: /^new file mode/m.test(section) ? 'A' : /^deleted file mode/m.test(section) ? 'D' : 'M',
      added: 0, removed: 0, hunks: [] };
    for (const line of section.split('\n')) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunk) file.hunks.push([+hunk[1], hunk[2] === undefined ? 1 : +hunk[2], +hunk[3], hunk[4] === undefined ? 1 : +hunk[4]]);
      else if (file.hunks.length && line[0] === '+') file.added++;
      else if (file.hunks.length && line[0] === '-') file.removed++;
    }
    if (/^Binary files /m.test(section)) Object.assign(file, { added: null, removed: null, hunks: null });
    return [path, file];
  }));
}

function mapLine(line, hunks) {
  let delta = 0;
  for (const [oldStart, oldLines, newStart, newLines] of hunks) {
    if (oldLines === 0 ? line <= oldStart : line < oldStart) break;
    if (oldLines > 0 && line < oldStart + oldLines) return [newStart, newStart + Math.max(newLines, 1) - 1];
    delta += newLines - oldLines;
  }
  return [line + delta, line + delta];
}

// Own hunks are in merge-base lines; target hunks move them onto the current target revision.
export function targetRanges(hunks, targetHunks = []) {
  const ranges = hunks.map(([start, count]) => count ? [start, start + count - 1] : [Math.max(start, 1), start + 1])
    .map(([start, end]) => [Math.max(1, mapLine(start, targetHunks)[0]), Math.max(1, mapLine(end, targetHunks)[1])])
    .map(([start, end]) => [start, Math.max(start, end)])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged.length > 100 ? null : merged;
}

export function matchingPRs(repository, publishedRepo, publishedBranch) {
  return (repository?.prs ?? []).filter(pr =>
    pr.headRepo?.toLowerCase() === publishedRepo?.toLowerCase() && pr.headBranch === publishedBranch);
}

export async function collectGit(run, cwd, repository = null, repo = null) {
  const git = args => run(gitArgs(cwd, args));
  const diffFiles = async revisions => {
    const names = await git(['--literal-pathspecs', ...DIFF, '--name-only', '-z', ...revisions]);
    const patch = await git(['--literal-pathspecs', ...DIFF, '-U0', ...revisions]);
    return names.exitCode === 0 && patch.exitCode === 0 ? parseDiff(names.stdout, patch.stdout) : null;
  };
  const required = async args => {
    const result = await git(args);
    if (result.exitCode !== 0) throw new Error('Git observation failed; previous state is not fresh.');
    return result.stdout;
  };
  const optional = async args => {
    const result = await git(args);
    return result.exitCode === 0 ? result.stdout.trim() : null;
  };
  const root = (await required(['rev-parse', '--show-toplevel'])).trim();
  const head = await optional(['rev-parse', '--verify', 'HEAD']);
  const branch = await optional(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const shallow = (await required(['rev-parse', '--is-shallow-repository'])).trim() === 'true';
  const changes = parseStatus(await required(['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  const origin = githubSlug(await optional(['config', '--get', 'remote.origin.url']));
  const trackingRemote = branch ? await optional(['config', '--get', `branch.${branch}.remote`]) : null;
  const trackingRef = branch ? await optional(['config', '--get', `branch.${branch}.merge`]) : null;
  const trackingRepo = trackingRemote && trackingRemote !== '.'
    ? githubSlug(await optional(['config', '--get', `remote.${trackingRemote}.url`])) : null;
  const publishedRepo = trackingRepo ?? origin;
  const publishedBranch = trackingRepo && trackingRef?.startsWith('refs/heads/')
    ? trackingRef.slice(11) : branch;
  const prs = matchingPRs(repository, publishedRepo, publishedBranch);
  const targets = [...new Set(prs.filter(pr => pr.state === 'OPEN').map(pr => pr.baseBranch))];
  const targetBranch = targets.length === 1 ? targets[0]
    : targets.length > 1 ? null : repository?.defaultBranch ?? null;
  const refs = repository?.refs ?? {};
  const lookup = (slug, name) => slug && name ? refs[`${slug.toLowerCase()}:${name}`] : null;
  const publishedRef = lookup(publishedRepo, publishedBranch);
  const targetRef = lookup(repo ?? repository?.slug, targetBranch);
  const published = {
    repo: publishedRepo, branch: publishedBranch, sha: publishedRef?.sha ?? null,
    observedAt: publishedRef?.observedAt ?? null, exists: publishedRef?.exists ?? null,
  };
  const target = {
    repo: repo ?? repository?.slug ?? null, branch: targetBranch, sha: targetRef?.sha ?? null,
    observedAt: targetRef?.observedAt ?? null, exists: targetRef?.exists ?? null,
  };
  const compare = async ref => {
    if (!head || !ref.sha || shallow || !ref.observedAt || (repository?.serverNow ?? Date.now()) - ref.observedAt > 90_000) return null;
    if ((await git(['cat-file', '-e', `${ref.sha}^{commit}`])).exitCode !== 0) return null;
    const result = await git(['rev-list', '--left-right', '--count', `${ref.sha}...${head}`]);
    if (result.exitCode !== 0) return null;
    const [behind, ahead] = result.stdout.trim().split(/\s+/).map(Number);
    if (!Number.isSafeInteger(behind) || !Number.isSafeInteger(ahead)) return null;
    return { ahead, behind, contains: behind === 0 };
  };
  const publishedComparison = await compare(published);
  const targetComparison = await compare(target);
  // Committed branch work counts only against the target merge base; otherwise only uncommitted work is known.
  const base = targetComparison ? await optional(['merge-base', target.sha, head]) : head;
  const own = base ? await diffFiles([base, '--']) : null;
  let filesBase = null, targetHunks = null;
  if (own && targetComparison) {
    const modified = [...own].filter(([, file]) => file.status === 'M' && file.hunks).map(([path]) => path);
    targetHunks = base === target.sha ? new Map()
      : modified.length <= 300 ? await diffFiles([base, target.sha, '--', ...modified]) : null;
    if (targetHunks) filesBase = target.sha;
  }
  const entries = new Map([...changes.staged, ...changes.unstaged].map(path =>
    [path, { path, status: 'M', added: null, removed: null, lines: null }]));
  for (const [path, file] of own ?? []) entries.set(path, { path, status: file.status, added: file.added, removed: file.removed,
    lines: filesBase && file.status === 'M' && file.hunks ? targetRanges(file.hunks, targetHunks.get(path)?.hunks) : null });
  for (const path of changes.untracked) entries.set(path, { path, status: '?', added: null, removed: null, lines: null });
  for (const path of changes.conflicted) entries.set(path, { path, status: 'U', added: null, removed: null, lines: null });
  const files = [...entries.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const finalHead = await optional(['rev-parse', '--verify', 'HEAD']);
  const finalBranch = await optional(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (head !== finalHead || branch !== finalBranch) throw new Error('Checkout changed during observation; sampling again next tick.');
  return {
    root,
    git: {
      branch, head, shallow, ...changes, files, filesBase,
      published, target, publishedComparison, targetComparison,
      upstreamConfigured: Boolean(trackingRepo && trackingRef),
    },
  };
}
