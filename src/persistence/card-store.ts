/**
 * Card persistence over the event log. Every mutation appends one row to the
 * append-only `events` table and updates the materialized `cards` row in the
 * same transaction, so the projection can never drift from the truth — and
 * `rebuildProjection()` can always reconstruct `cards` from `events` alone.
 *
 * The store enforces the domain core (src/domain/state-machine.ts) itself:
 * an illegal transition, executor change, or review-policy change is refused
 * with a typed error before anything is written. The API layer maps these to
 * responses (PermissionError → 403, NotFoundError → 404, ValidationError →
 * 400, ConflictError → 409) — it never needs to duplicate the rules.
 */

import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import {
  canChangeExecutor,
  canChangeLabels,
  canChangeReviewPolicy,
  canCreateCard,
  canEditCard,
  canScheduleCard,
  canTransition,
  isTerminal,
  type ActorType,
  type CardState,
  type Category,
  type ExecutorType,
  type Labels,
  type PendingTier,
  type ReviewPolicy,
} from "../domain/state-machine.js";

/** A domain rule refused the action for this actor. Maps to 403. */
export class PermissionError extends Error {}
/** The card does not exist. Maps to 404. */
export class NotFoundError extends Error {}
/** The request itself is malformed (e.g. a missing required note). Maps to 400. */
export class ValidationError extends Error {}
/** A constraint conflict (e.g. executor already has an active card). Maps to 409. */
export class ConflictError extends Error {}

/** An authenticated caller: type drives permissions, id goes in the audit trail. */
export interface StoreActor {
  id: string;
  type: ActorType;
}

export interface Card {
  id: string;
  title: string;
  description: string;
  state: CardState;
  executor: ExecutorType;
  reviewPolicy: ReviewPolicy;
  /** For blocked/waiting cards: the state to resume to. */
  pausedFrom: CardState | null;
  /** ISO date; system auto-promotes inbox cards to staging when this date arrives. */
  scheduledFor: string | null;
  labels: Labels;
  createdAt: string;
  updatedAt: string;
}

