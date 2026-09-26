/**
 * Board UI routes. Serves a server-rendered HTML board; auth via
 * `?t=TOKEN` query param (stored in the URL the user bookmarks).
 * Actions are plain HTML form POSTs that redirect back to the board.
 * No JavaScript required.
 *
 * Access: GET /board?t=YOUR_HUMAN_TOKEN
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Card, CardStore } from "../persistence/card-store.js";
import { PermissionError, ConflictError, ValidationError, NotFoundError } from "../persistence/card-store.js";
import type { Credential } from "./actor.js";
import { UnauthorizedError } from "./actor.js";
import type { CardState } from "../domain/state-machine.js";
import type { StoreActor } from "../persistence/card-store.js";

export interface BoardRoutesOptions {
  store: CardStore;
  credentials: Credential[];
}

export async function boardRoutes(
  app: FastifyInstance,
  { store, credentials }: BoardRoutesOptions,
): Promise<void> {
  const byToken = new Map<string, StoreActor>();
  for (const c of credentials) {
    byToken.set(c.token, { id: c.id, type: c.type });
  }

  function resolveActor(req: FastifyRequest): StoreActor {
    const t = (req.query as Record<string, string>).t ?? "";
    const token = t.trim() || (req.headers.authorization ?? "").replace(/^Bearer /, "").trim();
    const actor = byToken.get(token);
    if (!actor) throw new UnauthorizedError("authorization required: ?t=TOKEN or Bearer header");
    return { ...actor };
  }

  const redirect = (reply: import("fastify").FastifyReply, t: string, error?: string) => {
    const url = error
      ? `/board?t=${encodeURIComponent(t)}&error=${encodeURIComponent(error)}`
      : `/board?t=${encodeURIComponent(t)}`;
    return reply.redirect(url);
  };

  // ── GET /board ──────────────────────────────────────────────────────────

  app.get("/board", async (req, reply) => {
    let actor: StoreActor;
    try {
      actor = resolveActor(req);
    } catch {
      return reply
        .code(401)
        .header("Content-Type", "text/html; charset=utf-8")
        .send(loginPage());
    }

    const t = String((req.query as Record<string, string | undefined>).t ?? "");
    const error = String((req.query as Record<string, string | undefined>).error ?? "");
    const all = store.listCards();
    const today = new Date().toISOString().slice(0, 10);

    const html = renderPage(renderBoard(all, t, today, error), t);
    return reply.header("Content-Type", "text/html; charset=utf-8").send(html);
  });

  // ── POST /board/action/* ────────────────────────────────────────────────

  async function boardAction(
    req: FastifyRequest,
    reply: import("fastify").FastifyReply,
    fn: (actor: StoreActor, body: Record<string, string>) => void,
  ) {
    let actor: StoreActor;
    try {
      actor = resolveActor(req);
    } catch {
      return reply.code(401).send("unauthorized");
    }
    const t = String((req.query as Record<string, string | undefined>).t ?? "");
    const body = (req.body ?? {}) as Record<string, string>;
    try {
      fn(actor, body);
    } catch (err) {
      const msg =
        err instanceof PermissionError ||
        err instanceof ValidationError ||
        err instanceof ConflictError ||
        err instanceof NotFoundError
          ? (err as Error).message
          : "unexpected error";
      return redirect(reply, t, msg);
    }
    return redirect(reply, t);
  }

  app.post<{ Params: { id: string } }>(
    "/board/action/transition/:id",
    {},
    async (req, reply) =>
      boardAction(req, reply, (actor, body) => {
        store.transitionCard(req.params.id, body.to as CardState, actor, body.note || undefined);
      }),
  );

  app.post<{ Params: { id: string } }>(
    "/board/action/executor/:id",
    {},
    async (req, reply) =>
      boardAction(req, reply, (actor, body) => {
        store.setExecutor(req.params.id, body.executor as "human" | "agent" | "unassigned", actor);
      }),
  );

  app.post<{ Params: { id: string } }>(
    "/board/action/schedule/:id",
    {},
    async (req, reply) =>
      boardAction(req, reply, (actor, body) => {
        store.setScheduledFor(req.params.id, body.scheduledFor || null, actor);
      }),
  );

  app.post(
    "/board/action/create",
    {},
    async (req, reply) =>
      boardAction(req, reply, (actor, body) => {
        store.createCard(
          {
            title: body.title ?? "",
            description: body.description || undefined,
            scheduledFor: body.scheduledFor || undefined,
          },
          actor,
        );
      }),
  );

  app.post(
    "/board/action/promote",
    {},
    async (req, reply) =>
      boardAction(req, reply, () => {
        store.promoteScheduled();
      }),
  );

  app.post<{ Params: { id: string } }>(
    "/board/action/annotate/:id",
    {},
    async (req, reply) =>
      boardAction(req, reply, (actor, body) => {
        store.addAnnotation(req.params.id, body.note ?? "", actor);
      }),
  );
}

// ── HTML helpers ──────────────────────────────────────────────────────────

function e(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function a(url: string, t: string): string {
  return `${url}?t=${encodeURIComponent(t)}`;
}

function badge(text: string, cls = ""): string {
  return `<span class="badge ${e(cls)}">${e(text)}</span>`;
}

function btn(label: string, cls = ""): string {
  return `<button class="btn ${e(cls)}" type="submit">${e(label)}</button>`;
}

function actionForm(action: string, t: string, fields: Record<string, string>, label: string, btnCls = ""): string {
  const hidden = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${e(k)}" value="${e(v)}">`)
    .join("");
  return `<form method="post" action="${e(a(action, t))}">${hidden}${btn(label, btnCls)}</form>`;
}

function noteForm(action: string, t: string, fields: Record<string, string>, placeholder: string, label: string, btnCls = ""): string {
  const hidden = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${e(k)}" value="${e(v)}">`)
    .join("");
  return `<form method="post" action="${e(a(action, t))}" class="note-form" style="display:flex;gap:4px;margin-top:4px;">
    ${hidden}
    <input type="text" name="note" placeholder="${e(placeholder)}" required>
    ${btn(label, btnCls)}
  </form>`;
}

function renderCardMeta(card: Card, today: string): string {
  const parts: string[] = [];
  const exec = card.executor !== "unassigned" ? card.executor : null;
  if (exec) parts.push(badge(exec === "human" ? "You" : "Agent", `executor-${exec}`));
  if (card.scheduledFor) {
    const isFuture = card.scheduledFor > today;
    parts.push(badge(`📅 ${card.scheduledFor}`, isFuture ? "scheduled" : "scheduled"));
  }
  if (card.labels.focus) parts.push(badge("★ focus", "focus-star"));
  if (card.labels.category) parts.push(badge(card.labels.category, "category"));
  if (card.labels.pendingTier) {
    const tc = card.labels.pendingTier === "white-whale" ? "tier-whale" : "tier-daydream";
    parts.push(badge(card.labels.pendingTier, tc));
  }
  if (card.pausedFrom) parts.push(badge(`← ${card.pausedFrom}`, "paused-from"));
  return parts.length > 0 ? `<div class="card-meta">${parts.join("")}</div>` : "";
}

function renderCardActions(card: Card, t: string, today: string): string {
  const id = card.id;
  const acts: string[] = [];

  switch (card.state) {
    case "inbox":
      if (card.executor === "unassigned") {
        acts.push(actionForm(`/board/action/executor/${id}`, t, { executor: "human" }, "→ Mine"));
        acts.push(actionForm(`/board/action/executor/${id}`, t, { executor: "agent" }, "→ Agent"));
      } else {
        acts.push(actionForm(`/board/action/transition/${id}`, t, { to: "staging" }, "→ Today", "primary"));
      }
      acts.push(actionForm(`/board/action/transition/${id}`, t, { to: "cancelled" }, "✕", "danger"));
      break;

    case "staging":
      if (card.executor === "human") {
        acts.push(actionForm(`/board/action/transition/${id}`, t, { to: "active" }, "▶ Start", "primary"));
        acts.push(actionForm(`/board/action/transition/${id}`, t, { to: "log" }, "✓ Close", "success"));
        acts.push(actionForm(`/board/action/transition/${id}`, t, { to: "inbox" }, "← Inbox", "muted"));
      } else if (card.executor === "agent") {
        // Agent staging — could be "ready to start" or "awaiting review"
        acts.push(actionForm(`/board/action/transition/${id}`, t, { to: "log" }, "✓ Approve", "success"));
        acts.push(noteForm(`/board/action/transition/${id}`, t, { to: "active" }, "reason for rework…", "↩ Rework"));
        acts.push(noteForm(`/board/action/transition/${id}`, t, { to: "inbox" }, "why rescoping…", "← Inbox"));
      }
      acts.push(actionForm(`/board/action/transition/${id}`, t, { to: "cancelled" }, "✕", "danger"));
      break;

    case "active":
      if (card.executor === "human") {
        acts.push(actionForm(`/board/action/transition/${id}`, t, { to: "log" }, "✓ Done", "success"));
        acts.push(noteForm(`/board/action/transition/${id}`, t, { to: "blocked" }, "what's blocking you…", "⊘ Block"));
        acts.push(actionForm(`/board/action/transition/${id}`, t, { to: "waiting" }, "⏸ Wait"));
      } else if (card.executor === "agent") {
        // Agent controls active via API; human can block/cancel
        acts.push(noteForm(`/board/action/transition/${id}`, t, { to: "blocked" }, "reason…", "⊘ Block"));
        acts.push(actionForm(`/board/action/transition/${id}`, t, { to: "waiting" }, "⏸ Wait"));
      }
      acts.push(actionForm(`/board/action/transition/${id}`, t, { to: "cancelled" }, "✕", "danger"));
      break;

    case "blocked":
    case "waiting": {
      const resumeTo = card.pausedFrom ?? "staging";
      acts.push(actionForm(`/board/action/transition/${id}`, t, { to: resumeTo }, "▶ Resume", "primary"));
      acts.push(actionForm(`/board/action/transition/${id}`, t, { to: "cancelled" }, "✕", "danger"));
      break;
    }
  }

  return acts.length > 0 ? `<div class="card-actions">${acts.join("")}</div>` : "";
}

function renderCard(card: Card, t: string, today: string, extraClass = ""): string {
  const isFuture = card.scheduledFor != null && card.scheduledFor > today;
  const classes = [
    "card",
    card.executor !== "unassigned" ? card.executor : "",
    isFuture ? "future" : "",
    card.labels.focus ? "focused" : "",
    extraClass,
  ]
    .filter(Boolean)
    .join(" ");

  return `<div class="${classes}">
  <div class="card-title">${e(card.title)}</div>
  ${renderCardMeta(card, today)}
  ${renderCardActions(card, t, today)}
</div>`;
}

function column(header: string, cards: Card[], t: string, today: string, opts: {
  active?: boolean;
  footer?: string;
} = {}): string {
  const cardsHtml = cards.length > 0
    ? cards.map((c) => renderCard(c, t, today)).join("")
    : `<div class="empty">—</div>`;
  return `<div class="column${opts.active ? " active-slot" : ""}">
  <div class="column-header"><span>${e(header)}</span><span>${cards.length}</span></div>
  ${cardsHtml}
  ${opts.footer ?? ""}
</div>`;
}

function track(label: string, labelClass: string, cols: string[]): string {
  return `<div class="section">
  <div class="section-title"><span class="${e(labelClass)}">${e(label)}</span></div>
  <div class="columns">${cols.join("")}</div>
</div>`;
}

function renderBoard(all: Card[], t: string, today: string, error: string): string {
  const byState = (state: CardState) => all.filter((c) => c.state === state);
  const byStateExec = (state: CardState, exec: string) =>
    all.filter((c) => c.state === state && c.executor === exec);

  const unassignedInbox = byStateExec("inbox", "unassigned");
  const humanInbox    = byStateExec("inbox", "human");
  const humanStaging  = byStateExec("staging", "human");
  const humanActive   = byStateExec("active", "human");
  const agentInbox    = byStateExec("inbox", "agent");
  const agentStaging  = byStateExec("staging", "agent");
  const agentActive   = byStateExec("active", "agent");
  const paused        = [...byState("blocked"), ...byState("waiting")];
  const logCards      = [...byState("log"), ...byState("cancelled")];

  const createForm = `<div class="create-form">
  <form method="post" action="${e(a("/board/action/create", t))}">
    <input type="text" name="title" placeholder="Capture…" required>
    <button class="btn primary" type="submit" style="width:100%">+ Add</button>
  </form>
</div>`;

  const flashHtml = error
    ? `<div class="flash error">${e(error)}</div>`
    : "";

  const promoteBtn = `<form method="post" action="${e(a("/board/action/promote", t))}">
  <button class="btn muted" type="submit">↑ Promote Scheduled</button>
</form>`;

  return `${flashHtml}
${track("Capture", "", [
  column("Unassigned", unassignedInbox, t, today, { footer: createForm }),
])}
${track("You", "track-human", [
  column("Inbox", humanInbox, t, today),
  column("Staging (Today)", humanStaging, t, today),
  column("Active", humanActive, t, today, { active: true }),
])}
${track("Agent", "track-agent", [
  column("Inbox", agentInbox, t, today),
  column("Staging / Review", agentStaging, t, today),
  column("Active", agentActive, t, today, { active: true }),
])}
${
  paused.length > 0
    ? `<div class="section">
  <div class="section-title">Paused</div>
  <div class="columns">${paused.map((c) => `<div>${renderCard(c, t, today)}</div>`).join("")}</div>
</div>`
    : ""
}
<details class="log-section">
  <summary>Log (${logCards.length})</summary>
  <div class="log-grid">${logCards.map((c) => renderCard(c, t, today, "log")).join("")}</div>
</details>
${promoteBtn}`;
}

function renderPage(body: string, _t: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Board</title>
  <link rel="stylesheet" href="/board.css">
</head>
<body>
  <div class="board-header">
    <h1>Board</h1>
  </div>
  <main>${body}</main>
</body>
</html>`;
}

function loginPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Board — Login</title>
  <link rel="stylesheet" href="/board.css">
</head>
<body style="display:flex;align-items:center;justify-content:center;min-height:100vh;">
  <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:32px;width:320px;">
    <h2 style="margin-bottom:16px;font-size:16px;">Board Access</h2>
    <form method="get" action="/board">
      <input type="password" name="t" placeholder="Token" required
        style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--surface2);color:var(--text);margin-bottom:10px;font-size:13px;">
      <button type="submit" class="btn primary" style="width:100%">Open Board</button>
    </form>
  </div>
</body>
</html>`;
}
