// Connecting a tool mid-task (Spec 4). When Pip needs a connector you haven't connected, the
// action says so with a ConnectionError; the turn leaves you a card and waits (jarvis/outcomes.ts),
// and connect.wait picks its work up again once you connect it in Settings. Pip never sees the
// secret, and the card can't connect anything: it only opens Settings.
import { CONNECT_PROVIDERS, ConnectionError, type ConnectProvider } from "@hearth/core";
import { defineAction, defineModule, type ReflexDef, type ReflexOutcome } from "@hearth/kernel";
import { z } from "zod";
import {
  CONNECT_WAIT,
  closeCards,
  connectCard,
  connectedProvider,
  GIVE_UP_AFTER_MS,
  isConnected,
  parseWait,
  resumed,
  resumeTurn,
  waiting,
  waitKey,
} from "./wait.ts";

export {
  CONNECT_WAIT,
  type ConnectWait,
  connectCard,
  GIVE_UP_AFTER_MS,
  REMIND_AFTER_MS,
  waitKey,
} from "./wait.ts";

const PROVIDERS = Object.keys(CONNECT_PROVIDERS) as [ConnectProvider, ...ConnectProvider[]];

/** What Pip says it needs a connector for when it can't say so in its own words. */
const ITS_OWN_WORDS = "Pip needs it for something it's working on.";

const wait: ReflexDef = {
  name: CONNECT_WAIT,
  description:
    "When you connect a tool Pip asked for, it picks the task back up. It reminds you once, and stops waiting after a day.",
  // Like an approval's answer, connecting is you answering Pip, so it runs while Pip is paused.
  // Background work it picks up stays background work (resumeTurn).
  mode: "reactive",
  on: PROVIDERS.map((p) => `${p}.connected`),
  async run(event, ctx) {
    const provider = connectedProvider(event.kind);
    if (!provider) return [];
    const waits = await waiting(ctx.db, provider);
    if (waits.length === 0) return closeCards(ctx.db, provider);
    return [...waits.map(resumeTurn), ...(await closeCards(ctx.db, provider))];
  },
  async onCheck(payload, ctx) {
    const w = parseWait(payload);
    if (!w || (await resumed(ctx.db, w))) return [];
    // Connected without its event reaching this (or before it began to wait): pick it up now.
    if (await isConnected(ctx.db, w.provider))
      return [resumeTurn(w), ...(await closeCards(ctx.db, w.provider, w.turnId))];
    const key = waitKey(w.provider, w.turnId);
    const label = CONNECT_PROVIDERS[w.provider].label;
    if (w.step === "remind") {
      const out: ReflexOutcome[] = [];
      // One you put away is an answer: no reminder, though it still waits out the day.
      const open = await closeCards(ctx.db, w.provider, w.turnId);
      if (open.length) out.push(...open, { kind: "tell", notification: connectCard(w, true) });
      const giveUp = new Date(new Date(w.since).getTime() + GIVE_UP_AFTER_MS);
      out.push({ kind: "check_later", key, at: giveUp, payload: { ...w, step: "give_up" } });
      return out;
    }
    return [
      ...(await closeCards(ctx.db, w.provider, w.turnId)),
      {
        kind: "note",
        observation: {
          kind: "followup",
          text: `Pip stopped waiting for ${label}. ${w.why} Ask again once it's connected.`,
          aboutId: w.conversationId,
        },
      },
    ];
  },
};

export const connectModule = defineModule({
  name: "connect",
  description:
    "Asks you to connect a tool Pip needs mid-task, with a card that opens Settings, and picks the task back up once you do.",
  entityTypes: [],
  events: [],
  knowledge: {},
  actions: [
    defineAction({
      name: "connect.request",
      description:
        "Ask the owner to connect a tool you need for what you're doing. They get a card that opens Settings, and you're started again here once they connect it. `why` is one short sentence in your own words, about the task.",
      input: z.object({
        provider: z.enum(PROVIDERS),
        why: z.string().trim().min(3).max(200),
      }),
      // It only says whether it's connected; the card comes from the turn (jarvis/outcomes.ts).
      risk: "read",
      callers: ["agent"],
      async handler(i, ctx) {
        if (await isConnected(ctx.tx, i.provider)) return { connected: true };
        // Words a turn wrote after reading outside content could be that content's: not on a card.
        const why = ctx.caller.origin === "untrusted" ? ITS_OWN_WORDS : i.why;
        throw new ConnectionError(i.provider, why);
      },
    }),
  ],
  reflexes: [wait],
});
