import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/persistence/db.js";
import {
  CardStore,
  ConflictError,
  NotFoundError,
  PermissionError,
  ValidationError,
  rebuildProjection,
  type StoreActor,
} from "../src/persistence/card-store.js";

const human: StoreActor = { id: "human-1", type: "human" };
const agent: StoreActor = { id: "agent-1", type: "agent" };
const system: StoreActor = { id: "system", type: "system" };

let db: Db;
let store: CardStore;

beforeEach(() => {
  db = openDb(":memory:");
  store = new CardStore(db);
});

/** Create a card and walk it to the given state as its (agent) executor. */
function delegatedCard(upTo: "staging" | "active" = "active") {
  const card = store.createCard({ title: "delegated task" }, human);
  store.setExecutor(card.id, "agent", human);
  store.transitionCard(card.id, "staging", human);
  if (upTo === "staging") return store.getCard(card.id)!;
  store.transitionCard(card.id, "active", agent);
  return store.getCard(card.id)!;
}

describe("createCard", () => {
  it("creates an untriaged card in inbox with the default regime", () => {
    const card = store.createCard({ title: "capture", description: "details" }, human);
    expect(card).toMatchObject({
      title: "capture",
      description: "details",
      state: "inbox",
      executor: "unassigned",
      reviewPolicy: "reviewed",
      pausedFrom: null,
      scheduledFor: null,
    });
    expect(store.getCard(card.id)).toEqual(card);
  });

  it("records a card_created event with the acting credential", () => {
    const card = store.createCard({ title: "capture" }, agent);
    const events = store.listEvents(card.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "card_created",
      actorId: "agent-1",
      actorType: "agent",
      toState: "inbox",
      payload: { title: "capture", description: "" },
    });
  });

  it("rejects system actors and empty titles", () => {
    expect(() => store.createCard({ title: "x" }, system)).toThrow(PermissionError);
    expect(() => store.createCard({ title: "   " }, human)).toThrow(ValidationError);
  });

  it("accepts scheduledFor at creation time", () => {
    const card = store.createCard({ title: "future task", scheduledFor: "2030-01-01" }, human);
    expect(card.scheduledFor).toBe("2030-01-01");
  });
});

describe("transitionCard", () => {
  it("walks the delegated lifecycle: inbox → staging → active → staging → log", () => {
    const card = delegatedCard();
    expect(card.state).toBe("active");

    const reviewed = store.transitionCard(card.id, "staging", agent, "done; next: ship it");
    expect(reviewed.state).toBe("staging");

    const logged = store.transitionCard(card.id, "log", human, "looks good");
    expect(logged.state).toBe("log");
  });

  it("fails closed on a domain denial and writes nothing", () => {
    const card = store.createCard({ title: "capture" }, human);
    expect(() => store.transitionCard(card.id, "staging", agent)).toThrow(PermissionError);
    expect(store.getCard(card.id)!.state).toBe("inbox");
    expect(store.listEvents(card.id)).toHaveLength(1); // just card_created
  });

  it("requires the note the domain flags as required", () => {
    const card = delegatedCard();
    expect(() => store.transitionCard(card.id, "staging", agent)).toThrow(ValidationError);
    expect(() => store.transitionCard(card.id, "staging", agent, "  ")).toThrow(ValidationError);
    expect(store.getCard(card.id)!.state).toBe("active");
  });

  it("lets an agent auto-close only under the auto policy, with a summary", () => {
    const card = delegatedCard();
    expect(() => store.transitionCard(card.id, "log", agent, "did it")).toThrow(PermissionError);

    store.setReviewPolicy(card.id, "auto", human);
    expect(() => store.transitionCard(card.id, "log", agent)).toThrow(ValidationError);
    expect(store.transitionCard(card.id, "log", agent, "ran clean").state).toBe("log");
  });

  it("tracks pausedFrom through a block and resume round-trip", () => {
    const card = delegatedCard();
    const blocked = store.transitionCard(card.id, "blocked", agent, "need repo access");
    expect(blocked.pausedFrom).toBe("active");

    expect(() => store.transitionCard(card.id, "staging", agent)).toThrow(PermissionError);

    const resumed = store.transitionCard(card.id, "active", agent);
    expect(resumed.state).toBe("active");
    expect(resumed.pausedFrom).toBeNull();
  });

  it("records the ownership regime on each transition event", () => {
    const card = delegatedCard();
    const events = store.listEvents(card.id);
    const pickup = events.at(-1)!;
    expect(pickup).toMatchObject({
      type: "state_transitioned",
      fromState: "staging",
      toState: "active",
      actorId: "agent-1",
      actorType: "agent",
      executor: "agent",
      reviewPolicy: "reviewed",
    });
  });

  it("throws NotFoundError for a missing card", () => {
    expect(() => store.transitionCard("nope", "staging", human)).toThrow(NotFoundError);
  });
});

