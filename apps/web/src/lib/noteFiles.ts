// Pictures and files put into a note: what a paste or a drop carries goes to Nook one file at a
// time (the server's /api/files keeps each as a record you can find, trash and restore), then the
// note gets markdown for it on a line of its own: ![name](/api/files/id) for a picture, which the
// note draws (noteBlocks.ts), and [name](/api/files/id) for anything else, which downloads.

import type { Text } from "@codemirror/state";
import { ApiError, signedOut } from "./api.ts";

export interface NoteFile {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** The largest file Nook takes (the server says the same). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** What Nook shows as a picture; the server judges it by the file's bytes, not its name. */
const SHOWN = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** What the picture picker offers. */
export const PICTURE_TYPES = [...SHOWN].join(",");

/**
 * The files a paste or drop carries. One that carries words is words, even with a file beside
 * them: Word and Excel put a picture of what you copied next to its text.
 */
export function filesIn(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  if (data.types.includes("text/plain") && data.getData("text/plain").trim()) return [];
  return [...data.files];
}

/** A pasted screenshot comes as "image.png": it's named for when it was pasted instead. */
export function nameOf(file: File, pasted: boolean, now = new Date()): string {
  if (!pasted || (file.name && file.name !== "image.png")) return file.name || "File";
  const p = (n: number) => String(n).padStart(2, "0");
  const ext = file.type === "image/jpeg" ? "jpg" : (file.type.split("/")[1] ?? "png");
  return `Pasted image ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}.${p(now.getMinutes())}.${ext}`;
}

/** Sends one file. Throws an ApiError in Nook's words when it isn't kept. */
export async function upload(file: File, name: string): Promise<NoteFile> {
  if (file.size > MAX_FILE_BYTES) throw new ApiError(413, "too_big", "That file is over 25 MB.");
  let res: Response;
  try {
    res = await fetch(`/api/files?name=${encodeURIComponent(name)}`, {
      method: "POST",
      body: file,
      headers: { "content-type": file.type || "application/octet-stream" },
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "unreachable", "Can't reach Nook right now. Try again in a moment.");
  }
  if (res.status === 401) signedOut();
  const body = (await res.json().catch(() => null)) as (NoteFile & { error?: string }) | null;
  if (!res.ok || !body?.id)
    throw new ApiError(res.status, "failed", body?.error ?? "That file wasn't added.");
  return body;
}

/** A file as the note writes it: a picture to draw, or a link that downloads. */
export function fileMarkdown(f: NoteFile): string {
  const name = f.name.replace(/[\r\n]+/g, " ").replace(/[[\]\\]/g, (c) => `\\${c}`);
  return `${SHOWN.has(f.mime) ? "!" : ""}[${name}](/api/files/${f.id})`;
}

/**
 * Where files' markdown goes at `at`: each on a line of its own, what was after `at` on the line
 * below them, and (`caret`, for a paste or a pick) a line after for the caret, so you write on
 * under the picture. A drop leaves the caret where it is, and adds no line for it.
 */
export function placeFiles(doc: Text, at: number, md: string[], caret = true) {
  const line = doc.lineAt(at);
  const before = doc.sliceString(line.from, at).trim() !== "";
  const after = doc.sliceString(at, line.to);
  const below = caret || after.trim() !== "";
  const insert = `${before ? "\n" : ""}${md.join("\n")}${below ? "\n" : ""}`;
  return {
    from: at,
    to: at + after.length - after.trimStart().length,
    insert,
    caret: at + insert.length,
  };
}
