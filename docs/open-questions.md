# Open Questions

Living list of unresolved design decisions. When one is settled, move it to **Decided** below with a one-line rationale and update the doc that owns it.

## Architecture
- **Realtime updates**: polling vs. push (SSE/WebSocket) for board changes.
- **Project name**: `agent-kanban` is a working title.

## State machine (owned by `state-machine.md`)

- Does "human-only" mean human *credential* or human *intent* when the human works through an agent session? Drafted as credential.
- Does a parent card auto-advance when all children are terminal, or just surface as "reviewable"?
- Is the `Blocked` vs `Waiting` split worth the state count, or should they collapse into one paused state with a reason field?
- Recurrence for repeatable delegated tasks: System clones a template card on a schedule? (Leading candidate; templates are also the natural place to hang an `auto` grant.)
- What guardrails accompany `auto` beyond the audit trail — side-effect budget, spot-check digest, auto-demotion after N failures?
- Is there a path back out of `log` (reopening)? Currently a true terminal state.
- Can an agent cancel a card it executes when the task is obsolete, or is `cancelled` strictly human-only as drafted?
- Human-only scheduling friction: alternative where an agent may schedule cards *it created* into staging with executor pre-set to itself, subject to a human veto window.

## Data model

- Annotation/suggestion format — structured fields vs. freeform markdown with conventions. (Persisted for now as freeform `annotation_added` events; a structured format would layer on top.)

## Product philosophy (owned by `productivity-purge.md`)

- Enforcement (if any) of Newport's "no new projects for a month" post-purge ritual.
- Does the `focus` cap (1–2 starred cards per category) ever get soft-enforced, or stay a human norm the rituals reinforce?

## Decided

- **UI approach: server-rendered HTML + plain forms, dark theme** *(2026-09-12)* — Fastify serves HTML directly from `src/routes/board.ts`; no template engine, no JavaScript, no build step. Board at `GET /board?t=TOKEN`. Auth via `?t=` query param for browser access (bookmarkable URL). Chosen for minimum Pi footprint — no client-side bundle, no bundler.
- **Board state model: working-memory metaphor** *(2026-09-12)* — replaced `inbox/backlog/ready/in_progress/manual_review/done` with `inbox/staging/active/log`. Inbox = storage, Staging = today's list, Active = one-at-a-time CPU (API-enforced 409 on conflict), Log = history. Agent-completed reviewed-policy cards route to Staging for human approval. `scheduledFor` date field auto-promotes inbox cards to staging via `POST /system/promote-scheduled`.
- **Label schema: three facets — `category`, `focus`, `pending-tier`** *(2026-08-13)* — `category`: `professional` | `community` | `personal`. `focus`: starred flag, human norm of 1–2 per category, not API-enforced. `pending-tier` (meaningful on non-`focus` Inbox/Backlog cards): `daydream` (appealing, not obsessive, cheap to drop) | `white-whale` (would commit 1–3 months to, deferred by capacity not desire — first candidate for the next open `focus` slot). Full rationale in `docs/productivity-purge.md`.
- **Auth: static bearer tokens bound to an actor type** *(2026-07-06)* — `HUMAN_TOKENS` / `AGENT_TOKENS` env vars hold comma-separated `id:token` pairs; actor type derived from the token, never from the request body. Every `/cards` route requires a token; `/health` and `/openapi.json` stay open. Server refuses to start with zero credentials or duplicate tokens.
- **API shape: REST + OpenAPI** *(2026-07-06)* — resource routes plus action sub-routes for audited acts (transition, executor, review-policy, annotations, schedule). Spec generated via `@fastify/swagger` at `/openapi.json`. No `DELETE` — withdrawal is the `cancelled` transition.
- **Event store shape: append-only `events` + materialized `cards` projection** *(2026-07-06)* — `rebuildProjection()` can always reconstruct `cards` from `events` alone. better-sqlite3 for synchronous transactions + ARM binaries for the Pi.
- **Stack: TypeScript + Node (≥20) + Fastify, SQLite** *(2026-07-06)* — one language across API and UI, runs on a Raspberry Pi.
