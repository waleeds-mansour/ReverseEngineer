# Notices

Hearth (shown to you as Nook) is licensed under the MIT License (see [LICENSE](LICENSE)). Its
look, `design/nook/`, is Hearth's own and under the same license.

Some files are copied or adapted from other open-source projects. Each such file keeps its
original notice at the top, and is listed here with where it came from.

| Hearth path | Origin | Upstream path | License |
|---|---|---|---|
| `apps/desktop/` (all of it, except `src-tauri/src/hearth/`, `src-tauri/src/nook/` (but see `rules/default.json` below), `src-tauri/crates/nook-restore/`, `src-tauri/nsis/hooks.nsh`, `src-tauri/capabilities/nook.json`, `scripts/build-guard.ts`, `scripts/nook-rules.ts`, `src/nook/` and `src/components/settings/HearthSettings.tsx`, which are Hearth's) | [Handy](https://github.com/cjpais/Handy) at `ffbc950`, changed where marked | the whole repository | MIT (`apps/desktop/LICENSE`) |
| `apps/web/src/components/icons.tsx` (the icons' SVG markup) | [Lucide](https://github.com/lucide-icons/lucide) v0.548.0 | `icons/*.svg` | ISC, with MIT for the parts from Feather (both in the file's header) |
| `apps/web/src/components/brands.tsx` (the marks' paths) | [Simple Icons](https://github.com/simple-icons/simple-icons) | `icons/*.svg` | CC0 1.0; the marks are their owners' trademarks |
| `apps/desktop/src-tauri/src/nook/rules/default.json` (the rules whose `from` is `komorebi-asc`), translated by `apps/desktop/scripts/nook-rules.ts` | [komorebi-application-specific-configuration](https://github.com/LGUG2Z/komorebi-application-specific-configuration) at `6f385ea` (a separate repository from komorebi) | `applications.json` | MIT, Copyright (c) 2024 Jade Iqbal (the license text is kept in the file's `source` block) |

Projects Hearth borrows ideas from without copying code: Macro (macro-inc/macro, AGPLv3),
Twenty (twentyhq/twenty, AGPLv3 and MIT parts), and for Nook's window manager komorebi
(LGUG2Z/komorebi, Komorebi License 2.0.0), GlazeWM (glzr-io/glazewm, GPL-3.0) and Seelen UI
(eythaann/Seelen-UI, AGPL-3.0). The canvas's data shape
(`packages/core/src/canvas.ts`) and its arrows' side and curve rules
(`apps/web/src/canvas/geometry.ts`) follow Macro's block-canvas, written anew.