describe("single-occupancy on active", () => {
  it("allows moving the first card to active", () => {
    const card = delegatedCard("staging");
    expect(() => store.transitionCard(card.id, "active", agent)).not.toThrow();
  });

  it("rejects a second card when the executor already has one active — 409", () => {
    delegatedCard(); // first card is active
    const second = delegatedCard("staging");
    expect(() => store.transitionCard(second.id, "active", agent)).toThrow(ConflictError);
  });

  it("allows moving to active after the first card is paused", () => {
    const first = delegatedCard();
    store.transitionCard(first.id, "blocked", agent, "waiting on access");
    const second = delegatedCard("staging");
    expect(() => store.transitionCard(second.id, "active", agent)).not.toThrow();
  });

  it("allows moving to active after the first card reaches log", () => {
    const first = delegatedCard();
    store.setReviewPolicy(first.id, "auto", human);
    store.transitionCard(first.id, "log", agent, "done");
    const second = delegatedCard("staging");
    expect(() => store.transitionCard(second.id, "active", agent)).not.toThrow();
  });
});

describe("executor and review policy", () => {
  it("only a human changes them; changes are audit events", () => {
    const card = store.createCard({ title: "capture" }, human);
    expect(() => store.setExecutor(card.id, "agent", agent)).toThrow(PermissionError);
    expect(() => store.setReviewPolicy(card.id, "auto", agent)).toThrow(PermissionError);

    store.setExecutor(card.id, "agent", human, "offloading");
    store.setReviewPolicy(card.id, "auto", human);

    const events = store.listEvents(card.id);
    const executorChange = events[1]!;
    const policyChange = events[2]!;
    expect(executorChange).toMatchObject({
      type: "executor_changed",
      actorType: "human",
      executor: "agent",
      note: "offloading",
      payload: { from: "unassigned", to: "agent" },
    });
    expect(policyChange!).toMatchObject({
      type: "review_policy_changed",
      reviewPolicy: "auto",
      payload: { from: "reviewed", to: "auto" },
    });
  });

  it("rejects a no-op change", () => {
    const card = store.createCard({ title: "capture" }, human);
    expect(() => store.setExecutor(card.id, "unassigned", human)).toThrow(ValidationError);
    expect(() => store.setReviewPolicy(card.id, "reviewed", human)).toThrow(ValidationError);
  });
});

describe("setScheduledFor", () => {
  it("sets and clears the scheduled date, recording events", () => {
    const card = store.createCard({ title: "future task" }, human);
    const scheduled = store.setScheduledFor(card.id, "2030-06-01", human);
    expect(scheduled.scheduledFor).toBe("2030-06-01");

    const events = store.listEvents(card.id);
    expect(events.at(-1)).toMatchObject({
      type: "scheduled_for_changed",
      payload: { from: null, to: "2030-06-01" },
    });

    const cleared = store.setScheduledFor(card.id, null, human);
    expect(cleared.scheduledFor).toBeNull();
  });

  it("only a human may set the scheduled date", () => {
    const card = store.createCard({ title: "task" }, human);
    expect(() => store.setScheduledFor(card.id, "2030-01-01", agent)).toThrow(PermissionError);
  });

  it("refuses scheduling a terminal card", () => {
    const card = store.createCard({ title: "task" }, human);
    store.transitionCard(card.id, "cancelled", human);
    expect(() => store.setScheduledFor(card.id, "2030-01-01", human)).toThrow(ValidationError);
  });
});

