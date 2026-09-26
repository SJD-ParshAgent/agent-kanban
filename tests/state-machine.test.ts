import { describe, expect, it } from "vitest";
import {
  CARD_STATES,
  canChangeExecutor,
  canChangeReviewPolicy,
  canCreateCard,
  canTransition,
  isTerminal,
  type Actor,
  type CardState,
  type TransitionCard,
} from "../src/domain/state-machine.js";

const human: Actor = { type: "human" };
const agent: Actor = { type: "agent" };
const system: Actor = { type: "system" };

function card(state: CardState, overrides: Partial<TransitionCard> = {}): TransitionCard {
  return { state, executor: "unassigned", reviewPolicy: "reviewed", ...overrides };
}

function expectAllowed(
  c: TransitionCard,
  to: CardState,
  actor: Actor,
  noteRequired = false,
): void {
  expect(canTransition(c, to, actor)).toEqual({ allowed: true, noteRequired });
}

function expectDenied(c: TransitionCard, to: CardState, actor: Actor): void {
  const decision = canTransition(c, to, actor);
  expect(decision.allowed).toBe(false);
}

describe("creation and governance", () => {
  it("humans and agents may create cards; the system may not", () => {
    expect(canCreateCard(human)).toBe(true);
    expect(canCreateCard(agent)).toBe(true);
    expect(canCreateCard(system)).toBe(false);
  });

  it("executor changes are human-only", () => {
    expect(canChangeExecutor(human)).toBe(true);
    expect(canChangeExecutor(agent)).toBe(false);
    expect(canChangeExecutor(system)).toBe(false);
  });

  it("review-policy changes are human-only", () => {
    expect(canChangeReviewPolicy(human)).toBe(true);
    expect(canChangeReviewPolicy(agent)).toBe(false);
    expect(canChangeReviewPolicy(system)).toBe(false);
  });
});

describe("inbox → staging (human schedules work for today)", () => {
  it("human may schedule any inbox card", () => {
    expectAllowed(card("inbox", { executor: "human" }), "staging", human);
    expectAllowed(card("inbox", { executor: "agent" }), "staging", human);
    expectAllowed(card("inbox", { executor: "unassigned" }), "staging", human);
  });

  it("agent and system may not schedule", () => {
    expectDenied(card("inbox", { executor: "agent" }), "staging", agent);
    expectDenied(card("inbox", { executor: "agent" }), "staging", system);
  });
});

describe("staging → active (executor picks up)", () => {
  it("the executor picks up their own staged work", () => {
    expectAllowed(card("staging", { executor: "human" }), "active", human);
    expectAllowed(card("staging", { executor: "agent" }), "active", agent);
  });

  it("human may send agent-completed staging work back for rework (note required)", () => {
    expectAllowed(card("staging", { executor: "agent" }), "active", human, true);
  });

  it("agent may not pick up a human card", () => {
    expectDenied(card("staging", { executor: "human" }), "active", agent);
  });

  it("system may not pick up cards", () => {
    expectDenied(card("staging", { executor: "human" }), "active", system);
    expectDenied(card("staging", { executor: "agent" }), "active", system);
  });

  it("unassigned cards cannot be picked up", () => {
    expectDenied(card("staging", { executor: "unassigned" }), "active", human);
    expectDenied(card("staging", { executor: "unassigned" }), "active", agent);
  });
});

describe("staging → log (human closes or approves)", () => {
  it("human may close their own staged work directly", () => {
    expectAllowed(card("staging", { executor: "human" }), "log", human);
  });

  it("human may approve agent-completed work from staging", () => {
    expectAllowed(card("staging", { executor: "agent" }), "log", human);
  });

  it("agent may not close work from staging", () => {
    expectDenied(card("staging", { executor: "agent" }), "log", agent);
    expectDenied(card("staging", { executor: "human" }), "log", agent);
  });
});

describe("staging → inbox (human re-scopes, note required)", () => {
  it("human may re-scope any staged card back to inbox", () => {
    expectAllowed(card("staging", { executor: "human" }), "inbox", human, true);
    expectAllowed(card("staging", { executor: "agent" }), "inbox", human, true);
  });

  it("agent and system may not re-scope", () => {
    expectDenied(card("staging", { executor: "agent" }), "inbox", agent);
    expectDenied(card("staging", { executor: "agent" }), "inbox", system);
  });
});

