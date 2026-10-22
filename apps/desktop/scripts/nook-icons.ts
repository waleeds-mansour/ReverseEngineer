// Draws the desktop app's icons from the Nook mark: the app icon at every size Windows asks for,
// the installer's, and the tray's. Run it after changing the mark:
//
//   node apps/desktop/scripts/nook-icons.ts
//
// From 40 px up, the mark is design/nook/assets/Logos/nook-mark.svg as it is. At 16, 20, 24 and
// 32 px, the sizes the taskbar, title bar and Start use, it's redrawn on whole pixels: drawn to
// scale, Pip's eyes smear into one smudge and the smile goes grey. The tray picture is the 16 px
// drawing at four times its size, since Windows shrinks it to 16 px on a 100% screen, with Pip's
// listening or thinking face and a dot in the corner while you're recorded or it's transcribing.
// `tauri icon` draws each SVG (it uses resvg); this packs the .ico itself, to keep the small ones.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MARK = resolve(DESKTOP, "../../design/nook/assets/Logos/nook-mark.svg");
const ICONS = join(DESKTOP, "src-tauri/icons");
const TRAY = join(DESKTOP, "src-tauri/resources");
const TAURI = join(
  DESKTOP,
  "node_modules/.bin",
  process.platform === "win32" ? "tauri.cmd" : "tauri",
);

/** The Light theme's accent: the mark keeps it everywhere (design/nook/assets/Logos/README.md). */
const BLUE = "#0a60c8";

/**
 * The tray's dots, in Nook's status colours (tokens.json): Light's deep danger red, and Dark's
 * bright warning amber, since Light's is a brown made for words that turns muddy as a dot. Both
 * read on a light and a dark taskbar, so the two sets of tray pictures are the same.
 */
const RECORDING = "#c4262e";
const BUSY = "#ffb340";

const svg = (size: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${body}</svg>`;
const rect = (
  x: number,
  y: number,
  w: number,
  h: number,
  rx: number,
  more = "",
) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" ${more}/>`;

type Face = "idle" | "listening" | "thinking";

/**
 * The mark on a 16 px grid: tile, the window behind, and Pip's window in front with its face.
 * Listening, Pip's mouth opens; thinking, its eyes look up and to the right, as in its mascot
 * poses (design/nook/assets/Mascot). A badge is a dot in the top-right corner, with a gap cut
 * round it so it reads on any taskbar.
 */
function mark16(face: Face = "idle", badge?: string): string {
  const [ex, ey] = face === "thinking" ? [8, 7] : [7, 8];
  const eyes =
    rect(ex, ey, 2, 2, 0.3, `fill="${BLUE}"`) +
    rect(ex + 3, ey, 2, 2, 0.3, `fill="${BLUE}"`);
  const mouth =
    face === "listening"
      ? `<ellipse cx="9.5" cy="11.6" rx=".8" ry=".9" fill="${BLUE}"/>`
      : rect(9, 11, 1, 1, 0, `fill="${BLUE}" opacity=".75"`);
  const art =
    rect(0, 0, 16, 16, 4, `fill="${BLUE}"`) +
    rect(2, 3, 8, 7, 2, `fill="#fff" opacity=".4"`) +
    rect(5, 6, 9, 7, 2, `fill="#fff"`) +
    eyes +
    mouth;
  if (!badge) return svg(16, art);
  const gap = `<mask id="gap"><rect width="16" height="16" fill="#fff"/><circle cx="13.25" cy="2.75" r="3.1" fill="#000"/></mask>`;
  return svg(
    16,
    `${gap}<g mask="url(#gap)">${art}</g><circle cx="13.25" cy="2.75" r="2.3" fill="${badge}"/>`,
  );
}

/** 20, 24 and 32 px, each lined up on its own pixels. */
const SMALL: Record<number, string> = {
  16: mark16(),
  20: svg(
    20,
    rect(0, 0, 20, 20, 5, `fill="${BLUE}"`) +
      rect(3, 4, 9, 8, 2, `fill="#fff" opacity=".4"`) +
      rect(6, 7, 11, 9, 2.5, `fill="#fff"`) +
      rect(9, 10, 2, 2, 0.5, `fill="${BLUE}"`) +
      rect(12, 10, 2, 2, 0.5, `fill="${BLUE}"`) +
      `<path d="M10.5 13.5h2" stroke="${BLUE}" stroke-width="1" stroke-linecap="round" opacity=".8"/>`,
  ),
  24: svg(
    24,
    rect(0, 0, 24, 24, 6, `fill="${BLUE}"`) +
      rect(4, 4, 11, 10, 2.5, `fill="#fff" opacity=".4"`) +
      rect(8, 9, 12, 11, 3, `fill="#fff"`) +
      rect(11, 13, 2, 2, 0.6, `fill="${BLUE}"`) +
      rect(15, 13, 2, 2, 0.6, `fill="${BLUE}"`) +
      `<path d="M13 17.5q1 .9 2 0" fill="none" stroke="${BLUE}" stroke-width="1" stroke-linecap="round"/>`,
  ),
  32: svg(
    32,
    rect(0, 0, 32, 32, 8, `fill="${BLUE}"`) +
      rect(5, 6, 15, 13, 3.5, `fill="#fff" opacity=".4"`) +
      rect(11, 12, 16, 14, 4, `fill="#fff"`) +
      `<circle cx="16.5" cy="18.5" r="1.75" fill="${BLUE}"/><circle cx="21.5" cy="18.5" r="1.75" fill="${BLUE}"/>` +
      `<path d="M18 22.5q1 1 2 0" fill="none" stroke="${BLUE}" stroke-width="1.25" stroke-linecap="round"/>`,
  ),
};

/** The sizes in icon.ico: every one Windows picks from, at 100% to 200% scaling. */
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

const work = mkdtempSync(join(tmpdir(), "nook-icons-"));

/** One SVG drawn at one size, as PNG bytes. */
function draw(source: string, size: number): Buffer {
  const name = `in-${size}-${Math.random().toString(36).slice(2)}.svg`;
  const input = join(work, name);
  const out = join(work, `${name}.out`);
  writeFileSync(input, source);
  run([input, "-o", out, "--png", String(size)]);
  return readFileSync(join(out, `${size}x${size}.png`));
}

function run(args: string[]) {
  // tauri.cmd is a batch file, which Windows runs only through a shell.
  execFileSync(TAURI, ["icon", ...args], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
}

/** An .ico of PNG images, one per size (Windows Vista and later read PNG in an .ico). */
function ico(images: { size: number; png: Buffer }[]): Buffer {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, at);
    head.writeUInt8(size >= 256 ? 0 : size, at + 1);
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(png.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.png)]);
}

