// Pip, drawn as the design system draws it (design/nook/components/Pip): one rounded cube, two
// eyes, a mouth, in a soft glow, with each mood's pose. Built with createElementNS, since Nook's
// pages allow no inline markup or styles. It moves only by nook.css's mood classes, and not at
// all when idle.

import type { PipMood } from "@/bindings";

const NS = "http://www.w3.org/2000/svg";
type Shape = [tag: string, attrs: Record<string, string | number>];

const eye = "var(--pip-eye)";
const stroke = (d: string, width: number): Shape => [
  "path",
  {
    d,
    fill: "none",
    stroke: eye,
    "stroke-width": width,
    "stroke-linecap": "round",
  },
];
const dot = (cx: number, cy: number, r: number, fill = eye): Shape => [
  "circle",
  { cx, cy, r, fill },
];

/** Each mood's eyes (in pip-eyes, which blinks) and mouth. */
const FACE: Record<PipMood, { eyes: Shape[]; mouth: Shape[] }> = {
  idle: {
    eyes: [
      dot(46, 60, 6),
      dot(74, 60, 6),
      dot(48, 58, 2, "#fff"),
      dot(76, 58, 2, "#fff"),
    ],
    mouth: [stroke("M56 74 q4 3 8 0", 3)],
  },
  listening: {
    eyes: [
      dot(46, 61, 7.5),
      dot(74, 61, 7.5),
      dot(48, 59, 2, "#fff"),
      dot(76, 59, 2, "#fff"),
    ],
    mouth: [["ellipse", { cx: 60, cy: 76, rx: 3.5, ry: 4.5, fill: eye }]],
  },
  thinking: {
    eyes: [
      dot(49, 56, 6),
      dot(77, 56, 6),
      dot(51, 54, 2, "#fff"),
      dot(79, 54, 2, "#fff"),
    ],
    mouth: [stroke("M56 76 q4 -3 8 0", 3)],
  },
  happy: {
    eyes: [],
    mouth: [
      stroke("M38 62 q8 -8 16 0", 4.5),
      stroke("M66 62 q8 -8 16 0", 4.5),
      stroke("M53 72 q7 8 14 0", 3),
    ],
  },
};

function make(tag: string, attrs: Record<string, string | number> = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function group(cls: string, shapes: Shape[], attrs = {}): SVGGElement {
  const g = make("g", { class: cls, ...attrs }) as SVGGElement;
  for (const [tag, a] of shapes) g.append(make(tag, a));
  return g;
}

/** Pip at `size` px in `mood`; `label` is what a screen reader hears, or "" to hide it. */
export function pipSvg(mood: PipMood, size: number, label = ""): SVGSVGElement {
  const svg = make("svg", {
    class: `pip pip--${mood}`,
    viewBox: "-4 -4 128 128",
    width: size,
    height: size,
  }) as SVGSVGElement;
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else svg.setAttribute("aria-hidden", "true");
  const working = mood === "listening" || mood === "thinking";
  svg.append(
    make("rect", {
      class: "pip-glow",
      x: 8,
      y: 16,
      width: 104,
      height: 100,
      rx: 44,
      fill: "var(--pip-glow)",
      opacity: working ? 1 : 0.6,
    }),
  );
  const face = FACE[mood];
  const body = group("pip-body", [
    [
      "rect",
      { x: 22, y: 28, width: 76, height: 76, rx: 26, fill: "var(--pip-body)" },
    ],
  ]);
  if (face.eyes.length) body.append(group("pip-eyes", face.eyes));
  for (const [tag, a] of face.mouth) body.append(make(tag, a));
  svg.append(body);
  if (mood === "thinking") {
    const ink = "var(--ink)";
    svg.append(
      group("pip-dots", [
        dot(104, 30, 3, ink),
        dot(112, 20, 4, ink),
        dot(120, 8, 5, ink),
      ]),
    );
  }
  if (mood === "happy") {
    svg.append(
      group(
        "pip-sparks",
        [
          ["circle", { cx: 14, cy: 40, r: 3 }],
          ["circle", { cx: 108, cy: 28, r: 2.5 }],
          ["circle", { cx: 104, cy: 98, r: 2 }],
        ],
        { fill: "var(--pip-glow-ink)" },
      ),
    );
  }
  return svg;
}
