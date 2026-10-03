# Repo State

Live, shared Git and GitHub state in Claude Code's native terminal pane. A dependency-free Node service holds only current workspace snapshots in memory.

**This is not a tracker.** There are no tickets, assignments, percentages, attendance, human activity measurements, histories, productivity metrics, or merge controls. A missing workspace means **not sharing**, never **not working**.

## What the pane shows

A PR-first board, grouped as **No PR yet → Draft → Open → Merge queue**, with counts in the header:

- One row per open PR or connected branch: title or caption, owner, observation age, and the observed Claude state (`:: running`, `◇ ready`).
- Chips for review state, revision-bound CI, merge-queue position, explicit dependencies, `local only`, and stale evidence.
- Local `HEAD`, the pushed branch tip, and the PR target tip kept separate; ahead/behind only for the exact sampled revisions.
- Every changed file, updated every 5 seconds: status (`A`, `M`, `D`, `U`, `?`), `+added −removed`, and changed **line ranges** against the current target revision.
- Files someone else is also changing, marked **same lines**, **different areas**, **whole file**, or **lines unknown**. This is not a conflict prediction.
- Selecting a file shows its diff: your own from local Git, a teammate's pushed version from GitHub. Teammates' unpushed edits are shown only as line ranges.

Press `Ctrl+X` then `Tab` to move the keyboard between the prompt and the pane. In the pane: `Tab` moves, `Enter` opens a row or file, `1`–`9` picks a row, `r` refreshes, `s` stops sharing, arrows scroll, and `Esc` closes the pane without stopping sharing.

## Requirements

- Node.js **24 or later** for the service and tests. No dependencies, `npm install`, or build step.
- Claude Code with native JavaScript plugins, `ui.render` panes, commands, clocks, HTTP/process APIs, and local plugin storage. **Verified with Claude Code 2.1.289**, not older plugin API shapes.
- Git supporting global `--no-lazy-fetch` and `--no-optional-locks`. **Verified with Git 2.54.0**; older releases are not claimed as supported. Check `git --no-lazy-fetch --no-optional-locks version` before connecting.
- An authenticated GitHub CLI (`gh auth login`) or `REPO_STATE_TOKEN` in Claude's environment.
- Contributor access to a public repository (`TRIAGE`, `WRITE`, `MAINTAIN`, or `ADMIN`), or authenticated `READ` access to a private repository.

## Install from GitHub

```sh
claude plugin marketplace add https://github.com/moduscorepub/repo-state.git
claude plugin install repo-state@moduscorepub
claude plugin list
```

Restart Claude Code after installation. The HTTPS URL does not require GitHub SSH credentials. To run the service yourself, clone the repository and follow the service instructions below:

```sh
git clone https://github.com/moduscorepub/repo-state.git
```

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

For teammates, replace the address with the same trusted HTTPS service origin. Omitting `owner/repository` uses a recognizable GitHub `origin`. The dialog explains what is shared and how authentication works. **Cancel** is preselected; only choosing **Share metadata** enables publication.

```text
/repo-state                    Open the pane
/repo-state caption Auth API   Save an optional caption for this branch
/repo-state caption            Clear the caption
/repo-state refresh            Force a local observation and GitHub refresh
/repo-state stop               Withdraw this checkout and disable publication
```

The **What are you working on?** box at the bottom of the pane saves a caption on Enter and keeps your typing across redraws. Captions are one line, at most 140 characters, and belong to the branch they were written on: switching branches hides the caption, and returning restores it unless it was replaced or sharing was stopped. A PR title or branch name is used when no caption applies.

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

**Git is read-only:** the collector disables lazy object fetching, optional index locks, diff-time index refresh writes, and configured filesystem-monitor execution. It never fetches, pulls, checks out, rebases, pushes, locks user files, blocks Claude tools, or manages merges.

**CI is revision-bound:** the pane names the exact published PR SHA attached to GitHub's check rollup. Checks for a different published head are unknown. Unpublished local commits and any staged, unstaged, untracked, or unresolved changes are explicitly not checked by those results. This is GitHub's published-head rollup, not a promise that a hypothetical merge result, unpublished commit, or dirty tree passed CI.

**Claude states are technical observations:** `running` means an observed main model request; `ready` follows a completed main turn; missing evidence is `unknown`. These are not measurements of a person's activity or idle time, and do not summarize every subagent independently.

## Explicit dependencies

Put a standalone declaration in the PR body:

```text
Depends-On: #42, #44
```

Only explicit same-repository PR numbers are resolved. Code-fenced examples and quoted prose are ignored. Empty or malformed declarations remain invalid, cross-repository declarations are unsupported, and missing PRs remain unknown. The pane distinguishes open, merged, closed-unmerged, self-dependencies, and cycles. It shows the prerequisite target branch so a merge elsewhere is not silently treated as target containment. There is no inferred dependency or automatic merge order, and no blocking or enforcement.

**Line ranges are compared only on a common base.** Each checkout reports its changed lines against the current target revision, mapping commits made on an older base forward through the target's later changes. Two checkouts' ranges are compared only when both are against the same current target SHA and that target is available locally; otherwise the file is shown as **lines unknown**. New, deleted, untracked, and conflicted files count as whole-file overlaps. Ranges are approximate where the target itself rewrote the same lines.

## PR stacking context for Claude

