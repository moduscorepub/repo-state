# Changelog

## 0.2.0 — 2026-10-03

- Redesigned the pane as a PR-first board grouped by No PR yet, Draft, Open, and Merge queue, with status chips, right-aligned Claude state and age, collapsible sections, `1`–`9` row picks, and a "What are you working on?" caption box.
- Shared per-file status, line counts, and changed-line ranges mapped onto the current target revision; shared files are marked same lines, different areas, whole file, or lines unknown.
- Added in-pane diffs: your files from local Git, teammates' pushed files from GitHub through the service with the requester's own token; unpushed teammate edits stay line ranges only.
- Added the `stack_context` tool so Claude can pick a PR base branch and `Depends-On: #N` lines from contained PR commits and same-line work when creating a PR.
- Removed the awaiting-permission state; running and ready remain.
- Consent now preselects Cancel, so a stray Enter cannot opt a checkout in.
- Git diffs now disable diff-time index refresh writes; a regression test caught the rewrite.
- The first publication waits for current refs, so new sessions no longer briefly publish unknown comparisons.

## 0.1.0 — 2026-10-03

- Added Repo State's native Claude Code workspace and PR pane, optional branch-scoped captions, full revision/path details, and refresh/stop controls.
- Added the dependency-free, authenticated, memory-only shared service. Public visibility alone does not grant access; immutable GitHub account/repository IDs bind ownership.
- Kept local HEAD, published source tip, and PR target separate. Missing history and stale references remain unknown; CI applies only to its published checked revision.
- Added explicit same-repository PR dependencies, cycle/self/closed-unmerged/unknown states, observed reviews and merge queue, and exact shared-path notices without predicting conflicts.
- Added polling, freshness/expiry, checkout-wide withdrawal tombstones, commit-time ordering checks, request-age accounting, and optional signed webhook invalidation.
- Disabled Git lazy object fetches, optional index refresh writes, and configured filesystem-monitor execution during collection.
- Exercised actual native consent, background publication, outside-editor Git changes, caption redraw/scope, full-SHA details, refresh/stop, and model state transitions. Verified local marketplace installation.
- Published the public `moduscorepub/repo-state` repository and verified GitHub marketplace installation over HTTPS. A fresh public clone passed all 10 tests, native validation, and the service startup/health smoke.
- Verified real GitHub access/refs/merged and missing PRs; used labeled controlled GitHub data for populated native review/CI/queue/dependency/stale-reference presentation. See README for exact limits.
- Established explicit no-overengineering, metadata-only privacy, and non-tracking rules in AGENTS.md.
