import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { randomUUID, createHmac } from 'node:crypto';
import { createService } from '../lib/service.mjs';
import { GITHUB_STALE_MS } from '../lib/state.js';

const token = 'test_token_' + 'a'.repeat(30);
const peerToken = 'peer_token_' + 'c'.repeat(30);
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; };
const close = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
function sample(sequence = 1) {
  const ref = { repo: 'team/repo', branch: 'main', sha: 'a'.repeat(40), observedAt: Date.now(), exists: true };
  return { sequence, ageMs: 0, caption: 'Auth API', agentState: 'ready', prNumbers: [], git: {
    branch: 'feature', head: 'b'.repeat(40), shallow: false, staged: [], unstaged: ['auth.ts'], untracked: [], conflicted: [],
    files: [{ path: 'auth.ts', status: 'M', added: 1, removed: 0, lines: [[3, 3]] }], filesBase: 'a'.repeat(40),
    published: { ...ref, branch: 'feature' }, target: ref,
    publishedComparison: { ahead: 1, behind: 0, contains: true }, targetComparison: { ahead: 1, behind: 0, contains: true },
    upstreamConfigured: true,
  } };
}

test('authenticated HTTP state honors ordering, stale/expiry, checkout-wide stop, privacy, and signed refresh', async () => {
  let time = Date.now(), permission = 'WRITE', sourceFailure = false, referenceFailure = false, remoteSha = 'a'.repeat(40);
  const provider = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const { query } = JSON.parse(body);
    res.setHeader('Content-Type', 'application/json');
    if (query.includes('viewer {')) {
      const login = req.headers.authorization === `Bearer ${peerToken}` ? 'bob' : 'alice';
      return res.end(JSON.stringify({ data: { viewer: { id: `account-${login}`, login }, repository: { id: 'repo1', nameWithOwner: 'team/repo', isPrivate: false, viewerPermission: permission } } }));
    }
    if (sourceFailure || (referenceFailure && query.includes('qualifiedName'))) { res.statusCode = 503; return res.end('{}'); }
    if (query.includes('pullRequests')) return res.end(JSON.stringify({ data: { repository: {
      id: 'repo1', nameWithOwner: 'team/repo', defaultBranchRef: { name: 'main', target: { oid: remoteSha } },
      pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    } } }));
    res.end(JSON.stringify({ data: { r0: { ref: { target: { oid: remoteSha } } }, r1: { ref: { target: { oid: remoteSha } } } } }));
  });
  const api = await listen(provider);
  const server = createService({ githubApi: api, now: () => time, webhookSecret: 'test-secret' });
  const base = await listen(server);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const root = `${base}/api/repos/team/repo`;
  const workspaceId = randomUUID(), sessionId = randomUUID();
  const path = `${root}/workspaces/${workspaceId}/sessions/${sessionId}`;
  const send = (payload, url = path) => fetch(url, { method: 'PUT', headers, body: JSON.stringify(payload) });
  const state = async (method = 'GET') => (await fetch(`${root}/${method === 'POST' ? 'refresh' : 'state'}`, { method, headers })).json();
  try {
    assert.equal((await fetch(`${root}/state`)).status, 401);
    permission = 'READ'; assert.equal((await fetch(`${root}/state`, { headers })).status, 403);
    permission = 'WRITE';
    assert.equal((await send(sample())).status, 200);
    let view = await state();
    assert.equal(view.workspaces[0].owner, 'alice');
    assert.equal(view.workspaces[0].stale, false);

    const peerHeaders = { ...headers, Authorization: `Bearer ${peerToken}` };
    const peerSample = sample(99); peerSample.git.head = 'c'.repeat(40);
    assert.equal((await fetch(path, { method: 'PUT', headers: peerHeaders, body: JSON.stringify(peerSample) })).status, 200);
    assert.equal((await state()).workspaces.find(row => row.owner === 'alice').git.head, 'b'.repeat(40));
    assert.equal((await fetch(path, { method: 'PUT', headers: peerHeaders, body: JSON.stringify({ ...peerSample, owner: 'alice' }) })).status, 400);
    assert.equal((await fetch(path, { method: 'DELETE', headers: peerHeaders })).status, 200);
    assert.equal((await state()).workspaces[0].owner, 'alice');
    assert.equal((await send({ ...sample(2), transcript: 'must never be accepted' })).status, 400);
    assert.equal((await send({ ...sample(2), ageMs: 15_001 })).status, 400);
    assert.equal((await send(sample())).status, 409);
    const sibling = `${root}/workspaces/${workspaceId}/sessions/${randomUUID()}`;
    assert.equal((await send(sample(), sibling)).status, 200);
    view = await state(); assert.equal(view.workspaces.length, 1); assert.equal(view.workspaces[0].sessions.length, 2);

    // New remote revisions invalidate counts and diffs computed against old revisions.
    remoteSha = 'c'.repeat(40);
    view = await state('POST');
    assert.equal(view.workspaces[0].git.publishedComparison, null);
    assert.equal(view.workspaces[0].git.targetComparison, null);
    assert.equal(view.workspaces[0].git.filesBase, null);
    remoteSha = 'a'.repeat(40);
    view = await state('POST');
    assert.equal(view.workspaces[0].git.targetComparison.ahead, 1);

    // Hold an older request body while a newer observation completes.
    const payload = JSON.stringify(sample(2));
    const started = once(server, 'request');
    const slow = httpRequest(path, { method: 'PUT', headers });
    const slowResponse = new Promise(resolve => slow.on('response', response => { response.resume(); resolve(response.statusCode); }));
    slow.write(payload.slice(0, 20));
    await started; await state();
    assert.equal((await send(sample(3))).status, 200);
    slow.end(payload.slice(20));
    assert.equal(await slowResponse, 409);
    assert.equal((await state()).workspaces[0].stale, false);

    // A slow body must not make an old observation look freshly sampled.
    const latePayload = JSON.stringify(sample(4));
    const lateStarted = once(server, 'request');
    const late = httpRequest(path, { method: 'PUT', headers });
    const lateResponse = new Promise(resolve => late.on('response', response => { response.resume(); resolve(response.statusCode); }));
    late.write(latePayload.slice(0, 20));
    await lateStarted; await state();
    time += 15_001;
    late.end(latePayload.slice(20));
    assert.equal(await lateResponse, 400);

    time += 45_001;
    view = await state(); assert.equal(view.workspaces[0].stale, true);
    assert.equal(view.overlaps.length, 0);
    sourceFailure = true;
    time = view.repository.observedAt + GITHUB_STALE_MS + 1;
    view = await state('POST'); assert.equal(view.repository.stale, true);
    assert.equal(view.repository.observedAt < time, true);
    sourceFailure = false;
    referenceFailure = true;
    const previousRef = view.repository.refs['team/repo:main'].observedAt;
    view = await state('POST');
    assert.equal(view.repository.refs['team/repo:main'].observedAt, previousRef);
    referenceFailure = false;

    const body = JSON.stringify({ repository: { full_name: 'team/repo' } });
    const signature = `sha256=${createHmac('sha256', 'test-secret').update(body).digest('hex')}`;
    assert.equal((await fetch(`${base}/webhook`, { method: 'POST', headers: { 'x-hub-signature-256': 'sha256=wrong' }, body })).status, 401);
    remoteSha = 'c'.repeat(40);
    assert.equal((await fetch(`${base}/webhook`, { method: 'POST', headers: { 'x-hub-signature-256': signature }, body })).status, 202);
    view = await state();
    assert.equal(view.repository.refs['team/repo:main'].sha, remoteSha);
    permission = 'READ'; time += 30_001;
    assert.equal((await fetch(`${root}/state`, { headers })).status, 403);
    permission = 'WRITE';
    assert.equal((await fetch(`${root}/workspaces/${workspaceId}`, { method: 'DELETE', headers })).status, 200);
    assert.equal((await state()).workspaces.length, 0);
    assert.equal((await send(sample(4))).status, 409);
    assert.equal((await send(sample(), `${root}/workspaces/${workspaceId}/sessions/${randomUUID()}`)).status, 409);
    const freshWorkspace = `${root}/workspaces/${randomUUID()}/sessions/${randomUUID()}`;
    assert.equal((await send(sample(), freshWorkspace)).status, 200);
    time += 300_001;
    assert.equal((await state()).workspaces.length, 0);
  } finally { await close(server); await close(provider); }
});

