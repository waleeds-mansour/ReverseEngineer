// A web page's title, for a link card (blocks.ts): asked of Nook, which fetches the page itself
// (never one on your own network, and only so much of it), once per address while the app is
// open. Without an answer, the card shows the address.

const asked = new Map<string, Promise<string | null>>();

async function ask(url: string): Promise<string | null> {
  try {
    // In the body, not the address: a link can carry a key, and addresses are logged.
    const res = await fetch("/api/links/title", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { title?: string | null };
    return body.title?.trim() || null;
  } catch {
    return null;
  }
}

/** The title of the page at `url`, or null when Nook couldn't find one. */
export function titleOf(url: string): Promise<string | null> {
  let p = asked.get(url);
  if (!p) {
    if (asked.size > 500) asked.clear();
    p = ask(url);
    asked.set(url, p);
  }
  return p;
}
