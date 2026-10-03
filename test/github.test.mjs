import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readRepository } from '../lib/github.mjs';

test('a missing declared prerequisite stays unknown without discarding valid open PRs', async () => {
  const provider = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const { query } = JSON.parse(body);
    res.setHeader('Content-Type', 'application/json');
    if (query.includes('pullRequests')) return res.end(JSON.stringify({ data: { repository: {
      id: 'repo', nameWithOwner: 'team/repo', defaultBranchRef: { name: 'main', target: { oid: 'a'.repeat(40) } },
      pullRequests: { nodes: [{ number: 1, title: 'Auth API', url: 'https://github.com/team/repo/pull/1', body: 'Depends-On: #999',
        state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: 'auth', headRefOid: 'b'.repeat(40),
        headRepository: { nameWithOwner: 'team/repo' }, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN', mergeCommit: null, mergeQueueEntry: null,
        commits: { nodes: [{ commit: { oid: 'b'.repeat(40), statusCheckRollup: { state: 'SUCCESS' } } }] },
      }], pageInfo: { hasNextPage: false, endCursor: null } },
    } } }));
    if (query.includes('pullRequest(number:999)')) return res.end(JSON.stringify({
      data: { repository: { p0: null } }, errors: [{ type: 'NOT_FOUND', path: ['repository', 'p0'] }],
    }));
    res.end(JSON.stringify({ data: { r0: { ref: { target: { oid: 'a'.repeat(40) } } }, r1: { ref: { target: { oid: 'b'.repeat(40) } } } } }));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  try {
    const state = await readRepository('test_token_' + 'a'.repeat(30), 'team/repo', [], null, `http://127.0.0.1:${provider.address().port}`);
    assert.equal(state.prs[0].number, 1);
    assert.equal(state.prs[0].dependencies[0].status, 'unknown');
  } finally { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
});
