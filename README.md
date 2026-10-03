# Repo State

Live, shared Git and GitHub state in Claude Code's native terminal pane. A dependency-free Node service holds only current workspace snapshots in memory.

**This is not a tracker.** There are no tickets, assignments, percentages, attendance, human activity measurements, histories, productivity metrics, or merge controls. A missing workspace means **not sharing**, never **not working**.

## What the pane shows

- Connected checkouts, optional branch-scoped work captions, and observed Claude technical states.
- Local `HEAD`, the published source branch tip, and the PR target tip separately; ahead/behind and containment only for the exact sampled revisions.
- Staged, unstaged, untracked, unresolved, and branch-changed repository-relative paths. Select a workspace for full SHAs and paths.
- Open and associated PRs, reviews, published-revision CI, GitHub merge-queue position/state, and explicit dependencies.
- Shared-path notices, **not predicted conflicts**, plus observation age, unknown state, and stale evidence.

The pane scrolls natively; Tab walks controls, arrows scroll, and Ctrl+X then Tab gives the pane keyboard focus. Focused pane hotkeys are `w` (workspaces), `p` (PRs), `r` (refresh), and `s` (stop sharing). Escape returns focus and closes the pane; it does not stop sharing.

## Requirements

- Node.js **24 or later** for the service and tests. No dependencies, `npm install`, or build step.
- Claude Code with native JavaScript plugins, `ui.render` panes, commands, clocks, HTTP/process APIs, and local plugin storage. **Verified with Claude Code 2.1.289**, not older plugin API shapes.
- Git supporting global `--no-lazy-fetch` and `--no-optional-locks`. **Verified with Git 2.54.0**; older releases are not claimed as supported. Check `git --no-lazy-fetch --no-optional-locks version` before connecting.
- An authenticated GitHub CLI (`gh auth login`) or `REPO_STATE_TOKEN` in Claude's environment.
- Contributor access to a public repository (`TRIAGE`, `WRITE`, `MAINTAIN`, or `ADMIN`), or authenticated `READ` access to a private repository.

## Install from a checkout

Register the local marketplace using the absolute path to this checkout:

```sh
claude plugin marketplace add /absolute/path/to/repo-state
claude plugin install repo-state@moduscorepub
claude plugin list
```

Restart Claude Code after installation. For a direct development launch without installing:

```sh
claude --permission-mode manual --plugin-dir /absolute/path/to/repo-state
```

Launch Claude **in the Git checkout you want to observe**, not necessarily in this implementation checkout. If inherited permission mode is `dontAsk`, the consent dialog is refused and sharing remains disabled. Use `--permission-mode manual` for explicit consent.

## Run the shared service

```sh
cd /absolute/path/to/repo-state
npm start
```

The default address is `127.0.0.1:4318`. `/health` is an unauthenticated liveness endpoint; workspace and repository endpoints always require GitHub authentication.

For a shared deployment, run a single process behind a trusted TLS reverse proxy:

```sh
HOST=127.0.0.1 PORT=4318 node server.mjs
```

Expose the proxy's **HTTPS origin**, preserving request methods, bodies, and the `Authorization` header. Keep the Node listener private. Do not log authorization headers or snapshot bodies at the proxy. The plugin accepts HTTPS origins or loopback HTTP only; credentials, query strings, fragments, and path prefixes in the origin are rejected. Loopback HTTP is for local testing, not transport to other machines.

The service is intentionally memory-only and single-process. Do not put independently running instances behind a load balancer: their snapshots would differ. Restarting loses the current snapshots; opted-in clients republish. Current capacity is 1,000 publication sessions including unexpired withdrawal tombstones. There is no database, broker, persistence, or historical API.

## Connect and use

In Claude Code:

```text
/repo-state connect http://127.0.0.1:4318 owner/repository
```

For teammates, replace the address with the same trusted HTTPS service origin. Omitting `owner/repository` uses a recognizable GitHub `origin`. The dialog explains what is shared and how authentication works; only **Share metadata** enables publication.

```text
/repo-state                    Open the pane
/repo-state caption Auth API   Save an optional caption for this branch
/repo-state caption            Clear the caption
/repo-state refresh            Force a local observation and GitHub refresh
/repo-state stop               Withdraw this checkout and disable publication
```

The pane's caption field saves on Enter and retains typing across redraws. Captions are one line, at most 140 characters. Switching branches hides the caption; returning to its branch restores it unless it was replaced or sharing was stopped. A PR title or branch is used when no caption applies.

Opt-in is stored locally per checkout. Multiple Claude sessions in the same checkout share consent and workspace identity, but publish separate session states. Stop disables the checkout locally and withdraws all its sessions. Delayed uploads and new-session uploads for that stopped workspace identity are rejected. Explicit reconnect creates a new workspace identity. If the service is disconnected during stop, its old entries expire within five minutes. Closing the pane is not withdrawal.

## Evidence and freshness

| Evidence | Behavior |
| --- | --- |
| Local Git | Sampled every 5 seconds, including changes made outside Claude |
| Publication | Changes plus heartbeats at least every 15 seconds while connected |
| Workspace freshness | Stale at 45 seconds; removed after 5 minutes without accepted publication |
| GitHub | Refreshed every 60 seconds, on explicit refresh, or after invalidation |
| GitHub evidence | Stale at 90 seconds; individual ref observations retain their own age |
| Upload age | Client collection age plus server-observed request delay must not exceed 15 seconds |
| Authorization cache | Token hashes and verified account/repository authorization expire after 30 seconds |

