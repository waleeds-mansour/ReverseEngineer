// How many gits run at once. Pip can ask for a lot in one turn, and this PC also runs your live
// Nook, its builds and your games, so reads take turns: a few at a time in all, fewer in any one
// repo. A call past the line, or one that waits too long, fails at once with words Pip can pass on.
import { ActionError } from "@hearth/kernel";

export const BUSY = "Git is busy with Pip's other reads. Try again in a moment.";

interface Waiting {
  key: string;
  go: () => void;
  timer: NodeJS.Timeout;
}

export class Slots {
  private running = 0;
  private readonly per = new Map<string, number>();
  private readonly waiting: Waiting[] = [];
  private readonly total: number;
  private readonly each: number;
  private readonly line: number;
  private readonly waitMs: number;

  /**
   * `total` at once, `each` per key (a repo), and at most `line` waiting, each for up to `waitMs`.
   */
  constructor(total: number, each: number, line: number, waitMs: number) {
    this.total = total;
    this.each = each;
    this.line = line;
    this.waitMs = waitMs;
  }

  /** How many are running now. */
  get busy() {
    return this.running;
  }

  /** Waits for a turn; call what comes back when done (more than once is fine). */
  take(key: string): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const go = () => {
        this.running++;
        this.per.set(key, (this.per.get(key) ?? 0) + 1);
        let done = false;
        resolve(() => {
          if (done) return;
          done = true;
          this.running--;
          const left = (this.per.get(key) ?? 1) - 1;
          if (left) this.per.set(key, left);
          else this.per.delete(key);
          this.next();
        });
      };
      if (this.free(key)) return go();
      if (this.waiting.length >= this.line) return reject(new ActionError("unavailable", BUSY));
      const entry: Waiting = {
        key,
        go,
        timer: setTimeout(() => {
          this.waiting.splice(this.waiting.indexOf(entry), 1);
          reject(new ActionError("unavailable", BUSY));
        }, this.waitMs),
      };
      this.waiting.push(entry);
    });
  }

  private free(key: string) {
    return this.running < this.total && (this.per.get(key) ?? 0) < this.each;
  }

  /** Starts the first waiting call that has room now, oldest first. */
  private next() {
    const i = this.waiting.findIndex((w) => this.free(w.key));
    if (i < 0) return;
    const [w] = this.waiting.splice(i, 1);
    clearTimeout(w!.timer);
    w!.go();
  }
}
