/**
 * REST surface over CardStore. Routes stay thin: resolve the actor, call the
 * store, return the result. Every permission rule lives in the domain core /
 * store, which throws typed errors the app-level handler maps to responses
 * (PermissionError → 403, NotFoundError → 404, ValidationError → 400,
 * ConflictError → 409, UnauthorizedError → 401) — a disallowed request
 * fails closed, never gets coerced.
 *
 * Shape: resource routes for the card itself, action sub-routes for the
 * audited acts (transition, executor, review-policy, annotations, schedule).
 * The OpenAPI spec is generated from these route schemas (served at
 * /openapi.json), so the schemas are the API contract — keep them honest.
 */

import type { FastifyInstance } from "fastify";
import {
  CARD_STATES,
  CATEGORIES,
  EXECUTORS,
  PENDING_TIERS,
  REVIEW_POLICIES,
  type CardState,
  type Category,
  type ExecutorType,
  type PendingTier,
  type ReviewPolicy,
} from "../domain/state-machine.js";
import {
  EVENT_TYPES,
  NotFoundError,
  type CardStore,
  type StoreActor,
} from "../persistence/card-store.js";
import type { ActorResolver } from "./actor.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The authenticated caller, resolved from its credential before any handler runs. */
    actor: StoreActor;
  }
}

const cardSchema = {
  $id: "Card",
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    title: { type: "string" },
    description: { type: "string" },
    state: { type: "string", enum: [...CARD_STATES] },
    executor: { type: "string", enum: [...EXECUTORS] },
    reviewPolicy: { type: "string", enum: [...REVIEW_POLICIES] },
    pausedFrom: { type: ["string", "null"], enum: [...CARD_STATES, null] },
    scheduledFor: { type: ["string", "null"] },
    labels: {
      type: "object",
      properties: {
        category: { type: ["string", "null"], enum: [...CATEGORIES, null] },
        focus: { type: "boolean" },
        pendingTier: { type: ["string", "null"], enum: [...PENDING_TIERS, null] },
      },
      required: ["category", "focus", "pendingTier"],
    },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: [
    "id",
    "title",
    "description",
    "state",
    "executor",
    "reviewPolicy",
    "pausedFrom",
    "scheduledFor",
    "labels",
    "createdAt",
    "updatedAt",
  ],
} as const;

const eventSchema = {
  $id: "CardEvent",
  type: "object",
  properties: {
    id: { type: "integer" },
    cardId: { type: "string", format: "uuid" },
    type: { type: "string", enum: [...EVENT_TYPES] },
    actorId: { type: "string" },
    actorType: { type: "string", enum: ["human", "agent", "system"] },
    fromState: { type: ["string", "null"], enum: [...CARD_STATES, null] },
    toState: { type: ["string", "null"], enum: [...CARD_STATES, null] },
    executor: { type: "string", enum: [...EXECUTORS] },
    reviewPolicy: { type: "string", enum: [...REVIEW_POLICIES] },
    note: { type: ["string", "null"] },
    payload: { type: ["object", "null"], additionalProperties: true },
    createdAt: { type: "string", format: "date-time" },
  },
  required: [
    "id",
    "cardId",
    "type",
    "actorId",
    "actorType",
    "fromState",
    "toState",
    "executor",
    "reviewPolicy",
    "note",
    "payload",
    "createdAt",
  ],
} as const;

const errorSchema = {
  $id: "Error",
  type: "object",
  properties: { error: { type: "string" } },
  required: ["error"],
} as const;

/** Shared schemas referenced by $ref; the app adds these at the root so both validation and the OpenAPI generator can resolve them. */
export const apiSchemas = [cardSchema, eventSchema, errorSchema];

const idParams = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
} as const;

const mutationErrors = {
  400: { $ref: "Error#" },
  401: { $ref: "Error#" },
  403: { $ref: "Error#" },
  404: { $ref: "Error#" },
} as const;

const mutationErrorsWithConflict = {
  ...mutationErrors,
  409: { $ref: "Error#" },
} as const;

export interface CardRoutesOptions {
  store: CardStore;
  resolveActor: ActorResolver;
}

