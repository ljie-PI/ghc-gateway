# Agent guide

## Project references

- **Usage and configuration:** read `README.md`.
- **Naming:** use the vocabulary in `CONTEXT.md`.
- **Implementation changes:** inspect the relevant module interfaces in `src/`, their tests in `tests/`, and the commands in `package.json`.

Keep documentation limited to usage and concise contributor guidance. Do not recreate removed protocol, architecture, source-analysis or ADR documents unless explicitly requested.

## Delivery workflow

- Execute each implementation issue in an isolated worktree on a focused maintenance branch created from the latest `main`; submit its pull request targeting `main` and keep `main` unchanged until the reviewed pull request merges.
- After implementation and required validation, use `/skill:code-review` before opening the pull request to review Standards and Spec independently. Resolve every must-fix or important blocker and repeat the affected review until none remain.
- After required CI passes and the reviewed pull request merges, remove its local and remote branches and worktree, synchronize `main`, and verify that it is clean.
- Keep user-facing documentation aligned with the delivered runtime and CLI. Track task status and handoffs in GitHub Issues, not per-task specification files.

## Engineering guardrails

- Keep comments and code documentation in English.
- Keep credentials and request/response content out of commits, logs, metrics, and public errors.
- Treat exact protocol fields, ordering, terminal events, and wire bytes as observable behavior.
- Test through module interfaces; use deterministic clock/UUID inputs and protocol golden fixtures where required.
- Use targeted existing tests and preserve fixture inputs/expected bytes unless the requested behavior changes. Official SDK suites require separate explicit authorization, including the offline suite.

## Review gate

Review requested behavior, API compatibility and module ownership before opening a PR. Passing tests alone do not prove correctness. Block changes that introduce or conceal:

- Unintended changes to status, headers, payload, ordering, terminal, model resolution, or history ownership.
- Disclosure of credentials, request/response content, or unsafe upstream diagnostics.
- Unbounded state or unsafe cancellation, timeout, commit, and resource-cleanup paths.
- Missing required behavioral, byte-golden, or performance evidence.
- Broken shared interfaces or state ownership that makes dependent modules unsafe.
- Unreasonable structure: duplicated protocol state machines, misleading abstractions, hidden coupling, or control flow that obscures lifecycle boundaries.

Classify findings as must-fix, safe-to-defer, or no-action. A safe deferral requires a linked follow-up issue recording the finding, affected files, safety rationale and concrete acceptance criteria; list it in the PR's deferred follow-ups and leave no broken or fail-open dependency. Explain false positives with evidence; clarify ambiguous requirements before changing behavior.

## Issue tracking

Tasks are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.
