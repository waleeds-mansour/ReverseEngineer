// What the quick-ask box's mic heard (askView.ts), typed out at the end of what is in the box a
// character every PER_CHAR_MS, as the reference's command box types what it hears, or all at
// once when nothing should move. A key or a send finishes it at once, so nothing is lost.

/** About as fast as the reference types. */
export const PER_CHAR_MS = 48;

/** What the box holds once `heard` is added to `text`: a space between when one is needed, and
 * no more than `max` characters. */
export function joined(text: string, heard: string, max = 4000): string {
  const gap = text === "" || /\s$/.test(text) ? "" : " ";
  return Array.from(text + gap + heard)
    .slice(0, max)
    .join("");
}

export interface Typing {
  /** Puts the rest in at once. */
  finish(): void;
}

/** Types `heard` onto the end of `input`; `done` runs once it's all there. */
export function typeOut(
  input: HTMLInputElement,
  heard: string,
  instant: boolean,
  done: () => void,
): Typing {
  const whole = joined(
    input.value,
    heard,
    input.maxLength > 0 ? input.maxLength : 4000,
  );
  const chars = Array.from(whole);
  let shown = Array.from(input.value).length;
  let timer: number | undefined;
  let over = false;
  const put = (n: number) => {
    input.value = chars.slice(0, n).join("");
    input.setSelectionRange(input.value.length, input.value.length);
  };
  const finish = () => {
    if (over) return;
    over = true;
    window.clearInterval(timer);
    put(chars.length);
    done();
  };
  if (instant) {
    finish();
    return { finish };
  }
  timer = window.setInterval(() => {
    shown += 1;
    put(shown);
    if (shown >= chars.length) finish();
  }, PER_CHAR_MS);
  return { finish };
}
