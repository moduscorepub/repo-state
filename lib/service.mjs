import { createServer } from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { authorize, readRepository, filePatch } from './github.mjs';
import { STALE_MS, EXPIRE_MS, GITHUB_STALE_MS, REPO_PATTERN, overlaps } from './state.js';

const UUID = /^[a-f0-9-]{36}$/i;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const STATES = ['running', 'ready', 'unknown'];
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('Unexpected snapshot fields.');
}
function string(value, max, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail('Invalid snapshot string.');
}
function reference(ref) {
  object(ref, ['repo', 'branch', 'sha', 'observedAt', 'exists']);
  if (ref.repo !== null && (typeof ref.repo !== 'string' || !REPO_PATTERN.test(ref.repo))) fail('Invalid reference repository.');
  string(ref.branch, 1024, true);
  if (ref.sha !== null && !SHA.test(ref.sha)) fail('Invalid commit revision.');
  if (ref.observedAt !== null && (!Number.isFinite(ref.observedAt) || ref.observedAt < 0)) fail('Invalid reference observation.');
  if (![true, false, null].includes(ref.exists)) fail('Invalid reference existence.');
}
function comparison(value) {
  if (value === null) return;
  object(value, ['ahead', 'behind', 'contains']);
  if (![value.ahead, value.behind].every(n => Number.isSafeInteger(n) && n >= 0)
    || value.contains !== (value.behind === 0)) fail('Invalid revision comparison.');
}
function paths(value, nullable = false) {
  if (nullable && value === null) return;
  if (!Array.isArray(value) || value.length > 20_000) fail('Too many changed paths.');
  for (const path of value) {
    string(path, 4096);
    if (!path || path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.split('/').includes('..')) fail('Only repository-relative paths may be shared.');
  }
}
function changedFiles(value) {
  if (!Array.isArray(value) || value.length > 20_000) fail('Too many changed files.');
  for (const file of value) {
    object(file, ['path', 'status', 'added', 'removed', 'lines']);
    paths([file.path]);
    if (!['A', 'M', 'D', 'U', '?'].includes(file.status)) fail('Invalid file status.');
    if ([file.added, file.removed].some(count => count !== null && !(Number.isSafeInteger(count) && count >= 0))) fail('Invalid line counts.');
    if (file.lines !== null && (!Array.isArray(file.lines) || file.lines.length > 100 || file.lines.some(range => !Array.isArray(range)
      || range.length !== 2 || !range.every(Number.isSafeInteger) || range[0] < 1 || range[1] < range[0]))) fail('Invalid line ranges.');
  }
}
export function validateSnapshot(value) {
  object(value, ['sequence', 'ageMs', 'caption', 'agentState', 'git', 'prNumbers']);
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) fail('Invalid snapshot sequence.');
  if (!Number.isFinite(value.ageMs) || value.ageMs < 0 || value.ageMs > 15_000) fail('Observation is too old to publish.');
  string(value.caption, 140);
  if (!STATES.includes(value.agentState)) fail('Invalid technical agent state.');
  if (!Array.isArray(value.prNumbers) || value.prNumbers.length > 100
    || value.prNumbers.some(number => !Number.isSafeInteger(number) || number < 1)) fail('Invalid linked PRs.');
  const git = value.git;
  object(git, ['branch', 'head', 'shallow', 'staged', 'unstaged', 'untracked', 'conflicted', 'files', 'filesBase',
    'published', 'target', 'publishedComparison', 'targetComparison', 'upstreamConfigured']);
  string(git.branch, 1024, true);
  if (git.head !== null && !SHA.test(git.head)) fail('Invalid HEAD revision.');
  if (typeof git.shallow !== 'boolean' || typeof git.upstreamConfigured !== 'boolean') fail('Invalid Git flags.');
  for (const name of ['staged', 'unstaged', 'untracked', 'conflicted']) paths(git[name]);
  changedFiles(git.files);
  reference(git.published); reference(git.target);
  comparison(git.publishedComparison); comparison(git.targetComparison);
  if ((!git.head || git.shallow) && (git.publishedComparison || git.targetComparison)) fail('Unavailable history cannot have a comparison.');
  if (git.filesBase !== null && (git.filesBase !== git.target.sha || !git.targetComparison)) fail('Line ranges must use the compared target revision.');
  return value;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_048_576) fail('Request body too large.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function send(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

export function createService({ githubApi = 'https://api.github.com', webhookSecret = '', now = Date.now } = {}) {
  const snapshots = new Map(), repositories = new Map(), authCache = new Map(), stoppedWorkspaces = new Map();
  function sweep() {
    const time = now();
    for (const [key, entry] of snapshots) if (time - entry.receivedAt >= EXPIRE_MS) snapshots.delete(key);
    for (const [key, time] of stoppedWorkspaces) if (now() - time >= EXPIRE_MS) stoppedWorkspaces.delete(key);
    for (const [key, entry] of authCache) if (time >= entry.expiresAt) authCache.delete(key);
    for (const [key, entry] of repositories) if (!entry.pending && time - entry.accessedAt >= EXPIRE_MS) repositories.delete(key);
  }
  const cleanup = setInterval(sweep, 15_000);
  cleanup.unref();

  async function authenticate(request, slug) {
    const token = /^Bearer ([A-Za-z0-9_]{20,255})$/.exec(request.headers.authorization ?? '')?.[1];
    if (!token) fail('A GitHub bearer token is required.', 401);
    const key = createHash('sha256').update(`${token}\0${slug.toLowerCase()}`).digest('hex');
    const cached = authCache.get(key);
    if (cached && cached.expiresAt > now()) return { ...cached.actor, token };
    const actor = await authorize(token, slug, githubApi);
    authCache.set(key, { actor, expiresAt: now() + 30_000 });
    return { ...actor, token };
  }
  function repoEntry(actor) {
    let entry = repositories.get(actor.repoId);
    if (!entry) {
      entry = { slug: actor.slug, state: null, pending: null, dirty: true, attemptedAt: 0, accessedAt: now() };
      repositories.set(actor.repoId, entry);
    }
    entry.slug = actor.slug; entry.accessedAt = now();
    return entry;
  }
  function activeEntries(repoId) {
    return [...snapshots.values()].filter(entry => entry.repoId === repoId && entry.snapshot && !entry.closed);
  }
  async function refresh(actor, force = false) {
    const entry = repoEntry(actor);
    if (entry.pending) return entry.pending;
    if (!force && !entry.dirty && now() - entry.attemptedAt < 60_000) return entry.state;
    entry.dirty = false; entry.attemptedAt = now();
    entry.pending = (async () => {
      try {
        const state = await readRepository(actor.token, entry.slug,
          activeEntries(actor.repoId).map(item => item.snapshot), entry.state, githubApi);
        // Use the service clock so clients cannot refresh stale GitHub data with their clock.
        state.observedAt = now();
        entry.state = state;
      } catch {
        entry.state = { ...(entry.state ?? { slug: entry.slug, prs: [], linkedPRs: [], refs: {}, defaultBranch: null, observedAt: null }),
          error: 'GitHub refresh failed; existing data is not newly verified.' };
      } finally { entry.pending = null; }
      return entry.state;
    })();
    return entry.pending;
  }
  function workspaces(repoId, repository) {
    const groups = new Map();
    for (const entry of activeEntries(repoId)) {
      const key = `${entry.userId}:${entry.workspaceId}`;
      let group = groups.get(key);
      if (!group) { group = { latest: entry, entries: [] }; groups.set(key, group); }
      group.entries.push(entry);
      if (entry.observedAt > group.latest.observedAt) group.latest = entry;
    }
    return [...groups.entries()].map(([id, group]) => {
      const entry = group.latest;
      const git = { ...entry.snapshot.git };
      for (const name of ['published', 'target']) {
        const ref = git[name];
        const current = ref.repo && ref.branch ? repository.refs[`${ref.repo.toLowerCase()}:${ref.branch}`] : null;
        if (!current || current.sha !== ref.sha || now() - (current.observedAt ?? 0) > GITHUB_STALE_MS) {
          git[`${name}Comparison`] = null;
          if (name === 'target') git.filesBase = null;
        }
      }
      return {
        id, workspaceId: entry.workspaceId, owner: entry.login, caption: entry.snapshot.caption, git,
        observedAt: entry.observedAt, ageMs: Math.max(0, now() - entry.observedAt),
        stale: now() - entry.observedAt >= STALE_MS,
        sessions: group.entries.map(item => ({ id: item.sessionId, state: item.snapshot.agentState,
          stale: now() - item.observedAt >= STALE_MS })),
        disagree: new Set(group.entries.filter(item => now() - item.observedAt < STALE_MS)
          .map(item => `${item.snapshot.git.branch}\0${item.snapshot.git.head}`)).size > 1,
        prNumbers: entry.snapshot.prNumbers,
      };
    }).sort((a, b) => a.owner.localeCompare(b.owner) || a.id.localeCompare(b.id));
  }

  const server = createServer(async (request, response) => {
    const requestAt = now();
    try {
      sweep();
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { ok: true });
      if (request.method === 'POST' && url.pathname === '/webhook') {
        if (!webhookSecret) fail('Webhooks are not configured.', 503);
        const body = await readBody(request);
        const expected = Buffer.from(`sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`);
        const supplied = Buffer.from(request.headers['x-hub-signature-256'] ?? '');
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) fail('Invalid webhook signature.', 401);
        let event;
        try { event = JSON.parse(body); } catch { fail('Invalid webhook JSON.'); }
        const slug = event.repository?.full_name;
        if (typeof slug === 'string') for (const [repoId, entry] of repositories) {
          if (entry.slug.toLowerCase() === slug.toLowerCase()) {
            entry.dirty = true;
            for (const [key, cached] of authCache) if (cached.actor.repoId === repoId) authCache.delete(key);
          }
        }
        return send(response, 202, { accepted: true });
      }
      const route = /^\/api\/repos\/([^/]+)\/([^/]+)\/(state|refresh|diff|workspaces\/([^/]+)(?:\/sessions\/([^/]+))?)$/.exec(url.pathname);
      if (!route) fail('Not found.', 404);
      const slug = `${decodeURIComponent(route[1])}/${decodeURIComponent(route[2])}`;
      if (!REPO_PATTERN.test(slug)) fail('Invalid repository.');
      const actor = await authenticate(request, slug);
      const repo = repoEntry(actor);
      if ((route[3] === 'state' && request.method === 'GET') || (route[3] === 'refresh' && request.method === 'POST')) {
        const repository = await refresh(actor, route[3] === 'refresh');
        const rows = workspaces(actor.repoId, repository);
        return send(response, 200, {
          actor: actor.login, repository: { ...repository, stale: !repository.observedAt || now() - repository.observedAt >= GITHUB_STALE_MS },
          workspaces: rows, overlaps: overlaps(rows), serverNow: now(),
        });
      }
      if (route[3] === 'diff' && request.method === 'GET') {
        const path = url.searchParams.get('path') ?? '', pr = url.searchParams.get('pr');
        const base = url.searchParams.get('base'), head = url.searchParams.get('head');
        paths([path]);
        if (pr ? !/^[1-9]\d{0,9}$/.test(pr) : !(SHA.test(base ?? '') && SHA.test(head ?? ''))) fail('Choose a PR or two pushed revisions.');
        return send(response, 200, { patch: await filePatch(actor.token, actor.slug, path, pr && Number(pr), base, head, githubApi) });
      }
      if (!route[4] || !UUID.test(route[4])) fail('Invalid workspace identifier.');
      const workspaceKey = `${actor.repoId}:${actor.userId}:${route[4]}`;
      if (!route[5] && request.method === 'DELETE') {
        stoppedWorkspaces.set(workspaceKey, now());
        for (const entry of snapshots.values()) {
          if (entry.repoId === actor.repoId && entry.userId === actor.userId && entry.workspaceId === route[4]) {
            entry.snapshot = null; entry.closed = true; entry.receivedAt = now();
          }
        }
        return send(response, 200, { removed: true });
      }
      if (!UUID.test(route[5] ?? '')) fail('Invalid session identifier.');
      const key = `${workspaceKey}:${route[5]}`;
      if (request.method === 'DELETE') {
        const previous = snapshots.get(key);
        snapshots.set(key, { repoId: actor.repoId, userId: actor.userId, login: actor.login, workspaceId: route[4], sessionId: route[5],
          snapshot: null, closed: true, receivedAt: now(), sequence: previous?.sequence ?? 0 });
        return send(response, 200, { removed: true });
      }
      if (request.method !== 'PUT') fail('Method not allowed.', 405);
      if (stoppedWorkspaces.has(workspaceKey)) fail('Sharing stopped for this checkout. Reconnect explicitly.', 409);
      let snapshot;
      try { snapshot = JSON.parse(await readBody(request)); } catch (error) {
        if (error.status) throw error;
        fail('Invalid snapshot JSON.');
      }
      validateSnapshot(snapshot);
      if (now() - requestAt + snapshot.ageMs > 15_000) fail('Snapshot observation is too old.');
      // Commit-time checks: another request may finish while this body is arriving.
      if (stoppedWorkspaces.has(workspaceKey)) fail('Sharing stopped for this checkout. Reconnect explicitly.', 409);
      const previous = snapshots.get(key);
      if (previous?.closed) fail('This publication has stopped. Use a new session identifier.', 409);
      if (previous && snapshot.sequence <= previous.sequence) fail('Older snapshot rejected.', 409);
      if (!previous && snapshots.size >= 1000) fail('Service workspace capacity reached.', 503);
      const newRefs = !previous || previous.snapshot.git.published.repo !== snapshot.git.published.repo
        || previous.snapshot.git.published.branch !== snapshot.git.published.branch
        || JSON.stringify(previous.snapshot.prNumbers) !== JSON.stringify(snapshot.prNumbers);
      snapshots.set(key, { repoId: actor.repoId, userId: actor.userId, login: actor.login, workspaceId: route[4], sessionId: route[5],
        snapshot, sequence: snapshot.sequence, receivedAt: now(), observedAt: requestAt - snapshot.ageMs, closed: false });
      if (newRefs) repo.dirty = true;
      return send(response, 200, { accepted: true });
    } catch (error) {
      send(response, error.status ?? 500, { error: error.status ? error.message : 'Request failed without changing shared state.' });
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 15_000;
  server.on('close', () => clearInterval(cleanup));
  return server;
}