describe("promoteScheduled", () => {
  it("promotes inbox cards whose scheduledFor date has arrived", () => {
    store.createCard({ title: "past due", scheduledFor: "2020-01-01" }, human);
    store.createCard({ title: "future task", scheduledFor: "2099-01-01" }, human);
    store.createCard({ title: "no date" }, human);

    const promoted = store.promoteScheduled("2026-01-01");
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.title).toBe("past due");
    expect(promoted[0]!.state).toBe("staging");
  });

  it("does not double-promote a card already in staging", () => {
    const card = store.createCard({ title: "task", scheduledFor: "2020-01-01" }, human);
    store.transitionCard(card.id, "staging", human);
    const promoted = store.promoteScheduled("2026-01-01");
    expect(promoted).toHaveLength(0);
  });
});

describe("annotations", () => {
  it("any actor may annotate any card without transition permission", () => {
    const card = store.createCard({ title: "the human's card" }, human);
    const annotation = store.addAnnotation(card.id, "I could take this", agent);
    expect(annotation).toMatchObject({
      type: "annotation_added",
      actorId: "agent-1",
      note: "I could take this",
    });
    expect(store.getCard(card.id)!.updatedAt).toBe(card.updatedAt);
  });

  it("requires a non-empty note", () => {
    const card = store.createCard({ title: "capture" }, human);
    expect(() => store.addAnnotation(card.id, " ", agent)).toThrow(ValidationError);
  });
});

describe("updateCard", () => {
  it("lets a human edit title and description, recording a card_updated event", () => {
    const card = store.createCard({ title: "draft", description: "rough" }, human);
    const updated = store.updateCard(card.id, { title: "refined" }, human);
    expect(updated).toMatchObject({ title: "refined", description: "rough" });

    const events = store.listEvents(card.id);
    expect(events.at(-1)).toMatchObject({
      type: "card_updated",
      actorType: "human",
      payload: { title: "refined", description: "rough" },
    });
  });

  it("refuses agent edits — the definition is what the human reviews", () => {
    const card = delegatedCard();
    expect(() => store.updateCard(card.id, { title: "rewritten" }, agent)).toThrow(PermissionError);
  });

  it("refuses empty edits, blank titles, and edits to terminal cards", () => {
    const card = store.createCard({ title: "x" }, human);
    expect(() => store.updateCard(card.id, {}, human)).toThrow(ValidationError);
    expect(() => store.updateCard(card.id, { title: "  " }, human)).toThrow(ValidationError);

    store.transitionCard(card.id, "cancelled", human);
    expect(() => store.updateCard(card.id, { title: "y" }, human)).toThrow(ValidationError);
  });
});

describe("listCards", () => {
  it("filters by state and executor", () => {
    store.createCard({ title: "a" }, human);
    const b = delegatedCard("staging");
    expect(store.listCards()).toHaveLength(2);
    expect(store.listCards({ state: "inbox" }).map((c) => c.title)).toEqual(["a"]);
    expect(store.listCards({ state: "staging", executor: "agent" }).map((c) => c.id)).toEqual([b.id]);
    expect(store.listCards({ state: "log" })).toEqual([]);
  });
});

