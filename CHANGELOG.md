# Changelog

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
