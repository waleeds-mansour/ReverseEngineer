// The code check that sends an ask to Opus (D82).
import { describe, expect, it } from "vitest";
import { looksLikeCode } from "./code.ts";

describe("looksLikeCode", () => {
  it.each([
    ["a code block", "why does this fail?\n```ts\nconst a: number = 'x';\n```"],
    ["inline code", "what does `items.map(fn)` return here"],
    [
      "a stack trace",
      "TypeError: Cannot read properties of undefined\n    at run (src/app.ts:12:5)",
    ],
    ["a Python traceback", 'Traceback (most recent call last):\n  File "main.py", line 3'],
    ["a code file", "fix the off-by-one in packages/jarvis/src/runner.ts"],
    ["a PowerShell script", "can you look at update.ps1 before I run it"],
    ["a GitHub link", "review https://github.com/waleeds-mansour/ReverseEngineer/pull/154"],
    ["the word bug", "there's a bug where the tray icon disappears"],
    ["a PR", "is my PR ready to merge?"],
    ["a branch", "rebase my branch on main"],
    ["an exit code", "the build stopped with exit code 1"],
  ])("yes for %s", (_why, text) => {
    expect(looksLikeCode(text)).toBe(true);
  });

  it.each([
    ["a week plan with risky words", "build a schedule for my week and run through my errands"],
    ["a reminder", "remind me to call mom tomorrow at 5pm"],
    ["a plan", "plan my week: finish the budget, call the bank, and book flights to Denver"],
    ["a zip code", "what's the zip code for the Denver office?"],
    ["a promo code", "use the promo code from the newsletter when you book"],
    ["a bank branch", "find the nearest bank branch open on Saturday"],
    ["times and dates", "move the 10 a.m. call to 2026-10-09, e.g. after lunch"],
    ["lowercase pr in a word", "approve the price for the print job"],
  ])("no for %s", (_why, text) => {
    expect(looksLikeCode(text)).toBe(false);
  });
});