describe("completing active work", () => {
  it("the human closes their own active work directly, no review gate", () => {
    expectAllowed(card("active", { executor: "human" }), "log", human);
  });

  it("an agent never closes human-executed work", () => {
    expectDenied(card("active", { executor: "human" }), "log", agent);
  });

  it("a reviewed agent card routes to staging for human review (note required)", () => {
    const c = card("active", { executor: "agent", reviewPolicy: "reviewed" });
    expectAllowed(c, "staging", agent, true);
    expectDenied(c, "log", agent); // may not skip the review gate
    expectDenied(c, "log", human); // human closes via staging approval, not directly
  });

  it("an auto agent card closes directly (summary still required)", () => {
    const c = card("active", { executor: "agent", reviewPolicy: "auto" });
    expectAllowed(c, "log", agent, true);
  });

  it("an auto card may always escalate into staging review", () => {
    const c = card("active", { executor: "agent", reviewPolicy: "auto" });
    expectAllowed(c, "staging", agent, true);
  });

  it("staging review is for agent-executed cards only", () => {
    expectDenied(card("active", { executor: "human" }), "staging", human);
    expectDenied(card("active", { executor: "human" }), "staging", agent);
  });

  it("a human may not push an agent's active card into staging", () => {
    expectDenied(card("active", { executor: "agent" }), "staging", human);
  });
});

describe("pausing (blocked / waiting)", () => {
  it("the executor or the human may block a card", () => {
    expectAllowed(card("staging", { executor: "human" }), "blocked", human);
    expectAllowed(card("active", { executor: "agent" }), "blocked", human);
    expectAllowed(card("active", { executor: "human" }), "blocked", human);
  });

  it("an agent blocking its own card must note what is needed", () => {
    expectAllowed(card("active", { executor: "agent" }), "blocked", agent, true);
  });

  it("an agent may not pause someone else's card", () => {
    expectDenied(card("active", { executor: "human" }), "blocked", agent);
    expectDenied(card("active", { executor: "human" }), "waiting", agent);
  });

  it("the system may park a card in waiting but not blocked", () => {
    expectAllowed(card("active", { executor: "agent" }), "waiting", system);
    expectDenied(card("active", { executor: "agent" }), "blocked", system);
  });

  it.each([["inbox"], ["log"], ["cancelled"]] as const)(
    "cards cannot pause from %s",
    (from) => {
      expectDenied(card(from, { executor: "agent" }), "blocked", human);
      expectDenied(card(from, { executor: "agent" }), "waiting", human);
    },
  );
});

describe("resuming", () => {
  it("a paused card resumes only to the state it was paused from", () => {
    const blocked = card("blocked", { executor: "agent", pausedFrom: "active" });
    expectAllowed(blocked, "active", agent);
    expectAllowed(blocked, "active", human);
    expectDenied(blocked, "staging", agent);
    expectDenied(blocked, "staging", human);
  });

  it("a card with no recorded pausedFrom cannot resume", () => {
    expectDenied(card("blocked", { executor: "agent" }), "active", human);
  });

  it("the system may resume waiting cards but not blocked ones", () => {
    expectAllowed(card("waiting", { executor: "agent", pausedFrom: "staging" }), "staging", system);
    expectDenied(card("blocked", { executor: "agent", pausedFrom: "staging" }), "staging", system);
  });

  it("an agent may not resume someone else's card", () => {
    expectDenied(card("blocked", { executor: "human", pausedFrom: "active" }), "active", agent);
  });
});

describe("cancellation", () => {
  const nonTerminal = CARD_STATES.filter((s) => !isTerminal(s));

  it.each(nonTerminal.map((s) => [s]))("%s → cancelled: human only", (from) => {
    expectAllowed(card(from, { executor: "agent" }), "cancelled", human);
    expectDenied(card(from, { executor: "agent" }), "cancelled", agent);
    expectDenied(card(from, { executor: "agent" }), "cancelled", system);
  });
});

describe("terminal states are terminal", () => {
  const actors = [human, agent, system];

  it.each([["log"], ["cancelled"]] as const)("nothing leaves %s", (from) => {
    for (const to of CARD_STATES) {
      for (const actor of actors) {
        expectDenied(card(from, { executor: "agent" }), to, actor);
      }
    }
  });
});

describe("no-ops and unknown transitions", () => {
  it("a transition to the current state is denied", () => {
    expectDenied(card("staging", { executor: "human" }), "staging", human);
  });

  it("transitions not in the table are denied", () => {
    expectDenied(card("inbox"), "active", human);  // must schedule first
    expectDenied(card("inbox"), "log", human);
    expectDenied(card("staging"), "staging", human); // no-op
    expectDenied(card("log"), "active", human);    // no reopening
    expectDenied(card("active"), "inbox", human);  // nothing jumps back to inbox
  });
});