describe("labels", () => {
  it("cards start with null labels and focus=false by default", () => {
    const card = store.createCard({ title: "plain" }, human);
    expect(card.labels).toEqual({ category: null, focus: false, pendingTier: null });
  });

  it("labels can be set at creation time", () => {
    const card = store.createCard(
      { title: "project", category: "professional", focus: true, pendingTier: "white-whale" },
      human,
    );
    expect(card.labels).toEqual({ category: "professional", focus: true, pendingTier: "white-whale" });
  });

  it("setLabels updates label facets and records a labels_changed event", () => {
    const card = store.createCard({ title: "task" }, human);
    const updated = store.setLabels(card.id, { category: "personal", focus: true }, human);
    expect(updated.labels).toEqual({ category: "personal", focus: true, pendingTier: null });

    const events = store.listEvents(card.id);
    expect(events.at(-1)).toMatchObject({
      type: "labels_changed",
      actorType: "human",
      payload: { category: "personal", focus: true, pendingTier: null },
    });
  });

  it("setLabels is partial — omitted facets are preserved", () => {
    const card = store.createCard(
      { title: "task", category: "community", pendingTier: "daydream" },
      human,
    );
    const updated = store.setLabels(card.id, { focus: true }, human);
    expect(updated.labels).toEqual({ category: "community", focus: true, pendingTier: "daydream" });
  });

  it("null clears a label facet", () => {
    const card = store.createCard({ title: "task", category: "personal" }, human);
    const updated = store.setLabels(card.id, { category: null }, human);
    expect(updated.labels.category).toBeNull();
  });

  it("only a human may change labels", () => {
    const card = store.createCard({ title: "task" }, human);
    expect(() => store.setLabels(card.id, { focus: true }, agent)).toThrow(PermissionError);
  });

  it("cannot label a terminal card", () => {
    const card = store.createCard({ title: "task" }, human);
    store.transitionCard(card.id, "cancelled", human);
    expect(() => store.setLabels(card.id, { focus: true }, human)).toThrow(ValidationError);
  });

  it("rejects an empty label update", () => {
    const card = store.createCard({ title: "task" }, human);
    expect(() => store.setLabels(card.id, {}, human)).toThrow(ValidationError);
  });

  it("listCards filters by category and focus", () => {
    store.createCard({ title: "a", category: "professional", focus: true }, human);
    store.createCard({ title: "b", category: "personal" }, human);
    store.createCard({ title: "c" }, human);

    expect(store.listCards({ category: "professional" }).map((c) => c.title)).toEqual(["a"]);
    expect(store.listCards({ focus: true }).map((c) => c.title)).toEqual(["a"]);
    expect(store.listCards({ focus: false })).toHaveLength(2);
  });
});

describe("rebuildProjection", () => {
  it("reconstructs the cards table from the event log alone", () => {
    const finished = delegatedCard();
    store.transitionCard(finished.id, "staging", agent, "summary; next steps");
    store.transitionCard(finished.id, "log", human, "approved");

    const paused = delegatedCard();
    store.transitionCard(paused.id, "blocked", agent, "need credentials");

    const captured = store.createCard({ title: "idea", description: "raw" }, agent);
    store.addAnnotation(captured.id, "I could take this", agent);
    store.updateCard(captured.id, { title: "sharper idea" }, human);

    const before = store.listCards();
    db.prepare("UPDATE cards SET state = 'inbox', executor = 'unassigned'").run();
    rebuildProjection(db);
    expect(store.listCards()).toEqual(before);
  });

  it("reconstructs scheduledFor from scheduled_for_changed events", () => {
    const card = store.createCard({ title: "future" }, human);
    store.setScheduledFor(card.id, "2030-01-01", human);

    const before = store.listCards();
    db.prepare("UPDATE cards SET scheduled_for = NULL").run();
    rebuildProjection(db);
    expect(store.listCards()).toEqual(before);
  });

  it("reconstructs labels (including labels_changed events) correctly", () => {
    const card = store.createCard({ title: "project", category: "professional" }, human);
    store.setLabels(card.id, { focus: true, pendingTier: "white-whale" }, human);
    store.setLabels(card.id, { pendingTier: null }, human);

    const before = store.listCards();
    db.prepare("UPDATE cards SET category = NULL, focus = 0, pending_tier = NULL").run();
    rebuildProjection(db);
    expect(store.listCards()).toEqual(before);
  });
});
