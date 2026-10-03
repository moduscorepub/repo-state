# Implementation rules

## No overengineering

Write the code that implements the current requirement directly. Prefer existing code, standard-library functions, and native Claude Code features. Use plain JavaScript and Node.js built-ins. Do not add frameworks, dependency injection containers, generic interfaces, factories, queues, event sourcing, databases, build steps, or configuration for hypothetical needs. Introduce an abstraction or dependency only when a current, demonstrated requirement cannot reasonably be met without it. Keep the fewest files that remain understandable. Finish and exercise the real behavior; never ship scaffolds, fake fallbacks, or unfinished paths.

## Product boundary

This is a live repository-state view, not a tracker. Store only the latest workspace snapshot and expire it. Never collect or retain prompts, transcripts, command history, source contents, patches, human activity, productivity metrics, or historical workspace snapshots. A missing workspace means not sharing, never not working.

## Correctness and security

Keep local HEAD, published branch tip, and PR target revision separate. Bind CI to its checked revision. Show unknown or stale when evidence is missing. Dependencies are explicit PR metadata, not AI guesses. Never modify Git state, block Claude tools, control merges, or publish credentials. Authenticate and authorize every service request. Public repository visibility alone must not grant access to shared workspace state.

## Verification

Use Node's built-in test runner for consumer-visible boundaries and transitions. Exercise the actual service, real Git checkouts, real GitHub reads, and Claude Code's native pane. Do not add tests for source text, implementation wiring, or mock echoes. Keep documentation limited to installation, operation, privacy, and demonstrated limits.
