export const STALE_MS = 45_000;
export const EXPIRE_MS = 300_000;
export const GITHUB_STALE_MS = 90_000;
export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function dependencies(body = '') {
  const found = new Map();
  let fence = null;
  for (const line of body.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const match = /^Depends-On:\s*(.*)$/.exec(line);
    if (!match) continue;
    const refs = match[1].trim().split(/[\s,]+/).filter(Boolean);
    if (!refs.length) refs.push('(empty)');
    for (const ref of refs) {
      const local = /^#([1-9]\d*)$/.exec(ref);
      const number = local ? Number(local[1]) : null;
      const kind = number && Number.isSafeInteger(number) ? 'local'
        : /^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(ref) ? 'unsupported' : 'invalid';
      found.set(ref, { ref, number: kind === 'local' ? number : null, kind });
    }
  }
  return [...found.values()];
}

export function dependencyStates(prs, prerequisites = []) {
  const index = new Map([...prerequisites, ...prs].map(pr => [pr.number, pr]));
  const cyclic = new Set();
  const visiting = new Set(), visited = new Set(), stack = [];
  function visit(number) {
    if (visiting.has(number)) {
      for (const member of stack.slice(stack.indexOf(number))) cyclic.add(member);
      return;
    }
    if (visited.has(number)) return;
    visiting.add(number); stack.push(number);
    for (const dependency of index.get(number)?.dependencies ?? []) {
      if (dependency.kind === 'local' && index.has(dependency.number)) visit(dependency.number);
    }
    stack.pop(); visiting.delete(number); visited.add(number);
  }
  for (const number of index.keys()) visit(number);
  return prs.map(pr => ({
    ...pr, cycle: cyclic.has(pr.number),
    dependencies: pr.dependencies.map(dependency => {
      const prerequisite = index.get(dependency.number);
      const status = dependency.kind !== 'local' ? dependency.kind
        : dependency.number === pr.number ? 'self-dependency'
        : !prerequisite ? 'unknown'
        : prerequisite.state === 'MERGED' ? 'merged'
        : prerequisite.state === 'CLOSED' ? 'closed-unmerged' : 'open';
      return { ...dependency, status, baseBranch: prerequisite?.baseBranch ?? null };
    }),
  }));
}

export function overlaps(workspaces) {
  const notices = [];
  // ponytail: pairwise scan for small teams; index paths if large repos make it measurable.
  for (let i = 0; i < workspaces.length; i++) {
    const a = workspaces[i];
    if (a.stale) continue;
    const paths = new Set([...(a.git.branchFiles ?? []), ...a.git.staged, ...a.git.unstaged,
      ...a.git.untracked, ...a.git.conflicted]);
    for (const b of workspaces.slice(i + 1)) {
      if (b.stale) continue;
      const other = [...(b.git.branchFiles ?? []), ...b.git.staged, ...b.git.unstaged,
        ...b.git.untracked, ...b.git.conflicted];
      const shared = [...new Set(other.filter(path => paths.has(path)))].sort();
      if (shared.length) notices.push({ a: a.id, b: b.id, paths: shared });
    }
  }
  return notices;
}

export function safeText(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g,
    char => JSON.stringify(char).slice(1, -1));
}

export function ageText(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

export function checkedCI(pr, git = null) {
  if (!pr.ci?.sha || pr.ci.sha !== pr.headSha) return null;
  return { ...pr.ci, localChecked: git ? git.head === pr.ci.sha
    && ['staged', 'unstaged', 'untracked', 'conflicted'].every(kind => git[kind].length === 0) : null };
}
