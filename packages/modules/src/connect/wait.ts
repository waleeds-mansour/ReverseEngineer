// A turn waiting for a connector you haven't connected (Spec 4). It leaves a card and a check
// keyed by its id; connect.wait starts its work again once you connect, reminds you once after
// about 4 hours, and gives up after a day, saying so in the brief.
import { CONNECT_PROVIDERS, type ConnectProvider, type Origin } from "@hearth/core";
import { type DbOrTx, jarvisTurn, notification, notionAccount, schedule } from "@hearth/db";
import type { NewNotification, ReflexOutcome } from "@hearth/kernel";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";

export const CONNECT_WAIT = "connect.wait";
const HOUR = 60 * 60_000;
export const REMIND_AFTER_MS = 4 * HOUR;
export const GIVE_UP_AFTER_MS = 24 * HOUR;

/** What a waiting turn keeps on its check: enough to remind you and to start its work again. */
export interface ConnectWait {
  provider: ConnectProvider;
  /** Pip's own words: a connector's fixed reason, or its own from a trusted turn. */
  why: string;
  turnId: string;
  conversationId: string | null;
  subjectId: string | null;
  lane: "fast" | "deep";
  /** A background turn's card is an interrupt, so it counts against the day's. */
  mode: "reactive" | "proactive";
  origin: Origin;
  /** The job (role) the turn ran for, so its work picks up within the job's ceiling (Spec 3). */
  roleId?: string | null;
  /** When it started waiting (ISO). */
  since: string;
  step: "remind" | "give_up";
}

/** The check's key, and the cards' and the picked-up turn's dedupe keys. */
export const waitKey = (provider: ConnectProvider, turnId: string) =>
  `connect-wait:${provider}:${turnId}`;

const CONNECTED: Record<ConnectProvider, (db: DbOrTx) => Promise<boolean>> = {
  notion: async (db) =>
    (await db.select({ id: notionAccount.botId }).from(notionAccount).limit(1)).length > 0,
};

export const isConnected = (db: DbOrTx, provider: ConnectProvider) => CONNECTED[provider](db);

const known = (p: unknown): p is ConnectProvider =>
  typeof p === "string" && Object.hasOwn(CONNECT_PROVIDERS, p);

/** The provider a "<provider>.connected" event is about, if it's one a turn can wait for. */
export function connectedProvider(kind: string): ConnectProvider | null {
  const p = kind.replace(/\.connected$/, "");
  return p !== kind && known(p) ? p : null;
}

/** The card asking you to connect it. Settings does the connecting: the card only links there. */
export function connectCard(w: ConnectWait, reminder = false): NewNotification {
  const { label } = CONNECT_PROVIDERS[w.provider];
  return {
    kind: `connect.${w.provider}`,
    title: reminder ? `Pip is still waiting for ${label}` : `Pip needs ${label}`,
    body: `${w.why} Connect ${label} and Pip finishes the task by itself.`,
    entityId: w.conversationId,
    urgency: w.mode === "proactive" ? "interrupt" : "normal",
    dedupeKey: `${waitKey(w.provider, w.turnId)}${reminder ? ":reminder" : ""}`,
    // Set off while reading outside content, it says so, though its words are Pip's own.
    ...(w.origin === "untrusted" ? { outside: true } : {}),
  };
}

/** The turn that picks the work up again, in the same conversation and as trusted as it was. */
export function resumeTurn(w: ConnectWait): ReflexOutcome {
  const { label } = CONNECT_PROVIDERS[w.provider];
  return {
    kind: "turn",
    trigger: "approval",
    lane: w.lane,
    conversationId: w.conversationId,
    subjectId: w.subjectId,
    dedupeKey: waitKey(w.provider, w.turnId),
    origin: w.origin,
    // Background work stays background work: answering you doesn't make it yours.
    ...(w.mode === "proactive" ? { proactive: true } : {}),
    ...(w.roleId ? { roleId: w.roleId } : {}),
    context: { resumes: w.turnId, connected: w.provider },
    prompt: `${label} is connected now. Earlier in this conversation you needed it, and the owner was asked to connect it. Pick that work up again where you left off; if nothing is left, reply briefly or not at all.`,
    fallback: [
      {
        kind: "note",
        observation: {
          kind: "followup",
          text: `${label} is connected, but Pip couldn't pick up the background work that needed it (paused, or out of turns for today).`,
          aboutId: w.conversationId,
        },
      },
    ],
  };
}

/** Reads a check's payload back. Null for anything that isn't a wait. */
export function parseWait(p: Record<string, unknown>): ConnectWait | null {
  if (typeof p.turnId !== "string" || !known(p.provider) || typeof p.why !== "string") return null;
  return p as unknown as ConnectWait;
}

/** Whether its work was picked up already: a second connect mustn't start it twice. */
export async function resumed(db: DbOrTx, w: ConnectWait): Promise<boolean> {
  const key = waitKey(w.provider, w.turnId);
  const [t] = await db
    .select({ id: jarvisTurn.id })
    .from(jarvisTurn)
    .where(eq(jarvisTurn.dedupeKey, key));
  return Boolean(t);
}

/** The turns still waiting for a provider: their check hasn't given up, nor been picked up. */
export async function waiting(db: DbOrTx, provider: ConnectProvider): Promise<ConnectWait[]> {
  const rows = await db
    .select({ payload: schedule.payload })
    .from(schedule)
    .where(
      and(
        isNotNull(schedule.nextRunAt),
        sql`starts_with(${schedule.id}, ${`check:${CONNECT_WAIT}:${waitKey(provider, "")}`})`,
      ),
    );
  const out: ConnectWait[] = [];
  for (const r of rows) {
    const w = parseWait(r.payload);
    if (w && !(await resumed(db, w))) out.push(w);
  }
  return out;
}

/** Closes the open connect cards: for one turn, or every one for the provider. */
export async function closeCards(
  db: DbOrTx,
  provider: ConnectProvider,
  turnId = "",
): Promise<ReflexOutcome[]> {
  const rows = await db
    .select({ id: notification.id })
    .from(notification)
    .where(
      and(
        ne(notification.state, "done"),
        sql`starts_with(${notification.dedupeKey}, ${waitKey(provider, turnId)})`,
      ),
    );
  if (rows.length === 0) return [];
  return [
    { kind: "act", action: "inbox.mark", input: { ids: rows.map((r) => r.id), state: "done" } },
  ];
}