export const EVENT_TYPES = [
  "card_created",
  "card_updated",
  "state_transitioned",
  "executor_changed",
  "review_policy_changed",
  "labels_changed",
  "scheduled_for_changed",
  "annotation_added",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface CardEvent {
  id: number;
  cardId: string;
  type: EventType;
  actorId: string;
  actorType: ActorType;
  fromState: CardState | null;
  toState: CardState | null;
  /** The card's ownership regime once the event applied — what authorizes agent actions. */
  executor: ExecutorType;
  reviewPolicy: ReviewPolicy;
  note: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

interface CardRow {
  id: string;
  title: string;
  description: string;
  state: string;
  executor: string;
  review_policy: string;
  paused_from: string | null;
  scheduled_for: string | null;
  category: string | null;
  focus: number;
  pending_tier: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: number;
  card_id: string;
  type: string;
  actor_id: string;
  actor_type: string;
  from_state: string | null;
  to_state: string | null;
  executor: string;
  review_policy: string;
  note: string | null;
  payload: string | null;
  created_at: string;
}

function toCard(row: CardRow): Card {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    state: row.state as CardState,
    executor: row.executor as ExecutorType,
    reviewPolicy: row.review_policy as ReviewPolicy,
    pausedFrom: row.paused_from as CardState | null,
    scheduledFor: row.scheduled_for,
    labels: {
      category: row.category as Category | null,
      focus: row.focus === 1,
      pendingTier: row.pending_tier as PendingTier | null,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEvent(row: EventRow): CardEvent {
  return {
    id: row.id,
    cardId: row.card_id,
    type: row.type as EventType,
    actorId: row.actor_id,
    actorType: row.actor_type as ActorType,
    fromState: row.from_state as CardState | null,
    toState: row.to_state as CardState | null,
    executor: row.executor as ExecutorType,
    reviewPolicy: row.review_policy as ReviewPolicy,
    note: row.note,
    payload: row.payload === null ? null : (JSON.parse(row.payload) as Record<string, unknown>),
    createdAt: row.created_at,
  };
}

export interface CreateCardInput {
  title: string;
  description?: string;
  scheduledFor?: string | null;
  category?: Category | null;
  focus?: boolean;
  pendingTier?: PendingTier | null;
}

export interface UpdateCardInput {
  title?: string;
  description?: string;
}

export interface UpdateLabelsInput {
  category?: Category | null;
  focus?: boolean;
  pendingTier?: PendingTier | null;
}

export interface ListCardsFilter {
  state?: CardState;
  executor?: ExecutorType;
  category?: Category;
  focus?: boolean;
}

export class CardStore {
  constructor(private readonly db: Db) {}

  createCard(input: CreateCardInput, actor: StoreActor): Card {
    if (!canCreateCard({ type: actor.type })) {
      throw new PermissionError(`a ${actor.type} actor may not create cards`);
    }
    const title = input.title?.trim();
    if (!title) throw new ValidationError("a card requires a non-empty title");

    const id = randomUUID();
    const now = new Date().toISOString();
    const description = input.description ?? "";
    const scheduledFor = input.scheduledFor ?? null;
    const category = input.category ?? null;
    const focus = input.focus ?? false;
    const pendingTier = input.pendingTier ?? null;

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO cards (id, title, description, state, executor, review_policy, paused_from, scheduled_for, category, focus, pending_tier, created_at, updated_at)
           VALUES (@id, @title, @description, 'inbox', 'unassigned', 'reviewed', NULL, @scheduledFor, @category, @focus, @pendingTier, @now, @now)`,
        )
        .run({ id, title, description, scheduledFor, category, focus: focus ? 1 : 0, pendingTier, now });
      this.appendEvent({
        cardId: id,
        type: "card_created",
        actor,
        toState: "inbox",
        executor: "unassigned",
        reviewPolicy: "reviewed",
        payload: { title, description, scheduledFor, category, focus, pendingTier },
        createdAt: now,
      });
    })();

    return this.mustGet(id);
  }

  /**
   * Edit a card's definition (title/description). Human-only: the definition
   * is what the human triages, reviews, and — for `auto` cards — approved,
   * so an agent must not rewrite it. Terminal cards are frozen.
   */
  updateCard(id: string, input: UpdateCardInput, actor: StoreActor): Card {
    if (!canEditCard({ type: actor.type })) {
      throw new PermissionError("only a human may edit a card's title or description");
    }
    const card = this.mustGet(id);
    if (isTerminal(card.state)) {
      throw new ValidationError(`cannot edit a ${card.state} card`);
    }
    const title = input.title === undefined ? undefined : input.title.trim();
    if (title !== undefined && !title) {
      throw new ValidationError("a card requires a non-empty title");
    }
    if (title === undefined && input.description === undefined) {
      throw new ValidationError("an edit requires a new title or description");
    }

    const newTitle = title ?? card.title;
    const newDescription = input.description ?? card.description;
    const now = new Date().toISOString();

    this.db.transaction(() => {
      this.db
        .prepare("UPDATE cards SET title = ?, description = ?, updated_at = ? WHERE id = ?")
        .run(newTitle, newDescription, now, id);
      this.appendEvent({
        cardId: id,
        type: "card_updated",
        actor,
        executor: card.executor,
        reviewPolicy: card.reviewPolicy,
        payload: { title: newTitle, description: newDescription },
        createdAt: now,
      });
    })();

    return this.mustGet(id);
  }

  getCard(id: string): Card | undefined {
    const row = this.db.prepare("SELECT * FROM cards WHERE id = ?").get(id) as
      | CardRow
      | undefined;
    return row === undefined ? undefined : toCard(row);
  }

  listCards(filter: ListCardsFilter = {}): Card[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.state !== undefined) {
      clauses.push("state = ?");
      params.push(filter.state);
    }
    if (filter.executor !== undefined) {
      clauses.push("executor = ?");
      params.push(filter.executor);
    }
    if (filter.category !== undefined) {
      clauses.push("category = ?");
      params.push(filter.category);
    }
    if (filter.focus !== undefined) {
      clauses.push("focus = ?");
      params.push(filter.focus ? 1 : 0);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM cards${where} ORDER BY created_at, id`)
      .all(...params) as CardRow[];
    return rows.map(toCard);
  }

  /**
   * Move a card to a new state. Enforces domain rules and single-occupancy
   * on `active` (one card per executor at a time — 409 if already occupied).
   */
  transitionCard(id: string, to: CardState, actor: StoreActor, note?: string): Card {
    const card = this.mustGet(id);
    const decision = canTransition(
      {
        state: card.state,
        executor: card.executor,
        reviewPolicy: card.reviewPolicy,
        pausedFrom: card.pausedFrom ?? undefined,
      },
      to,
      { type: actor.type },
    );
    if (!decision.allowed) throw new PermissionError(decision.reason);
    if (decision.noteRequired && !note?.trim()) {
      throw new ValidationError(`a note is required to move this card to ${to}`);
    }

    // Single-occupancy: the executor may only have one card in `active`.
    if (to === "active" && card.executor !== "unassigned") {
      const conflict = this.db
        .prepare("SELECT id FROM cards WHERE state = 'active' AND executor = ? AND id != ?")
        .get(card.executor, id);
      if (conflict) {
        throw new ConflictError(
          `${card.executor} executor already has an active card; finish or pause it first`,
        );
      }
    }

    const now = new Date().toISOString();
    const pausedFrom = to === "blocked" || to === "waiting" ? card.state : null;

    this.db.transaction(() => {
      this.db
        .prepare("UPDATE cards SET state = ?, paused_from = ?, updated_at = ? WHERE id = ?")
        .run(to, pausedFrom, now, id);
      this.appendEvent({
        cardId: id,
        type: "state_transitioned",
        actor,
        fromState: card.state,
        toState: to,
        executor: card.executor,
        reviewPolicy: card.reviewPolicy,
        note,
        createdAt: now,
      });
    })();

    return this.mustGet(id);
  }

  /** Set or clear the scheduled date on an inbox card — human-only. */
  setScheduledFor(id: string, scheduledFor: string | null, actor: StoreActor): Card {
    if (!canScheduleCard({ type: actor.type })) {
      throw new PermissionError("only a human may set a card's scheduled date");
    }
    const card = this.mustGet(id);
    if (isTerminal(card.state)) {
      throw new ValidationError(`cannot schedule a ${card.state} card`);
    }

    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE cards SET scheduled_for = ?, updated_at = ? WHERE id = ?")
        .run(scheduledFor, now, id);
      this.appendEvent({
        cardId: id,
        type: "scheduled_for_changed",
        actor,
        executor: card.executor,
        reviewPolicy: card.reviewPolicy,
        payload: { from: card.scheduledFor, to: scheduledFor },
        createdAt: now,
      });
    })();

    return this.mustGet(id);
  }

  /**
   * Auto-promote inbox cards whose scheduledFor date has arrived into staging.
   * Called by the system on a schedule (e.g. daily cron or on board load).
   * Returns the promoted cards.
   */
  promoteScheduled(today: string = new Date().toISOString().slice(0, 10)): Card[] {
    const systemActor: StoreActor = { id: "system", type: "system" };
    const due = this.db
      .prepare(
        "SELECT * FROM cards WHERE state = 'inbox' AND scheduled_for IS NOT NULL AND scheduled_for <= ?",
      )
      .all(today) as CardRow[];

    const promoted: Card[] = [];
    for (const row of due) {
      const card = toCard(row);
      const now = new Date().toISOString();
      this.db.transaction(() => {
        this.db
          .prepare("UPDATE cards SET state = 'staging', paused_from = NULL, updated_at = ? WHERE id = ?")
          .run(now, card.id);
        this.appendEvent({
          cardId: card.id,
          type: "state_transitioned",
          actor: systemActor,
          fromState: "inbox",
          toState: "staging",
          executor: card.executor,
          reviewPolicy: card.reviewPolicy,
          createdAt: now,
        });
      })();
      promoted.push(this.mustGet(card.id));
    }
    return promoted;
  }

  /** Offload a card or take it back — the human's act, always. */
  setExecutor(id: string, executor: ExecutorType, actor: StoreActor, note?: string): Card {
    if (!canChangeExecutor({ type: actor.type })) {
      throw new PermissionError("only a human may change a card's executor");
    }
    const card = this.mustGet(id);
    if (card.executor === executor) {
      throw new ValidationError(`card executor is already ${executor}`);
    }

    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE cards SET executor = ?, updated_at = ? WHERE id = ?")
        .run(executor, now, id);
      this.appendEvent({
        cardId: id,
        type: "executor_changed",
        actor,
        executor,
        reviewPolicy: card.reviewPolicy,
        note,
        payload: { from: card.executor, to: executor },
        createdAt: now,
      });
    })();

    return this.mustGet(id);
  }

  /** Grant or revoke the `auto` review policy — human-only, like executor. */
  setReviewPolicy(id: string, policy: ReviewPolicy, actor: StoreActor, note?: string): Card {
    if (!canChangeReviewPolicy({ type: actor.type })) {
      throw new PermissionError("only a human may change a card's review policy");
    }
    const card = this.mustGet(id);
    if (card.reviewPolicy === policy) {
      throw new ValidationError(`card review policy is already ${policy}`);
    }

    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE cards SET review_policy = ?, updated_at = ? WHERE id = ?")
        .run(policy, now, id);
      this.appendEvent({
        cardId: id,
        type: "review_policy_changed",
        actor,
        executor: card.executor,
        reviewPolicy: policy,
        note,
        payload: { from: card.reviewPolicy, to: policy },
        createdAt: now,
      });
    })();

    return this.mustGet(id);
  }

  /** Update one or more label facets on a card — human-only. */
  setLabels(id: string, input: UpdateLabelsInput, actor: StoreActor): Card {
    if (!canChangeLabels({ type: actor.type })) {
      throw new PermissionError("only a human may change a card's labels");
    }
    const card = this.mustGet(id);
    if (isTerminal(card.state)) {
      throw new ValidationError(`cannot label a ${card.state} card`);
    }
    if (
      input.category === undefined &&
      input.focus === undefined &&
      input.pendingTier === undefined
    ) {
      throw new ValidationError(
        "a label update requires at least one of: category, focus, pendingTier",
      );
    }

    const newCategory = input.category !== undefined ? input.category : card.labels.category;
    const newFocus = input.focus !== undefined ? input.focus : card.labels.focus;
    const newPendingTier =
      input.pendingTier !== undefined ? input.pendingTier : card.labels.pendingTier;
    const now = new Date().toISOString();

    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE cards SET category = ?, focus = ?, pending_tier = ?, updated_at = ? WHERE id = ?",
        )
        .run(newCategory, newFocus ? 1 : 0, newPendingTier, now, id);
      this.appendEvent({
        cardId: id,
        type: "labels_changed",
        actor,
        executor: card.executor,
        reviewPolicy: card.reviewPolicy,
        payload: { category: newCategory, focus: newFocus, pendingTier: newPendingTier },
        createdAt: now,
      });
    })();

    return this.mustGet(id);
  }

  /**
   * Any actor may annotate any card, any time — progress notes, questions,
   * suggestions, volunteering. Annotations never require transition
   * permission and do not touch the card projection.
   */
  addAnnotation(id: string, note: string, actor: StoreActor): CardEvent {
    const card = this.mustGet(id);
    if (!note?.trim()) throw new ValidationError("an annotation requires a non-empty note");

    const eventId = this.appendEvent({
      cardId: id,
      type: "annotation_added",
      actor,
      executor: card.executor,
      reviewPolicy: card.reviewPolicy,
      note,
      createdAt: new Date().toISOString(),
    });
    const row = this.db.prepare("SELECT * FROM events WHERE id = ?").get(eventId) as EventRow;
    return toEvent(row);
  }

  /** The card's full audit trail, oldest first. */
  listEvents(cardId: string): CardEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE card_id = ? ORDER BY id")
      .all(cardId) as EventRow[];
    return rows.map(toEvent);
  }

  private mustGet(id: string): Card {
    const card = this.getCard(id);
    if (card === undefined) throw new NotFoundError(`no card with id ${id}`);
    return card;
  }

  private appendEvent(event: {
    cardId: string;
    type: EventType;
    actor: StoreActor;
    fromState?: CardState;
    toState?: CardState;
    executor: ExecutorType;
    reviewPolicy: ReviewPolicy;
    note?: string;
    payload?: Record<string, unknown>;
    createdAt: string;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO events (card_id, type, actor_id, actor_type, from_state, to_state, executor, review_policy, note, payload, created_at)
         VALUES (@cardId, @type, @actorId, @actorType, @fromState, @toState, @executor, @reviewPolicy, @note, @payload, @createdAt)`,
      )
      .run({
        cardId: event.cardId,
        type: event.type,
        actorId: event.actor.id,
        actorType: event.actor.type,
        fromState: event.fromState ?? null,
        toState: event.toState ?? null,
        executor: event.executor,
        reviewPolicy: event.reviewPolicy,
        note: event.note ?? null,
        payload: event.payload === undefined ? null : JSON.stringify(event.payload),
        createdAt: event.createdAt,
      });
    return Number(result.lastInsertRowid);
  }
}

/**
 * Rebuild the `cards` projection from the event log alone. Proves — and, if
 * the projection is ever corrupted or the materialization logic changes,
 * restores — the invariant that `events` is the single source of truth.
 */
export function rebuildProjection(db: Db): void {
  db.transaction(() => {
    db.prepare("DELETE FROM cards").run();

    const insertCard = db.prepare(
      `INSERT INTO cards (id, title, description, state, executor, review_policy, paused_from, scheduled_for, category, focus, pending_tier, created_at, updated_at)
       VALUES (@id, @title, @description, @state, @executor, @reviewPolicy, @pausedFrom, @scheduledFor, @category, @focus, @pendingTier, @createdAt, @updatedAt)`,
    );
    const updateContent = db.prepare(
      "UPDATE cards SET title = ?, description = ?, updated_at = ? WHERE id = ?",
    );
    const updateState = db.prepare(
      "UPDATE cards SET state = ?, paused_from = ?, updated_at = ? WHERE id = ?",
    );
    const updateExecutor = db.prepare(
      "UPDATE cards SET executor = ?, updated_at = ? WHERE id = ?",
    );
    const updateReviewPolicy = db.prepare(
      "UPDATE cards SET review_policy = ?, updated_at = ? WHERE id = ?",
    );
    const updateLabels = db.prepare(
      "UPDATE cards SET category = ?, focus = ?, pending_tier = ?, updated_at = ? WHERE id = ?",
    );
    const updateScheduledFor = db.prepare(
      "UPDATE cards SET scheduled_for = ?, updated_at = ? WHERE id = ?",
    );

    const rows = db.prepare("SELECT * FROM events ORDER BY id").all() as EventRow[];
    for (const row of rows) {
      const event = toEvent(row);
      switch (event.type) {
        case "card_created": {
          const p = event.payload ?? {};
          insertCard.run({
            id: event.cardId,
            title: String(p.title ?? ""),
            description: String(p.description ?? ""),
            state: event.toState,
            executor: event.executor,
            reviewPolicy: event.reviewPolicy,
            pausedFrom: null,
            scheduledFor: p.scheduledFor ?? null,
            category: p.category ?? null,
            focus: p.focus ? 1 : 0,
            pendingTier: p.pendingTier ?? null,
            createdAt: event.createdAt,
            updatedAt: event.createdAt,
          });
          break;
        }
        case "card_updated": {
          const p = event.payload ?? {};
          updateContent.run(String(p.title ?? ""), String(p.description ?? ""), event.createdAt, event.cardId);
          break;
        }
        case "state_transitioned": {
          const pausedFrom =
            event.toState === "blocked" || event.toState === "waiting" ? event.fromState : null;
          updateState.run(event.toState, pausedFrom, event.createdAt, event.cardId);
          break;
        }
        case "executor_changed":
          updateExecutor.run(event.executor, event.createdAt, event.cardId);
          break;
        case "review_policy_changed":
          updateReviewPolicy.run(event.reviewPolicy, event.createdAt, event.cardId);
          break;
        case "labels_changed": {
          const p = event.payload ?? {};
          updateLabels.run(p.category ?? null, p.focus ? 1 : 0, p.pendingTier ?? null, event.createdAt, event.cardId);
          break;
        }
        case "scheduled_for_changed": {
          const p = event.payload ?? {};
          updateScheduledFor.run(p.to ?? null, event.createdAt, event.cardId);
          break;
        }
        case "annotation_added":
          // Annotations live only in the event log.
          break;
      }
    }
  })();
}
