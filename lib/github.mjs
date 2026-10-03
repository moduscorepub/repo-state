import { dependencies, dependencyStates, REPO_PATTERN } from './state.js';

const PR_FIELDS = `number title url body state isDraft baseRefName headRefName headRefOid
  headRepository { nameWithOwner } reviewDecision mergeable mergeStateStatus
  mergeCommit { oid } mergeQueueEntry { position state }
  commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }`;

function failure(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

export async function graphql(token, query, variables, api = 'https://api.github.com', missingPRs = false) {
  const response = await fetch(`${api}/graphql`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'User-Agent': 'repo-state', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw failure(response.status === 401 ? 'GitHub authentication failed.' : 'GitHub is unavailable or refused this request.',
    response.status === 401 ? 401 : response.status === 403 ? 403 : 502);
  const result = await response.json();
  if (result.errors?.some(error => !(missingPRs && error.type === 'NOT_FOUND'
    && error.path?.length === 2 && error.path[0] === 'repository' && /^p\d+$/.test(error.path[1])))) {
    throw failure('GitHub could not verify the requested state.');
  }
  return result.data;
}

export async function authorize(token, slug, api) {
  if (!REPO_PATTERN.test(slug)) throw failure('Invalid repository.', 400);
  const [owner, name] = slug.split('/');
  const data = await graphql(token, `query($owner:String!,$name:String!) {
    viewer { id login }
    repository(owner:$owner,name:$name) { id nameWithOwner isPrivate viewerPermission }
  }`, { owner, name }, api);
  const repo = data.repository;
  if (!repo) throw failure('Repository access denied.', 403);
  if (typeof data.viewer?.id !== 'string' || !data.viewer.id) throw failure('An authenticated GitHub account is required.', 403);
  // Public visibility is not team membership. Private READ is authenticated repository access.
  const allowed = ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE'].includes(repo.viewerPermission)
    || (repo.isPrivate && repo.viewerPermission === 'READ');
  if (!allowed) throw failure('Shared state requires contributor access; public visibility alone is insufficient.', 403);
  return { userId: data.viewer.id, login: data.viewer.login, slug: repo.nameWithOwner, repoId: repo.id };
}

function normalizePR(pr) {
  const commit = pr.commits?.nodes?.at(-1)?.commit;
  return {
    number: pr.number, title: pr.title, url: pr.url, state: pr.state, draft: pr.isDraft,
    baseBranch: pr.baseRefName, headBranch: pr.headRefName, headRepo: pr.headRepository?.nameWithOwner ?? null,
    headSha: pr.headRefOid, review: pr.reviewDecision ?? null, mergeable: pr.mergeable,
    mergeState: pr.mergeStateStatus, mergeSha: pr.mergeCommit?.oid ?? null,
    queue: pr.mergeQueueEntry ?? null,
    ci: commit?.statusCheckRollup ? { sha: commit.oid, state: commit.statusCheckRollup.state } : null,
    dependencies: dependencies(pr.body),
  };
}

export async function readRepository(token, slug, workspaces = [], previous = null, api) {
  const [owner, name] = slug.split('/');
  const prs = [];
  let cursor = null, metadata;
  do {
    const data = await graphql(token, `query($owner:String!,$name:String!,$cursor:String) {
      repository(owner:$owner,name:$name) {
        id nameWithOwner defaultBranchRef { name target { oid } }
        pullRequests(first:50,states:OPEN,after:$cursor) {
          nodes { ${PR_FIELDS} } pageInfo { endCursor hasNextPage }
        }
      }
    }`, { owner, name, cursor }, api);
    if (!data.repository) throw failure('Repository state unavailable.');
    metadata = data.repository;
    prs.push(...metadata.pullRequests.nodes.map(normalizePR));
    cursor = metadata.pullRequests.pageInfo.hasNextPage ? metadata.pullRequests.pageInfo.endCursor : null;
  } while (cursor);
  const observedAt = Date.now();
  const wanted = new Set(prs.flatMap(pr => pr.dependencies.filter(dep => dep.kind === 'local').map(dep => dep.number)));
  for (const workspace of workspaces) for (const number of workspace.prNumbers ?? []) wanted.add(number);
  const known = new Set(prs.map(pr => pr.number));
  const prerequisites = [];
  const queried = new Set();
  while ([...wanted].some(number => !known.has(number) && !queried.has(number))) {
    const batch = [...wanted].filter(number => !known.has(number) && !queried.has(number)).slice(0, 50);
    for (const number of batch) queried.add(number);
    const fields = batch.map((number, index) => `p${index}:pullRequest(number:${number}) { ${PR_FIELDS} }`).join('\n');
    const data = await graphql(token, `query($owner:String!,$name:String!) {
      repository(owner:$owner,name:$name) { ${fields} }
    }`, { owner, name }, api, true);
    for (const pr of Object.values(data.repository ?? {})) {
      if (!pr) continue;
      const normalized = normalizePR(pr);
      prerequisites.push(normalized);
      for (const dep of normalized.dependencies) if (dep.kind === 'local') wanted.add(dep.number);
    }
  }
  const requests = new Map();
  const addRef = (repo, branch) => {
    if (repo && branch) requests.set(`${repo.toLowerCase()}:${branch}`, { repo, branch });
  };
  addRef(slug, metadata.defaultBranchRef?.name);
  for (const pr of [...prs, ...prerequisites]) {
    addRef(slug, pr.baseBranch);
    addRef(pr.headRepo, pr.headBranch);
  }
  for (const workspace of workspaces) addRef(workspace.git.published.repo, workspace.git.published.branch);
  const refs = {};
  const entries = [...requests.entries()];
  for (let offset = 0; offset < entries.length; offset += 30) {
    const batch = entries.slice(offset, offset + 30);
    const variables = {}, declarations = [], fields = [];
    batch.forEach(([, ref], index) => {
      const [refOwner, refName] = ref.repo.split('/');
      variables[`o${index}`] = refOwner; variables[`n${index}`] = refName;
      variables[`r${index}`] = `refs/heads/${ref.branch}`;
      declarations.push(`$o${index}:String!,$n${index}:String!,$r${index}:String!`);
      fields.push(`r${index}:repository(owner:$o${index},name:$n${index}) {
        ref(qualifiedName:$r${index}) { target { oid } }
      }`);
    });
    try {
      const data = await graphql(token, `query(${declarations.join(',')}) { ${fields.join('\n')} }`, variables, api);
      batch.forEach(([key], index) => {
        const repo = data[`r${index}`];
        refs[key] = repo ? { sha: repo.ref?.target?.oid ?? null, exists: Boolean(repo.ref), observedAt: Date.now() }
          : { sha: null, exists: null, observedAt: null };
      });
    } catch {
      for (const [key] of batch) refs[key] = previous?.refs?.[key] ?? { sha: null, exists: null, observedAt: null };
    }
  }
  return {
    id: metadata.id, slug: metadata.nameWithOwner, defaultBranch: metadata.defaultBranchRef?.name ?? null,
    prs: dependencyStates(prs, prerequisites), linkedPRs: dependencyStates(prerequisites, prs),
    refs, observedAt, error: null,
  };
}