While a checkout is shared, Claude gets a `stack_context` tool. Its description tells Claude to call it just before creating, retargeting, or describing a pull request, and not for other work. It returns facts:

- this branch's revision, push state, and target;
- open PRs whose head commits this branch already contains (checked locally with `git merge-base --is-ancestor`);
- teammates' branches and PRs changing the same files, with same-line ranges;
- the other open PRs and their declared dependencies.

Claude uses this to choose the base branch and a `Depends-On: #N` line. The tool returns information only; it does not create PRs, edit their bodies, or merge anything. Teammate-provided titles, branch names, and paths are quoted and labeled as data, not instructions.

## Authentication and privacy

**Trust the service operator.** Each client sends its GitHub bearer token to the explicitly selected service; the service uses it for authenticated, read-only GitHub GraphQL requests. Use a narrowly scoped token with access to the selected repository and the required repository-metadata/PR/check reads. GitHub CLI's credential may be broader. Prefer `REPO_STATE_TOKEN` when you need a dedicated token. Credentials are held only in process memory, not plugin storage or snapshot payloads; no token is intentionally logged. The plugin caches a credential for 60 seconds. The service caches only its hash and authorization result, although a token is necessarily present while a request runs.

Every repository/state request is authorized. **A public repository does not make workspace snapshots public.** Public spectators with only `READ` are denied. This permission policy is deliberately not an organization-member directory and does not support public-repository read-only collaborators. Snapshot ownership and withdrawal authority are bound to immutable GitHub account IDs and repository node IDs, not reusable login names.

Shared metadata includes the authenticated GitHub login/account identity, opaque workspace/session UUIDs, caption, technical state, branch names, exact revisions, comparisons, relative changed paths with status, line counts and changed-line ranges, timestamps, and PR metadata (titles, authors, URLs, reviews, CI, queue, declared dependencies). Treat captions, paths, branch names, and PR titles as potentially sensitive; everyone authorized for that repository can see its shared state.

No prompts, transcripts, model answers, tool arguments, command history, file contents, unpushed patches, absolute checkout paths, or machine fingerprints are collected or persisted. Your own diffs are read from local Git and never leave your machine. A teammate's **pushed** diff is fetched on request by the service from GitHub with **your** token, returned only to you, and never stored. The absolute checkout root is hashed **locally only** to locate consent; neither it nor that hash is transmitted. Snapshots are overwritten, not appended. Short-lived sequence and stop tombstones prevent late requests from restoring withdrawn state; they are not history. Proxy/operator logging outside this program is the operator's responsibility.

When Claude calls `stack_context`, the returned team metadata enters that Claude session's context and is sent to its model provider like any other tool result.

## Optional GitHub webhook

Polling works without a webhook. For faster invalidation, set `REPO_STATE_WEBHOOK_SECRET` on the service and configure a GitHub webhook to the HTTPS `/webhook` endpoint with the same secret. The service verifies `X-Hub-Signature-256`; accepted events invalidate current repository and authorization caches. It does not retain webhook payloads or turn them into an event history. An unsigned or incorrectly signed request is rejected. Follow-up authenticated reads reconcile the actual GitHub state.

## Verification and demonstrated limits

```sh
npm test
claude plugin validate .
```

The built-in Node suite covers real Git revisions/renames/shallow and promisor history, index immutability, changed-line mapping onto a moved target, same-line/different-area/whole-file classification, fork-aware PR association, dependency and cycle behavior, CI coverage, authenticated HTTP ownership/order/concurrency/stop/expiry, delayed observations, stale references, and signed invalidation.

Runtime verification used Node 25.9.0, Git 2.54.0, and Claude Code 2.1.289 on macOS arm64. It exercised the real service and two actual checkouts/native clients under **one authenticated account**, consent cancellation and acceptance, background outside-editor changes, branch switching, full-SHA/path details, overlap notices, caption typing and branch scope, refresh/stop controls, model `running → ready`, permission state, and local marketplace installation. A real authenticated upload held for 16 seconds was rejected rather than stamped as fresh.

The public GitHub marketplace was registered and installed in isolated Claude configurations using both `moduscorepub/repo-state` and its explicit HTTPS URL. A fresh HTTPS clone passed all 10 tests and native plugin validation; `npm start` launched the downloaded service and `/health` returned `{"ok":true}`.

Real GitHub reads verified contributor authorization, spectator denial, exact refs, a merged associated PR, and a nonexistent prerequisite. Populated native review/CI/merge-queue/cycle/unknown-dependency presentation and individual-reference staleness were exercised using a **clearly labeled controlled GitHub fixture**, not a live queued PR. Owner isolation and login reuse were tested against controlled HTTP authentication; two different live GitHub users were not exercised. There is no claim of older Claude/Git compatibility, multi-process deployment, production-scale load testing, or a CI guarantee for unpublished work.

The 0.2.0 board was exercised in Claude Code 2.1.289 against the real service with real Git checkouts and labeled controlled GitHub data: four PR groups, draft/open/queued rows, a branch stacked on another PR, same-line and different-area overlaps after the target moved, a local diff, a teammate's pushed diff fetched through the service, and a real Claude turn that called `stack_context` and recommended `--base rate-limit` with `Depends-On: #42`. Live GitHub pushed-diff reads and stacking against real open PRs were not exercised.

The no-overengineering and non-tracking rules are explicit in [AGENTS.md](AGENTS.md).
