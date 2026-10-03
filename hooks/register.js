import { collectGit, githubSlug, matchingPRs } from '../lib/git.js';
import { STALE_MS, GITHUB_STALE_MS, REPO_PATTERN, safeText, ageText, checkedCI } from '../lib/state.js';

const PANE = 'repo-state';
let config = null, storeKey = null, root = null, publication = null, view = null;
let sessionId = crypto.randomUUID(), sequence = 0, busy = false, technicalState = 'unknown';
let token = null, tokenAt = 0, error = '', tab = 'workspaces', selected = null, page = 0, filePage = 0;
let readAt = 0, sentAt = 0, sentState = '', prBranch = null, knownPRs = [];

function serverURL(value) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password
    || url.search || url.hash || url.pathname !== '/') throw new Error('Use a trusted HTTPS server, or HTTP on loopback only.');
  return url.origin;
}
async function loadScope($) {
  const cwd = await $.session.cwd();
  const result = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 });
  if (result.exitCode !== 0) { config = null; return null; }
  const currentRoot = result.stdout.trim();
  if (currentRoot !== root) {
    root = currentRoot;
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(root)));
    storeKey = `checkout:${[...hash].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  config = await $.store.get(storeKey) ?? null;
  return cwd;
}
async function credential($) {
  if (token && performance.now() - tokenAt < 60_000) return token;
  token = await $.env.get('REPO_STATE_TOKEN');
  if (!token) {
    const result = await $.process.run(['gh', 'auth', 'token'], { timeoutMs: 5000 });
    if (result.exitCode !== 0) throw new Error('Authenticate GitHub CLI, or provide a narrowly scoped REPO_STATE_TOKEN.');
    token = result.stdout.trim();
  }
  if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) throw new Error('Invalid GitHub credential.');
  tokenAt = performance.now();
  return token;
}
async function request($, cfg, path, method = 'GET', body = null) {
  const auth = await credential($);
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = $.clock.after(15_000, () => reject(new Error('State service timed out; previous data is not fresh.')));
  });
  let response;
  try {
    response = await Promise.race([$.http.fetch(`${serverURL(cfg.server)}/api/repos/${cfg.repo}/${path}`, {
      method, headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
    }), deadline]);
  } finally { timer.cancel(); }
  if (!response.ok) {
    if (response.status === 401) { token = null; tokenAt = 0; }
    let message = 'State service unavailable; previous data is not fresh.';
    try { message = JSON.parse(response.text).error ?? message; } catch { /* Keep the safe error. */ }
    throw new Error(message);
  }
  return JSON.parse(response.text);
}
async function removePublication($) {
  const old = publication;
  publication = null; sentState = ''; sentAt = 0; sequence = 0; sessionId = crypto.randomUUID();
  if (old) {
    try { await request($, old, `workspaces/${old.workspaceId}/sessions/${old.sessionId}`, 'DELETE'); }
    catch { /* A disconnected publication expires on the service, never blocks work. */ }
  }
}
function schedule($) {
  $.clock.after(0, () => { void tick($); });
}
async function tick($, force = false) {
  $.ui.invalidate('ui.render');
  if (busy) return;
  busy = true;
  try {
    const cwd = await loadScope($);
    if (!cwd || !config) { await removePublication($); return; }
    if (publication && (!config.enabled || publication.workspaceId !== config.workspaceId
      || publication.server !== config.server || publication.repo !== config.repo)) await removePublication($);
    if (view && view.repository.slug.toLowerCase() !== config.repo.toLowerCase()) view = null;
    if (config.enabled) {
      await credential($);
      const started = performance.now();
      const repository = view ? { ...view.repository, serverNow: view.serverNow + performance.now() - readAt } : null;
      const sample = await collectGit(args => $.process.run(args, { timeoutMs: 5000 }), cwd, repository, config.repo);
      const branchKey = `${sample.git.published.repo}:${sample.git.published.branch}`;
      if (branchKey !== prBranch) { prBranch = branchKey; knownPRs = []; }
      const matches = matchingPRs({ prs: [...(view?.repository.prs ?? []), ...(view?.repository.linkedPRs ?? [])] },
        sample.git.published.repo, sample.git.published.branch);
      knownPRs = [...new Set([...knownPRs, ...matches.map(pr => pr.number)])];
      const caption = config.captionBranch === sample.git.branch ? config.caption : '';
      const state = { caption, agentState: technicalState, git: sample.git, prNumbers: knownPRs };
      const signature = JSON.stringify(state);
      if (force || signature !== sentState || performance.now() - sentAt >= 15_000) {
        // Recheck consent after observation, before sending any workspace metadata.
        const latest = await $.store.get(storeKey);
        if (!latest?.enabled || latest.workspaceId !== config.workspaceId) { await removePublication($); return; }
        await request($, config, `workspaces/${config.workspaceId}/sessions/${sessionId}`, 'PUT', {
          ...state, sequence: ++sequence, ageMs: performance.now() - started,
        });
        publication = { ...config, sessionId };
        sentState = signature; sentAt = performance.now();
      }
    }
    view = await request($, config, force ? 'refresh' : 'state', force ? 'POST' : 'GET');
    readAt = performance.now(); error = '';
  } catch (failure) { error = failure.message; }
  finally { busy = false; $.ui.invalidate('ui.render'); }
}
async function connect($, args) {
  const cwd = await loadScope($);
  if (!cwd) throw new Error('Open a Git checkout first.');
  const words = args.trim().split(/\s+/);
  const server = serverURL(words[0]);
  let repo = words[1];
  if (!repo) {
    const origin = await $.process.run(['git', '-C', cwd, 'config', '--get', 'remote.origin.url']);
    repo = githubSlug(origin.stdout);
  }
  if (!repo || !REPO_PATTERN.test(repo)) throw new Error('Use /repo-state connect <server> <owner/repo>.');
  const answer = await $.ui.ask(
    `The server receives your GitHub token to verify repository access. Use a trusted server and preferably a narrowly scoped token. No prompts, history, source contents, or human activity are shared. Share current Git metadata for ${safeText(repo)} with ${safeText(server)}?`,
    ['Share metadata', 'Cancel']);
  if (answer !== 'Share metadata') return;
  const nextConfig = { server, repo, workspaceId: config?.enabled ? config.workspaceId : crypto.randomUUID(),
    enabled: true, caption: '', captionBranch: null };
  const initial = await request($, nextConfig, 'state');
  await removePublication($);
  await $.store.set(storeKey, nextConfig);
  config = nextConfig; view = initial; readAt = performance.now(); error = '';
  await tick($, true);
}
async function stopSharing($) {
  await loadScope($);
  if (!config) return;
  config = { ...config, enabled: false, caption: '', captionBranch: null };
  await $.store.set(storeKey, config);
  try { await request($, config, `workspaces/${config.workspaceId}`, 'DELETE'); }
  catch { error = 'Sharing stopped locally; disconnected server entries expire within five minutes.'; }
  await removePublication($);
  await tick($);
}
async function setCaption($, value) {
  await loadScope($);
  if (!config?.enabled) throw new Error('Enable sharing before setting a work caption.');
  if (value.length > 140 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Caption must be one line, at most 140 characters.');
  const branch = await $.process.run(['git', '-C', root, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
  config = { ...config, caption: value, captionBranch: branch.exitCode === 0 ? branch.stdout.trim() : null };
  await $.store.set(storeKey, config);
  await tick($, true);
}
function revisionLabel(label, ref, comparison) {
  if (ref.observedAt === null) return `${label} ${ref.branch ?? 'unknown'} @ unknown: GitHub reference unknown`;
  if (ref.stale) return `${label} ${ref.branch ?? 'unknown'} @ ${ref.sha?.slice(0, 7) ?? 'unknown'} (cached · STALE): comparison unknown`;
  const sha = ref.sha?.slice(0, 7) ?? 'unknown';
  const relation = comparison ? comparison.behind ? `missing ${comparison.behind} commits; ${comparison.ahead} ahead`
    : comparison.ahead ? `includes revision; ${comparison.ahead} ahead` : 'matches revision'
    : ref.exists === false ? 'branch not published' : 'comparison unknown; fetch may be needed';
  return `${label} ${ref.branch ?? 'unknown'} @ ${sha}: ${relation}`;
}
function prLines(pr, git) {
  const ci = checkedCI(pr, git);
  const ciLabel = ci ? `published ${ci.sha}: ${ci.state.toLowerCase()}${ci.localChecked === false ? '; local changes not checked' : ''}` : 'checks unknown';
  return [
    `#${pr.number} ${pr.title} · ${pr.draft ? 'draft' : pr.state.toLowerCase()} · ${pr.baseBranch}`,
    `PR revision: ${pr.headSha ?? 'unknown'}`,
    `Review: ${pr.review?.toLowerCase() ?? 'unknown'} · ${ciLabel}`,
    `Queue: ${pr.queue ? `position ${pr.queue.position} · ${pr.queue.state.toLowerCase()}` : 'not queued'}`,
    ...pr.dependencies.map(dep => `Depends on ${dep.ref}: ${dep.status}${dep.baseBranch ? ` into ${dep.baseBranch}` : ''}`),
    ...(pr.cycle ? ['Dependency cycle: no valid declared merge order.'] : []),
  ];
}

