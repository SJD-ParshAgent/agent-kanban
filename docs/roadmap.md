# Roadmap

Working queue and build order. Keep one item **In progress** at a time; move finished items to **Done** with the date. This file — plus `CLAUDE.md` and the design docs — is everything a fresh session needs to pick up where the last one left off, so keep it current and conversation context can be cleared freely.

(Yes, this file is a kanban board for building a kanban board. Once the API works, dogfooding it is the plan.)

## In progress

*(nothing)*

## Next
2. **Recurrence / template cards** — a scheduled clone of a template card into `inbox`/`staging` (open question in `docs/state-machine.md`). Needed for both autopilot scheduling and the ritual cards below.
3. **Ritual cards** — weekly accountability + quarterly planning/purge as recurring, agent-executed cards per `docs/productivity-purge.md`.
4. **Reassess** — with the above in place, drive the board via `curl` with an agent token for the first real end-to-end validation: dogfood the roadmap *and* the purge rituals onto it.

## Later

- Decomposition (parent/child cards)
- "What needs my attention" view/filter
- Realtime updates (polling vs. push — open question)
- Web UI

## Done

- Board state machine redesign + UI — replaced `inbox/backlog/ready/in_progress/manual_review/done` with the working-memory model (`inbox/staging/active/log`). Added `scheduledFor` field for date-based auto-promotion. Single-occupancy enforcement on `active` (409). Agent-completed work routes to `staging` for human review. Board UI at `GET /board?t=TOKEN` (server-rendered HTML, plain forms, dark theme). `POST /system/promote-scheduled` auto-promotes due inbox cards. 120 tests. *(2026-09-12)*

- Label schema — `category` (`professional`/`community`/`personal`), `focus` (boolean starred flag), `pending-tier` (`daydream`/`white-whale`) as first-class card fields. DB migration (v2) adds three columns; `setLabels()` is human-only with partial-update semantics; optional on create; `GET /cards` accepts `category` and `focus` filters; `POST /cards/:id/labels` endpoint; `labels_changed` event in the audit trail; `rebuildProjection` replays label events. 17 new tests. *(2026-08-13)*

- Auth — static bearer tokens bound to actor type (`src/routes/actor.ts`): `HUMAN_TOKENS`/`AGENT_TOKENS` env vars (`id:token` pairs), actor derived from the token never the body, all `/cards` routes require a token (reads included), server refuses to start without credentials; OpenAPI carries the bearer scheme; tests in `tests/actor.test.ts` + updated `tests/api.test.ts` *(2026-07-06)*
- API routes — REST surface over `CardStore` (`src/routes/`): cards create/list/get/edit, action endpoints for transition/executor/review-policy/annotations, per-card audit trail; typed store errors mapped to 401/403/404/400, fails closed; OpenAPI spec generated from route schemas via `@fastify/swagger`, served at `/openapi.json`; interim `x-actor-*` header credentials isolated in `src/routes/actor.ts` for item 4 to replace; API-shape decision recorded in `open-questions.md`; 17 tests in `tests/api.test.ts` *(2026-07-06)*
- Persistence — SQLite via better-sqlite3 (`src/persistence/`): append-only `events` table as source of truth + materialized `cards` projection updated in the same transaction; `CardStore` enforces the domain core itself with typed errors (`PermissionError`→403, `NotFoundError`→404, `ValidationError`→400) so routes just map them; `rebuildProjection()` replays events to reconstruct `cards`; 16 tests in `tests/card-store.test.ts` *(2026-07-06)*
- Domain core — `src/domain/state-machine.ts`: state/actor/executor/review-policy types, `canTransition()` + creation/executor/review-policy permission checks mirroring `docs/state-machine.md`; `noteRequired` flags transitions that must carry a note; 40 table-driven tests in `tests/state-machine.test.ts` *(2026-07-06)*
- Project scaffold — TypeScript + Fastify skeleton, `/health` endpoint + test, docs housekeeping (root `CLAUDE.md`, `open-questions.md`, README) *(2026-07-06)*