try {
  const master = readFileSync(MARK, "utf8");
  const at = (size: number) => draw(SMALL[size] ?? master, size);

  // Every file Tauri's own set has (Store logos, .icns, PNGs) from the mark, then the small
  // ones and the .ico again with the sizes drawn on whole pixels.
  run([MARK, "-o", ICONS]);
  writeFileSync(join(ICONS, "32x32.png"), at(32));
  writeFileSync(
    join(ICONS, "icon.ico"),
    ico(ICO_SIZES.map((size) => ({ size, png: at(size) }))),
  );

  // The tray: tray_*.png for a dark taskbar, tray_*_dark.png for a light one (tray.rs picks), and
  // the Colored set Linux uses. 64 px, which is the 16 px drawing at four times.
  const tray = (face: Face, badge?: string) => draw(mark16(face, badge), 64);
  const pictures = {
    idle: tray("idle"),
    recording: tray("listening", RECORDING),
    transcribing: tray("thinking", BUSY),
    warning: tray("idle", BUSY),
  };
  for (const suffix of ["", "_dark"]) {
    writeFileSync(join(TRAY, `tray_idle${suffix}.png`), pictures.idle);
    writeFileSync(
      join(TRAY, `tray_recording${suffix}.png`),
      pictures.recording,
    );
    writeFileSync(
      join(TRAY, `tray_transcribing${suffix}.png`),
      pictures.transcribing,
    );
    writeFileSync(
      join(TRAY, `tray_idle_warning${suffix}.png`),
      pictures.warning,
    );
  }
  writeFileSync(join(TRAY, "handy.png"), pictures.idle);
  writeFileSync(join(TRAY, "recording.png"), pictures.recording);
  writeFileSync(join(TRAY, "transcribing.png"), pictures.transcribing);
  writeFileSync(join(TRAY, "handy_warning.png"), pictures.warning);
  console.log(
    `Drew the app icon (${ICO_SIZES.join(", ")} px) and the tray's 12 pictures.`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
