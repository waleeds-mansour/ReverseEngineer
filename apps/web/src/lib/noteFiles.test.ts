import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { fileMarkdown, filesIn, nameOf, placeFiles } from "./noteFiles.ts";

const ID = "0b6f8f0e-8a4e-4b9e-9c1e-3f2a7d1c5e90";
const file = (name: string, type = "image/png") => ({ name, type }) as File;
const carrying = (files: File[], text = "") =>
  ({
    types: [...(text ? ["text/plain"] : []), ...(files.length ? ["Files"] : [])],
    getData: (t: string) => (t === "text/plain" ? text : ""),
    files,
  }) as unknown as DataTransfer;

describe("filesIn", () => {
  it("is the files a paste or drop carries, unless it carries words too", () => {
    const shot = file("image.png");
    expect(filesIn(carrying([shot]))).toEqual([shot]);
    // Word and Excel put a picture of what you copied beside its words: the words win.
    expect(filesIn(carrying([shot], "Q3 numbers"))).toEqual([]);
    expect(filesIn(null)).toEqual([]);
  });
});

describe("nameOf", () => {
  it("names a pasted screenshot for when it was pasted, and keeps a real file's name", () => {
    const at = new Date(2026, 9, 27, 9, 5);
    expect(nameOf(file("image.png"), true, at)).toBe("Pasted image 2026-10-27 09.05.png");
    expect(nameOf(file("image.png", "image/jpeg"), true, at)).toBe(
      "Pasted image 2026-10-27 09.05.jpg",
    );
    expect(nameOf(file("beach.png"), true, at)).toBe("beach.png");
    expect(nameOf(file("image.png"), false, at)).toBe("image.png");
  });
});

describe("fileMarkdown", () => {
  it("writes a picture as one and anything else as a link, its name escaped", () => {
    const pic = { id: ID, name: "beach [1].png", mime: "image/png", size: 9 };
    expect(fileMarkdown(pic)).toBe(`![beach \\[1\\].png](/api/files/${ID})`);
    const pdf = { id: ID, name: "lease.pdf", mime: "application/pdf", size: 9 };
    expect(fileMarkdown(pdf)).toBe(`[lease.pdf](/api/files/${ID})`);
  });
});

describe("placeFiles", () => {
  const md = "![a.png](/api/files/x)";
  const put = (doc: string, at: number) => {
    const p = placeFiles(Text.of(doc.split("\n")), at, [md]);
    const out = doc.slice(0, p.from) + p.insert + doc.slice(p.to);
    return `${out.slice(0, p.caret)}^${out.slice(p.caret)}`;
  };

  it("puts each on a line of its own, the caret on the line after", () => {
    expect(put("", 0)).toBe(`${md}\n^`);
    expect(put("Trip", 4)).toBe(`Trip\n${md}\n^`);
    expect(put("Trip", 0)).toBe(`${md}\n^Trip`);
    // In the middle of a line: the rest goes below, without the space before it.
    expect(put("the beach today", 9)).toBe(`the beach\n${md}\n^today`);
  });

  it("for a drop, adds no line for the caret", () => {
    const p = placeFiles(Text.of(["Trip", "", "next"]), 5, [md], false);
    expect(p).toMatchObject({ from: 5, to: 5, insert: md });
    expect(placeFiles(Text.of(["Trip"]), 4, [md], false).insert).toBe(`\n${md}`);
  });
});