test('account rename and login reuse cannot transfer snapshot ownership or checkout stop authority', async () => {
  let time = Date.now(), renamed = false;
  const provider = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const { query } = JSON.parse(body);
    res.setHeader('Content-Type', 'application/json');
    if (query.includes('viewer {')) {
      const peer = req.headers.authorization === `Bearer ${peerToken}`;
      const viewer = { id: peer ? 'account-two' : 'account-one',
        login: peer ? 'alice' : renamed ? 'alice-renamed' : 'alice' };
      return res.end(JSON.stringify({ data: { viewer, repository: { id: 'repo1',
        nameWithOwner: 'team/repo', isPrivate: false, viewerPermission: 'WRITE' } } }));
    }
    if (query.includes('pullRequests')) return res.end(JSON.stringify({ data: { repository: {
      id: 'repo1', nameWithOwner: 'team/repo', defaultBranchRef: { name: 'main', target: { oid: 'a'.repeat(40) } },
      pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    } } }));
    res.end(JSON.stringify({ data: { r0: { ref: { target: { oid: 'a'.repeat(40) } } },
      r1: { ref: { target: { oid: 'a'.repeat(40) } } } } }));
  });
  const api = await listen(provider), server = createService({ githubApi: api, now: () => time });
  const root = `${await listen(server)}/api/repos/team/repo`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const peerHeaders = { ...headers, Authorization: `Bearer ${peerToken}` };
  const checkout = `${root}/workspaces/${randomUUID()}`, path = `${checkout}/sessions/${randomUUID()}`;
  const state = async () => (await fetch(`${root}/state`, { headers })).json();
  try {
    assert.equal((await fetch(path, { method: 'PUT', headers, body: JSON.stringify(sample()) })).status, 200);
    renamed = true; time += 30_001;
    const other = sample(99); other.git.head = 'c'.repeat(40);
    assert.equal((await fetch(path, { method: 'PUT', headers: peerHeaders, body: JSON.stringify(other) })).status, 200);
    assert.deepEqual((await state()).workspaces.map(row => row.git.head).sort(), ['b'.repeat(40), 'c'.repeat(40)]);
    assert.equal((await fetch(checkout, { method: 'DELETE', headers })).status, 200);
    assert.deepEqual((await state()).workspaces.map(row => row.git.head), ['c'.repeat(40)]);
  } finally { await close(server); await close(provider); }
});
