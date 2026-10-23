// What an eval run used, priced at the API's list prices (D82). The owner's plan isn't billed per
// token, but its weekly allowance goes down roughly in step with these, so they compare tiers.
import type { Usage } from "../brain.ts";

/**
 * Dollars per million tokens: input, output, cache read, cache write. Claude Code caches for an
 * hour, which writes at twice the input price. Haiku's are for prompts up to 100k tokens.
 */
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.2],
  "claude-sonnet-5-5": [2, 10, 0.2, 4],
  "claude-opus-5-5": [4, 20, 0.2, 8],
};

/** List-price dollars for some usage; a model not in the table counts as Opus. */
export function listPrice(usage: Usage | undefined): number {
  let total = 0;
  for (const [model, t] of Object.entries(usage ?? {})) {
    const [i, o, r, w] = PRICES[model] ?? PRICES["claude-opus-5-5"]!;
    total += (t.input * i + t.output * o + t.cacheRead * r + t.cacheWrite * w) / 1e6;
  }
  return total;
}

/** "sonnet 2.1k in, 40.1k to cache, 380.0k from cache, 1.2k out; $0.1412" */
export function describeUsage(usage: Usage | undefined): string {
  if (!usage) return "no usage";
  const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
  const parts = Object.entries(usage).map(
    ([model, t]) =>
      `${model.replace(/^claude-|-5-5$/g, "")} ${k(t.input)} in, ${k(t.cacheWrite)} to cache, ${k(t.cacheRead)} from cache, ${k(t.output)} out`,
  );
  return `${parts.join("; ")}; $${listPrice(usage).toFixed(4)}`;
}
