/**
 * The card state machine: states, actors, and — the core contract — who may
 * trigger each transition. Pure functions, no I/O. The API layer enforces
 * these decisions and must fail closed on `allowed: false`, never coerce a
 * request into an allowed transition.
 *
 * Mental model: Inbox = storage, Staging = today's list, Active = CPU (one
 * at a time), Log = history. Human and agent tracks share Staging: agent-
 * completed work routes there for the human to review before closing to Log.
 *
 * Source of truth: docs/state-machine.md. Keep the two in sync.
 */

export const CARD_STATES = [
  "inbox",
  "staging",
  "active",
  "log",
  "blocked",
  "waiting",
  "cancelled",
] as const;

export type CardState = (typeof CARD_STATES)[number];

export type ActorType = "human" | "agent" | "system";

export const EXECUTORS = ["human", "agent", "unassigned"] as const;
export type ExecutorType = (typeof EXECUTORS)[number];

export const REVIEW_POLICIES = ["reviewed", "auto"] as const;
export type ReviewPolicy = (typeof REVIEW_POLICIES)[number];

export const CATEGORIES = ["professional", "community", "personal"] as const;
export type Category = (typeof CATEGORIES)[number];

export const PENDING_TIERS = ["daydream", "white-whale"] as const;
export type PendingTier = (typeof PENDING_TIERS)[number];

export interface Labels {
  category: Category | null;
  focus: boolean;
  pendingTier: PendingTier | null;
}

export interface Actor {
  type: ActorType;
}

/** The slice of a card that transition permissions depend on. */
export interface TransitionCard {
  state: CardState;
  executor: ExecutorType;
  reviewPolicy: ReviewPolicy;
  /** For blocked/waiting cards: the state the card was paused from. */
  pausedFrom?: CardState;
}

/**
 * `noteRequired` marks transitions that must carry a note: an agent routing
 * work to staging for review (summary + next steps), an agent auto-closing
 * (completion summary), a human sending work back from staging (rework
 * reason), and every staging→inbox re-scope.
 */
export type TransitionDecision =
  | { allowed: true; noteRequired: boolean }
  | { allowed: false; reason: string };

const TERMINAL_STATES: readonly CardState[] = ["log", "cancelled"];
const PAUSABLE_STATES: readonly CardState[] = ["staging", "active"];

export function isTerminal(state: CardState): boolean {
  return TERMINAL_STATES.includes(state);
}

function allow(noteRequired = false): TransitionDecision {
  return { allowed: true, noteRequired };
}

function deny(reason: string): TransitionDecision {
  return { allowed: false, reason };
}

function isExecutor(card: TransitionCard, actor: Actor): boolean {
  return actor.type !== "system" && card.executor === actor.type;
}

/** Card creation (into inbox): human capture or agent-proposed work. */
export function canCreateCard(actor: Actor): boolean {
  return actor.type === "human" || actor.type === "agent";
}

/**
 * Executor assignment is the human's act. An agent may volunteer via
 * annotation but never assign work to itself or shed work it was given.
 */
export function canChangeExecutor(actor: Actor): boolean {
  return actor.type === "human";
}

/**
 * Only a human grants or revokes the `auto` review policy. Marking a task
 * `auto` is the review, amortized up front.
 */
export function canChangeReviewPolicy(actor: Actor): boolean {
  return actor.type === "human";
}

/**
 * Card definition (title/description) is human-only. Agents propose edits
 * via annotation so the definition remains what the human triaged/approved.
 */
export function canEditCard(actor: Actor): boolean {
  return actor.type === "human";
}

/** Label changes (category, focus, pending-tier) are the human's planning act. */
export function canChangeLabels(actor: Actor): boolean {
  return actor.type === "human";
}

/**
 * Setting or clearing a scheduled date (scheduledFor) is human-only.
 * The system uses this date to auto-promote inbox cards to staging when the
 * date arrives, but only a human may set or change the date itself.
 */
export function canScheduleCard(actor: Actor): boolean {
  return actor.type === "human";
}

export function canTransition(
  card: TransitionCard,
  to: CardState,
  actor: Actor,
): TransitionDecision {
  const from = card.state;

  if (isTerminal(from)) return deny(`${from} is terminal; no transitions out`);
  if (from === to) return deny(`card is already ${to}`);

  // Any non-terminal state → cancelled: human only.
  if (to === "cancelled") {
    return actor.type === "human" ? allow() : deny("only a human may cancel a card");
  }

  // Pausing: staging/active → blocked or waiting.
  if (to === "blocked" || to === "waiting") {
    if (!PAUSABLE_STATES.includes(from)) return deny(`cannot pause a card from ${from}`);
    const permitted =
      isExecutor(card, actor) ||
      actor.type === "human" ||
      (to === "waiting" && actor.type === "system");
    if (!permitted) return deny(`${actor.type} may not move this card to ${to}`);
    // An agent flagging a blocker must say what is needed to unblock.
    return allow(to === "blocked" && actor.type === "agent");
  }

  // Resuming: a paused card returns only to the state it was paused from.
  if (from === "blocked" || from === "waiting") {
    if (card.pausedFrom === undefined) return deny("card has no recorded state to resume to");
    if (to !== card.pausedFrom) {
      return deny(`a ${from} card resumes to ${card.pausedFrom}, not ${to}`);
    }
    const permitted =
      isExecutor(card, actor) ||
      actor.type === "human" ||
      (from === "waiting" && actor.type === "system");
    return permitted ? allow() : deny(`${actor.type} may not resume this card`);
  }

  switch (from) {
    case "inbox":
      // Scheduling a card into today's list is the human's planning act.
      if (to === "staging") {
        return actor.type === "human" ? allow() : deny("scheduling is human-only");
      }
      break;

    case "staging":
      if (to === "active") {
        // The executor picks up their own staged work.
        if (isExecutor(card, actor)) return allow();
        // The human sends agent-completed work back for rework (note required).
        if (actor.type === "human" && card.executor === "agent") return allow(true);
        return deny(`${actor.type} may not move this card to active`);
      }
      // Human approves agent-completed work, or closes their own staged card
      // that turned out to be trivial.
      if (to === "log") {
        return actor.type === "human" ? allow() : deny("only a human may close work from staging");
      }
      // Human re-scopes back to inbox (note required — say why).
      if (to === "inbox") {
        return actor.type === "human" ? allow(true) : deny("re-scoping is human-only");
      }
      break;

    case "active":
      if (to === "log") {
        if (card.executor === "human") {
          return isExecutor(card, actor)
            ? allow()
            : deny("only the human closes their own work");
        }
        if (card.executor === "agent") {
          if (!isExecutor(card, actor)) {
            return deny("delegated work closes through staging review");
          }
          // Auto-policy agents close directly; reviewed agents must route through staging.
          return card.reviewPolicy === "auto"
            ? allow(true)
            : deny("a reviewed card must route through staging for human review");
        }
        return deny("an unassigned card cannot be completed");
      }
      // Agent routes completed work to staging for human review. An auto card
      // may always escalate here — asking for review only tightens supervision.
      if (to === "staging") {
        if (card.executor !== "agent") {
          return deny("only agent-executed cards route through staging review");
        }
        return isExecutor(card, actor)
          ? allow(true)
          : deny("only the executing agent submits work for review");
      }
      break;
  }

  return deny(`no transition from ${from} to ${to}`);
}