Failures leave cached data visibly unknown/stale rather than making it newly observed. Stale workspaces do not generate overlap notices. A newly observed remote SHA invalidates counts and changed branch paths computed against an older SHA. Shallow clones and missing history produce unknown comparisons; the user may fetch manually if desired.

**Git is read-only:** the collector disables lazy object fetching, optional index refresh writes, and configured filesystem-monitor execution. It never fetches, pulls, checks out, rebases, pushes, locks user files, blocks Claude tools, or manages merges.

**CI is revision-bound:** the pane names the exact published PR SHA attached to GitHub's check rollup. Checks for a different published head are unknown. Unpublished local commits and any staged, unstaged, untracked, or unresolved changes are explicitly not checked by those results. This is GitHub's published-head rollup, not a promise that a hypothetical merge result, unpublished commit, or dirty tree passed CI.

**Claude states are technical observations:** `running` means an observed main model request; `awaiting-permission` means a native permission request; `ready` follows a completed main turn; missing evidence is `unknown`. These are not measurements of a person's activity or idle time, and do not summarize every subagent independently.

## Explicit dependencies

Put a standalone declaration in the PR body:

```text
Depends-On: #42, #44
```

Only explicit same-repository PR numbers are resolved. Code-fenced examples and quoted prose are ignored. Empty or malformed declarations remain invalid, cross-repository declarations are unsupported, and missing PRs remain unknown. The pane distinguishes open, merged, closed-unmerged, self-dependencies, and cycles. It shows the prerequisite target branch so a merge elsewhere is not silently treated as target containment. There is no inferred dependency or automatic merge order, and no blocking or enforcement.

Overlap is an exact shared changed path, not line-level analysis or conflict prediction. Unknown target history can hide branch-changed paths; working-tree paths remain observable.

## Authentication and privacy

**Trust the service operator.** Each client sends its GitHub bearer token to the explicitly selected service; the service uses it for authenticated, read-only GitHub GraphQL requests. Use a narrowly scoped token with access to the selected repository and the required repository-metadata/PR/check reads. GitHub CLI's credential may be broader. Prefer `REPO_STATE_TOKEN` when you need a dedicated token. Credentials are held only in process memory, not plugin storage or snapshot payloads; no token is intentionally logged. The plugin caches a credential for 60 seconds. The service caches only its hash and authorization result, although a token is necessarily present while a request runs.

Every repository/state request is authorized. **A public repository does not make workspace snapshots public.** Public spectators with only `READ` are denied. This permission policy is deliberately not an organization-member directory and does not support public-repository read-only collaborators. Snapshot ownership and withdrawal authority are bound to immutable GitHub account IDs and repository node IDs, not reusable login names.

Shared metadata includes the authenticated GitHub login/account identity, opaque workspace/session UUIDs, caption, technical state, branch names, exact revisions, comparisons, relative changed paths, timestamps, and PR metadata (titles, URLs, reviews, CI, queue, declared dependencies). Treat captions, paths, branch names, and PR titles as potentially sensitive; everyone authorized for that repository can see its shared state.

No prompts, transcripts, model answers, tool arguments, command history, file contents, patches, absolute checkout paths, or machine fingerprints are collected or persisted. The absolute checkout root is hashed **locally only** to locate consent; neither it nor that hash is transmitted. Snapshots are overwritten, not appended. Short-lived sequence and stop tombstones prevent late requests from restoring withdrawn state; they are not history. Proxy/operator logging outside this program is the operator's responsibility.

## Optional GitHub webhook

Polling works without a webhook. For faster invalidation, set `REPO_STATE_WEBHOOK_SECRET` on the service and configure a GitHub webhook to the HTTPS `/webhook` endpoint with the same secret. The service verifies `X-Hub-Signature-256`; accepted events invalidate current repository and authorization caches. It does not retain webhook payloads or turn them into an event history. An unsigned or incorrectly signed request is rejected. Follow-up authenticated reads reconcile the actual GitHub state.

## Verification and demonstrated limits

```sh
npm test
claude plugin validate .
```

The built-in Node suite covers real Git revisions/renames/shallow and promisor history, index immutability, fork-aware PR association, dependency and cycle behavior, CI coverage, exact-path overlap, authenticated HTTP ownership/order/concurrency/stop/expiry, delayed observations, stale references, and signed invalidation.

Runtime verification used Node 25.9.0, Git 2.54.0, and Claude Code 2.1.289 on macOS arm64. It exercised the real service and two actual checkouts/native clients under **one authenticated account**, consent cancellation and acceptance, background outside-editor changes, branch switching, full-SHA/path details, overlap notices, caption typing and branch scope, refresh/stop controls, model `running → ready`, permission state, and local marketplace installation. A real authenticated upload held for 16 seconds was rejected rather than stamped as fresh.

Real GitHub reads verified contributor authorization, spectator denial, exact refs, a merged associated PR, and a nonexistent prerequisite. Populated native review/CI/merge-queue/cycle/unknown-dependency presentation and individual-reference staleness were exercised using a **clearly labeled controlled GitHub fixture**, not a live queued PR. Owner isolation and login reuse were tested against controlled HTTP authentication; two different live GitHub users were not exercised. There is no claim of older Claude/Git compatibility, multi-process deployment, production-scale load testing, or a CI guarantee for unpublished work.

The no-overengineering and non-tracking rules are explicit in [AGENTS.md](AGENTS.md).
