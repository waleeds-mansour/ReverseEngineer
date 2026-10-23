// Eval scenarios for the code job (D82): asks that look like code run on Opus, and everyday asks
// with words that sound like code stay off it. Each checks the job its turn ran as.
import { jarvisTurn } from "@hearth/db";
import { ownerCaller } from "@hearth/kernel";
import { jobOf } from "../models.ts";
import type { Scenario } from "./scenarios.ts";

function ask(name: string, description: string, text: string, code: boolean): Scenario {
  return {
    name,
    description,
    start: "2026-10-01T14:00:00Z",
    async setup() {},
    async act(h) {
      const res = await h.kernel.execute("chat.send", { text }, ownerCaller());
      if (res.status !== "ok") throw new Error(`chat.send: ${JSON.stringify(res)}`);
      await h.settle();
    },
    async check(h) {
      const jobs = (await h.tdb.db.select().from(jarvisTurn)).map((t) => jobOf(t));
      if (!jobs.length) return ["no turn ran"];
      const wrong = jobs.filter((j) => (j === "code") !== code);
      return wrong.length ? [`ran as ${wrong.join(", ")}, not ${code ? "code" : "off Opus"}`] : [];
    },
  };
}

export const CODE_SCENARIOS: Scenario[] = [
  ask(
    "code-block",
    "A question with a code block runs as code, on Opus.",
    'why does this give a type error?\n```ts\nconst total: number = items.length > 0 ? items[0] : "none";\n```',
    true,
  ),
  ask(
    "code-trace",
    "A stack trace runs as code, on Opus.",
    "Pip crashed overnight with this, what's going on?\n\nTypeError: Cannot read properties of undefined (reading 'id')\n    at nextTurn (packages/jarvis/src/claim.ts:41:17)\n    at TurnRunner.tick (packages/jarvis/src/runner.ts:120:9)",
    true,
  ),
  ask(
    "code-file",
    "Fixing a bug in a named file runs as code, on Opus.",
    "fix the bug in packages/jarvis/src/heartbeat.ts where it runs twice",
    true,
  ),
  ask(
    "code-pr",
    "A GitHub pull request link runs as code, on Opus.",
    "why is CI failing on https://github.com/acme/widgets/pull/42 ?",
    true,
  ),
  ask(
    "not-code-schedule",
    'An everyday ask with "build" in it stays off Opus.',
    "build a schedule for my week around my two dentist appointments",
    false,
  ),
  ask(
    "not-code-errands",
    'An everyday ask with "run" in it stays off Opus.',
    "run through my errands for Saturday and tell me what order makes sense",
    false,
  ),
];
