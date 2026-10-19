// The desktop app's Nook stylesheet (apps/desktop/src/nook/nook.css) is what
// scripts/nook-themes.ts makes from design/nook today, and it keeps the two promises the bar
// makes: no CSS blur behind glass, and a Pip that holds still at idle.
import { describe, expect, it } from "vitest";
import bundle from "../../../../design/nook/components/bundle.css?raw";
import tokensJson from "../../../../design/nook/tokens.json?raw";
import chromeCss from "../../../desktop/src/nook/nook.css?raw";
import { type ChromeTokens, renderNookChrome, rules } from "./nookChrome.ts";

const tokens = JSON.parse(tokensJson) as ChromeTokens;
const sheet = rules(chromeCss);

describe("the desktop's Nook stylesheet", () => {
  it("is current with design/nook (run node scripts/nook-themes.ts if not)", () => {
    expect(chromeCss).toBe(renderNookChrome(tokens, bundle));
  });

  it("sets every theme the web has, and only its own names", () => {
    for (const { id } of tokens.color.themes.slice(1)) {
      expect(chromeCss).toContain(`:root[data-theme="${id}"] {`);
    }
    const root = sheet.find((r) => r.startsWith(":root {"))!;
    for (const name of [
      "--ink",
      "--glass",
      "--space-3",
      "--dur-base",
      "--bar-height",
      "--font-sans",
    ]) {
      expect(root).toContain(`${name}:`);
    }
  });

  it("blurs nothing itself: DWM's acrylic is the only blur", () => {
    expect(chromeCss).not.toMatch(/backdrop-filter/);
    expect(sheet.some((r) => r.startsWith(".re-glass{"))).toBe(true);
  });

  it("leaves Pip still at idle, and moving only while it works", () => {
    for (const idle of [".pip .pip-body{", ".pip .pip-glow{", ".pip .pip-eyes{"]) {
      const rule = sheet.find((r) => r.startsWith(idle));
      expect(rule, idle).toBeDefined();
      expect(rule).not.toMatch(/animation/);
    }
    expect(sheet.find((r) => r.startsWith(".pip--thinking .pip-body{"))).toMatch(/animation/);
    expect(chromeCss).not.toMatch(/pip--asleep/);
  });

  it("stops every animation and transition under reduced motion", () => {
    expect(chromeCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important; transition: none !important; \}/,
    );
    expect(chromeCss).toContain(":root[data-reduced] *");
  });
});
