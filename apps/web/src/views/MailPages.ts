// The mail list a page at a time: the newest conversations first, and older ones as you scroll
// (or move with j) down to them. Each page starts after the last one shown, by its time and id,
// so mail arriving meanwhile doesn't skip or repeat any. The inbox in bundles shows only People's
// newest (FIRST), above the other bundles' rows; all of People opens as a bundle of its own.

import { createInfiniteQuery } from "@tanstack/solid-query";
import { action } from "../lib/api.ts";
import type { BundledThread } from "../lib/types.ts";

/** Conversations per page. */
export const PAGE = 50;
/** People's newest in the inbox in bundles: one short page, so the other bundles stay near. */
export const FIRST = 25;

interface Cursor {
  before?: string;
  beforeId?: string;
}

export function useThreadPages(input: () => Record<string, unknown>, enabled: () => boolean) {
  const query = createInfiniteQuery(() => ({
    queryKey: ["mail.threads", input()],
    queryFn: ({ queryKey, pageParam }: { queryKey: unknown[]; pageParam: Cursor }) =>
      action<BundledThread[]>("mail.threads", { ...(queryKey[1] as object), ...pageParam }),
    initialPageParam: {} as Cursor,
    getNextPageParam: (last: BundledThread[]): Cursor | undefined => {
      const end = last.at(-1);
      // Lists in order of how long they've waited come whole, up to their limit.
      if (!end || last.length < PAGE || input().waiting) return undefined;
      return { before: end.lastMessageAt, beforeId: end.id };
    },
    enabled: enabled(),
  }));
  /** Every page loaded, in order, each conversation once. */
  const list = (): BundledThread[] => {
    const seen = new Set<string>();
    return (query.data?.pages ?? []).flat().filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  };
  const more = () => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  };
  return { query, list, more };
}

/** Loads more when `el` (the end of the list) scrolls into view, or close to it. */
export function whenSeen(el: HTMLElement, run: () => void): () => void {
  let io: IntersectionObserver | undefined;
  // Once it's on the page, so the list it scrolls in can be found.
  const frame = requestAnimationFrame(() => {
    io = new IntersectionObserver((seen) => seen.some((e) => e.isIntersecting) && run(), {
      root: el.closest<HTMLElement>(".overflow-auto"),
      rootMargin: "400px",
    });
    io.observe(el);
  });
  return () => {
    cancelAnimationFrame(frame);
    io?.disconnect();
  };
}
