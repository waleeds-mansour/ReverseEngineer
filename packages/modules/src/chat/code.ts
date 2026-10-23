// Whether an ask is about code, without a model call (D82): code asks run on Opus. Unsure leans
// to yes, because a wrong yes costs a little and a wrong no gets a worse answer.

const FENCE = /```/;
// Inline code with something code-like in it: `foo()`, `a = b`, `<div>`.
const INLINE = /`[^`\n]*[(){}[\];=<>][^`\n]*`/;
const TRACE =
  /\b(Traceback \(most recent call last\)|[A-Z]\w*(Error|Exception)\b|exit code \d+|panicked at|segmentation fault)|^\s+at \S.*:\d+(:\d+)?\)?$/m;
const FILE =
  /\b[\w./\\-]*\w\.(tsx?|jsx?|mjs|cjs|py|ipynb|rs|go|java|kt|cs|csproj|cpp|cc|hpp|c|h|rb|php|swift|ps1|psm1|sh|bash|bat|cmd|sql|lua|luau|vue|svelte|css|scss|html|json|ya?ml|toml|gradle|dockerfile)\b/i;
const GITHUB = /\b(github\.com|gist\.github\.com)\/[\w.-]+/i;
const WORDS =
  /\b(code|coding|codebase|script|scripts|function|functions|bug|bugs|error|errors|compile[sd]?|compiler|commit|commits|committed|branch|branches|repo|repos|repository|pull request|merge conflict|refactor|debug|debugging|stack trace|regex|typescript|javascript|python|npm|pnpm|git|endpoint|api|sql)\b/i;
// Uppercase only, so "pr" inside other words and lowercase "pr" don't count.
const PR = /\bPRs?\b/;
// Everyday phrases with a code word in them, taken out before the words are checked.
const EVERYDAY =
  /\b(zip|postal|area|country|promo|discount|coupon|gift|dress|verification|confirmation|access|booking|security|tax|qr) codes?\b|\bbank branch(es)?\b/gi;

/** True when the text looks like code: a code block, an error, a code file, GitHub or code words. */
export function looksLikeCode(text: string): boolean {
  const words = text.replace(EVERYDAY, " ");
  return (
    [FENCE, INLINE, TRACE, FILE, GITHUB].some((re) => re.test(text)) ||
    WORDS.test(words) ||
    PR.test(words)
  );
}