/** @type {import('claude-code').Register} */
export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'repo-state', description: 'Live shared Git and PR state, not a tracker',
      argumentHint: '[connect <server> [owner/repo] | caption <text> | refresh | stop]', immediate: true });
    $.clock.every(5000, () => { void tick($); });
    schedule($);
    return next(e);
  });
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    technicalState = 'unknown'; schedule($); return next(e);
  });
  on('session.end', async ($, e, next) => {
    technicalState = 'unknown'; await removePublication($); return next(e);
  });
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) { technicalState = 'running'; schedule($); }
    return yield* next(e);
  });
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) { technicalState = 'ready'; schedule($); }
    return next(e);
  });
  on('classic.PermissionRequest', async ($, e, next) => {
    technicalState = 'awaiting-permission'; schedule($); return next(e);
  });
  on('tool.call', async ($, e, next) => {
    const previous = technicalState;
    try { return await next(e); }
    finally {
      if (technicalState === 'awaiting-permission') technicalState = previous;
      schedule($);
    }
  });
  on('command.run', { command: 'repo-state' }, async ($, e) => {
    try {
      const args = e.args?.trim() ?? '';
      if (args.startsWith('connect ')) await connect($, args.slice(8));
      else if (args === 'stop') await stopSharing($);
      else if (args === 'refresh') await tick($, true);
      else if (args === 'caption' || args.startsWith('caption ')) await setCaption($, args.slice(7));
      else if (args) return { text: 'Use /repo-state [connect <server> [owner/repo] | caption <text> | refresh | stop].' };
      else await tick($);
      if (!(await $.session.surfaces()).includes('terminal')) {
        return { text: JSON.stringify({ sharing: Boolean(config?.enabled), error, state: view }, null, 2) };
      }
      await $.ui.open({ id: PANE, title: 'Repo State', focus: true, closeOnEscape: true });
      return {};
    } catch (failure) { return { text: safeText(failure.message) }; }
  });
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const { Box, Text, Button, Input, Link } = $.ui.resolve(e);
    const line = value => Text({ children: [safeText(value)], wrap: 'wrap' });
    const redraw = () => $.ui.invalidate('ui.render');
    const button = (key, label, action, hotkey) => Button({ key, label, onPress: action, ...(hotkey ? { hotkey } : {}) });
    const serverNow = view ? view.serverNow + performance.now() - readAt : 0;
    const repoAge = view?.repository.observedAt ? serverNow - view.repository.observedAt : null;
    const allPRs = [...(view?.repository.prs ?? []), ...(view?.repository.linkedPRs ?? [])];
    const rows = view?.workspaces ?? [];
    const body = [
      line(config?.repo ?? 'No shared repository connected'),
      line(`Sharing ${config?.enabled ? 'enabled' : 'disabled'} · connected workspaces, not team attendance`),
      ...(error ? [line(`Cached/unknown: ${error}`)] : []),
      ...(view ? [line(`GitHub ${repoAge === null ? 'unknown' : `${ageText(repoAge)} ago`}${repoAge === null || repoAge >= GITHUB_STALE_MS ? ' · STALE' : ''}`),
        ...(view.repository.error ? [line(view.repository.error)] : [])] : []),
    ];
    if (!config) {
      body.push(line('Connect explicitly: /repo-state connect <trusted HTTPS server> <owner/repo>'));
      return Box({ flexDirection: 'column', children: body });
    }
    body.push(Box({ flexDirection: 'row', gap: 1, children: [
      button('workspaces', 'Workspaces', () => { tab = 'workspaces'; page = 0; redraw(); }, 'w'),
      button('prs', 'PRs', () => { tab = 'prs'; page = 0; redraw(); }, 'p'),
      button('refresh', 'Refresh', () => { void tick($, true); }, 'r'),
      ...(config.enabled ? [button('stop', 'Stop sharing', () => { void stopSharing($); }, 's')] : []),
    ] }));
    const items = tab === 'workspaces' ? rows : view?.repository.prs ?? [];
    const currentPage = Math.min(page, Math.max(0, Math.ceil(items.length / 20) - 1));
    const visible = items.slice(currentPage * 20, currentPage * 20 + 20);
    if (!visible.length) body.push(line(tab === 'workspaces' ? 'No currently shared workspaces.'
      : repoAge === null || repoAge >= GITHUB_STALE_MS ? 'Open PRs unknown; no fresh GitHub data.' : 'No open PRs.'));
    for (const item of visible) {
      if (tab === 'prs') {
        body.push(...prLines(item, null).map(line));
        body.push(Link({ href: `https://github.com/${config.repo}/pull/${item.number}`, label: 'Open PR' }));
        if (!rows.some(row => row.prNumbers.includes(item.number))) body.push(line('No connected workspace reporting this PR.'));
      } else {
        const age = serverNow - item.observedAt;
        const related = allPRs.filter(pr => item.prNumbers.includes(pr.number));
        body.push(button(`workspace-${item.id}`, `${item.owner} · ${item.caption || related[0]?.title || item.git.branch || 'Detached HEAD'}`,
          () => { selected = selected === item.id ? null : item.id; filePage = 0; redraw(); }));
        body.push(line(`${item.git.branch ?? 'detached'} @ ${item.git.head?.slice(0, 7) ?? 'unborn'} · ${ageText(age)} ago${age >= STALE_MS ? ' · STALE' : ''}`));
        body.push(line(`${item.git.staged.length} staged · ${item.git.unstaged.length} unstaged · ${item.git.untracked.length} untracked · ${item.git.conflicted.length} unresolved`));
        body.push(line(`Claude: ${item.sessions.map(session => session.stale || age >= STALE_MS ? 'unknown/stale' : session.state).join(', ')}`));
        if (item.sessions.length > 1) body.push(line('Multiple Claude sessions share this checkout.'));
        if (item.disagree) body.push(line('Sessions disagree about checkout revision; awaiting a fresh observation.'));
        const currentRef = name => {
          const ref = item.git[name];
          const current = view.repository.refs[`${ref.repo?.toLowerCase()}:${ref.branch}`]
            ?? { sha: null, exists: null, observedAt: null };
          return { ...ref, ...current, stale: current.observedAt !== null && serverNow - current.observedAt >= GITHUB_STALE_MS };
        };
        body.push(line(revisionLabel('Published', currentRef('published'), item.git.publishedComparison)));
        body.push(line(revisionLabel('Target', currentRef('target'), item.git.targetComparison)));
        for (const pr of related) {
          body.push(...prLines(pr, item.git).map(line));
          body.push(Link({ href: `https://github.com/${config.repo}/pull/${pr.number}`, label: 'Open PR' }));
        }
        if (selected === item.id) {
          body.push(line(`Local HEAD: ${item.git.head ?? 'unborn'}`));
          body.push(line(`Published SHA: ${currentRef('published').sha ?? 'unknown'}${currentRef('published').stale ? ' (cached · STALE)' : ''}`));
          body.push(line(`Target SHA: ${currentRef('target').sha ?? 'unknown'}${currentRef('target').stale ? ' (cached · STALE)' : ''}`));
          const files = ['staged', 'unstaged', 'untracked', 'conflicted', 'branchFiles'].flatMap(kind =>
            (item.git[kind] ?? []).map(path => `${kind}: ${path}`));
          if (item.git.branchFiles === null) body.push(line('Branch changed paths unknown until target history is available.'));
          body.push(...files.slice(filePage * 100, filePage * 100 + 100).map(line));
          if (files.length > 100) body.push(Box({ flexDirection: 'row', children: [
            line(`Paths ${filePage * 100 + 1}–${Math.min(files.length, (filePage + 1) * 100)} of ${files.length}`),
            ...(filePage ? [button('paths-back', 'Previous paths', () => { filePage--; redraw(); })] : []),
            ...((filePage + 1) * 100 < files.length ? [button('paths-next', 'Next paths', () => { filePage++; redraw(); })] : []),
          ] }));
        }
      }
      body.push(line(' '));
    }
    if (items.length > 20) body.push(Box({ flexDirection: 'row', children: [
      line(`Page ${currentPage + 1} of ${Math.ceil(items.length / 20)}`),
      ...(currentPage ? [button('previous', 'Previous', () => { page = currentPage - 1; redraw(); })] : []),
      ...((currentPage + 1) * 20 < items.length ? [button('next', 'Next', () => { page = currentPage + 1; redraw(); })] : []),
    ] }));
    for (const notice of view?.overlaps ?? []) {
      const a = rows.find(row => row.id === notice.a), b = rows.find(row => row.id === notice.b);
      if (a && b && serverNow - a.observedAt < STALE_MS && serverNow - b.observedAt < STALE_MS) {
        body.push(line(`Shared paths (conflict not inferred): ${a.owner}/${a.git.branch} and ${b.owner}/${b.git.branch}: ${notice.paths.slice(0, 5).join(', ')}${notice.paths.length > 5 ? ` (+${notice.paths.length - 5} paths)` : ''}`));
      }
    }
    if (config.enabled) body.push(Input({ key: 'caption', label: 'Work caption', placeholder: 'Optional, branch-scoped; Enter saves',
      value: '', submitLabel: 'save', onSubmit: value => { void setCaption($, value).catch(failure => { error = failure.message; redraw(); }); } }));
    return Box({ flexDirection: 'column', children: body });
  });
}