export async function cardRoutes(app: FastifyInstance, opts: CardRoutesOptions): Promise<void> {
  const { store, resolveActor } = opts;

  app.decorateRequest("actor", null as unknown as StoreActor);
  app.addHook("onRequest", async (request) => {
    request.actor = resolveActor(request);
  });

  app.post<{
    Body: {
      title: string;
      description?: string;
      scheduledFor?: string;
      category?: Category;
      focus?: boolean;
      pendingTier?: PendingTier;
    };
  }>(
    "/cards",
    {
      schema: {
        summary: "Create a card (into inbox)",
        description:
          "Human capture or agent-proposed work. The card starts untriaged in inbox. Optionally set scheduledFor (ISO date) for auto-promotion to staging.",
        body: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1 },
            description: { type: "string" },
            scheduledFor: { type: "string", format: "date" },
            category: { type: "string", enum: [...CATEGORIES] },
            focus: { type: "boolean" },
            pendingTier: { type: "string", enum: [...PENDING_TIERS] },
          },
          required: ["title"],
          additionalProperties: false,
        },
        response: {
          201: { $ref: "Card#" },
          400: { $ref: "Error#" },
          401: { $ref: "Error#" },
          403: { $ref: "Error#" },
        },
      },
    },
    async (request, reply) => {
      const card = store.createCard(request.body, request.actor);
      return reply.code(201).send(card);
    },
  );

  app.get<{
    Querystring: { state?: CardState; executor?: ExecutorType; category?: Category; focus?: boolean };
  }>(
    "/cards",
    {
      schema: {
        summary: "List cards, optionally filtered by state, executor, category, and/or focus",
        querystring: {
          type: "object",
          properties: {
            state: { type: "string", enum: [...CARD_STATES] },
            executor: { type: "string", enum: [...EXECUTORS] },
            category: { type: "string", enum: [...CATEGORIES] },
            focus: { type: "boolean" },
          },
          additionalProperties: false,
        },
        response: { 200: { type: "array", items: { $ref: "Card#" } }, 400: { $ref: "Error#" } },
      },
    },
    async (request) => store.listCards(request.query),
  );

  app.get<{ Params: { id: string } }>(
    "/cards/:id",
    {
      schema: {
        summary: "Fetch a card",
        params: idParams,
        response: { 200: { $ref: "Card#" }, 404: { $ref: "Error#" } },
      },
    },
    async (request) => {
      const card = store.getCard(request.params.id);
      if (card === undefined) throw new NotFoundError(`no card with id ${request.params.id}`);
      return card;
    },
  );

  app.patch<{ Params: { id: string }; Body: { title?: string; description?: string } }>(
    "/cards/:id",
    {
      schema: {
        summary: "Edit a card's title/description (human-only)",
        description:
          "The card definition is what the human triages and reviews — and, for auto cards, what the grant covers — so agents may not rewrite it; they propose edits via annotation.",
        params: idParams,
        body: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1 },
            description: { type: "string" },
          },
          minProperties: 1,
          additionalProperties: false,
        },
        response: { 200: { $ref: "Card#" }, ...mutationErrors },
      },
    },
    async (request) => store.updateCard(request.params.id, request.body, request.actor),
  );

  app.post<{ Params: { id: string }; Body: { to: CardState; note?: string } }>(
    "/cards/:id/transition",
    {
      schema: {
        summary: "Move a card to a new state",
        description:
          "Consults the domain state machine and fails closed (403) on anything it disallows. Some transitions require a note (400 without one). Moving to active returns 409 if the executor already has an active card.",
        params: idParams,
        body: {
          type: "object",
          properties: {
            to: { type: "string", enum: [...CARD_STATES] },
            note: { type: "string" },
          },
          required: ["to"],
          additionalProperties: false,
        },
        response: { 200: { $ref: "Card#" }, ...mutationErrorsWithConflict },
      },
    },
    async (request) =>
      store.transitionCard(request.params.id, request.body.to, request.actor, request.body.note),
  );

  app.post<{ Params: { id: string }; Body: { scheduledFor: string | null } }>(
    "/cards/:id/schedule",
    {
      schema: {
        summary: "Set or clear the scheduled date on a card (human-only)",
        description:
          "Cards with a scheduledFor date in the past or present are auto-promoted from inbox to staging. Send null to clear the date.",
        params: idParams,
        body: {
          type: "object",
          properties: {
            scheduledFor: { type: ["string", "null"], format: "date" },
          },
          required: ["scheduledFor"],
          additionalProperties: false,
        },
        response: { 200: { $ref: "Card#" }, ...mutationErrors },
      },
    },
    async (request) =>
      store.setScheduledFor(request.params.id, request.body.scheduledFor, request.actor),
  );

  app.post<{ Params: { id: string }; Body: { executor: ExecutorType; note?: string } }>(
    "/cards/:id/executor",
    {
      schema: {
        summary: "Assign or reassign the card's executor (human-only)",
        description: "Offloading a card to an agent, or taking it back, is always the human's act.",
        params: idParams,
        body: {
          type: "object",
          properties: {
            executor: { type: "string", enum: [...EXECUTORS] },
            note: { type: "string" },
          },
          required: ["executor"],
          additionalProperties: false,
        },
        response: { 200: { $ref: "Card#" }, ...mutationErrors },
      },
    },
    async (request) =>
      store.setExecutor(request.params.id, request.body.executor, request.actor, request.body.note),
  );

  app.post<{ Params: { id: string }; Body: { reviewPolicy: ReviewPolicy; note?: string } }>(
    "/cards/:id/review-policy",
    {
      schema: {
        summary: "Grant or revoke the auto review policy (human-only)",
        description:
          "Marking a task auto is the review, amortized: the human approves the task definition once instead of every run.",
        params: idParams,
        body: {
          type: "object",
          properties: {
            reviewPolicy: { type: "string", enum: [...REVIEW_POLICIES] },
            note: { type: "string" },
          },
          required: ["reviewPolicy"],
          additionalProperties: false,
        },
        response: { 200: { $ref: "Card#" }, ...mutationErrors },
      },
    },
    async (request) =>
      store.setReviewPolicy(
        request.params.id,
        request.body.reviewPolicy,
        request.actor,
        request.body.note,
      ),
  );

  app.post<{
    Params: { id: string };
    Body: { category?: Category | null; focus?: boolean; pendingTier?: PendingTier | null };
  }>(
    "/cards/:id/labels",
    {
      schema: {
        summary: "Update a card's labels (human-only)",
        description:
          "Set any combination of category, focus, and pending-tier. Send null to clear a facet. Partial updates are allowed — omit any facet to leave it unchanged.",
        params: idParams,
        body: {
          type: "object",
          properties: {
            category: { type: ["string", "null"], enum: [...CATEGORIES, null] },
            focus: { type: "boolean" },
            pendingTier: { type: ["string", "null"], enum: [...PENDING_TIERS, null] },
          },
          minProperties: 1,
          additionalProperties: false,
        },
        response: { 200: { $ref: "Card#" }, ...mutationErrors },
      },
    },
    async (request) => store.setLabels(request.params.id, request.body, request.actor),
  );

  app.post<{ Params: { id: string }; Body: { note: string } }>(
    "/cards/:id/annotations",
    {
      schema: {
        summary: "Annotate a card",
        description:
          "Any actor may annotate any card, any time — progress notes, questions, suggestions, volunteering. Annotations never require transition permission.",
        params: idParams,
        body: {
          type: "object",
          properties: { note: { type: "string", minLength: 1 } },
          required: ["note"],
          additionalProperties: false,
        },
        response: { 201: { $ref: "CardEvent#" }, ...mutationErrors },
      },
    },
    async (request, reply) => {
      const event = store.addAnnotation(request.params.id, request.body.note, request.actor);
      return reply.code(201).send(event);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/cards/:id/events",
    {
      schema: {
        summary: "The card's full audit trail, oldest first",
        params: idParams,
        response: {
          200: { type: "array", items: { $ref: "CardEvent#" } },
          404: { $ref: "Error#" },
        },
      },
    },
    async (request) => {
      if (store.getCard(request.params.id) === undefined) {
        throw new NotFoundError(`no card with id ${request.params.id}`);
      }
      return store.listEvents(request.params.id);
    },
  );

  app.post(
    "/system/promote-scheduled",
    {
      schema: {
        summary: "Promote inbox cards whose scheduledFor date has arrived into staging",
        description:
          "Intended to be called on a daily schedule (cron) or at board load. Returns the list of promoted cards.",
        response: {
          200: { type: "array", items: { $ref: "Card#" } },
          401: { $ref: "Error#" },
          403: { $ref: "Error#" },
        },
      },
    },
    async () => store.promoteScheduled(),
  );
}
