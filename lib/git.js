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

export function matchingPRs(repository, publishedRepo, publishedBranch) {
  return (repository?.prs ?? []).filter(pr =>
    pr.headRepo?.toLowerCase() === publishedRepo?.toLowerCase() && pr.headBranch === publishedBranch);
}

export async function collectGit(run, cwd, repository = null, repo = null) {
  const git = args => run(['git', '--no-lazy-fetch', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args]);
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
  let branchFiles = null;
  if (targetComparison) {
    const base = await optional(['merge-base', target.sha, head]);
    if (base) {
      const result = await git(['diff', '--name-only', '-z', '--no-renames', base, head, '--']);
      if (result.exitCode === 0) branchFiles = result.stdout.split('\0').filter(Boolean).sort();
    }
  }
  const finalHead = await optional(['rev-parse', '--verify', 'HEAD']);
  const finalBranch = await optional(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (head !== finalHead || branch !== finalBranch) throw new Error('Checkout changed during observation; sampling again next tick.');
  return {
    root,
    git: {
      branch, head, shallow, ...changes, branchFiles,
      published, target, publishedComparison, targetComparison,
      upstreamConfigured: Boolean(trackingRepo && trackingRef),
    },
  };
}
