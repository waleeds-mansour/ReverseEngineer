// Builds nook-guard.exe, the small program that puts Nook's windows back when Hearth can't
// (docs/nook-wm.md, "Architecture"), and copies it to where Tauri's externalBin looks for it:
// src-tauri/binaries/nook-guard-<target triple>.exe. `tauri build` runs this first on Windows
// (tauri.windows.conf.json), and src-tauri/build.rs refuses a production build without it, so an
// installer never ships without the real guard.
//
// The guard is its own Cargo workspace with its own Cargo.lock (crates/nook-restore), built with
// --locked so a release can't quietly pick up other dependency versions. It links the C runtime
// statically: it runs from its own folder after Hearth's is gone (an uninstall), where the
// VC++ runtime Hearth ships beside itself isn't, so it must not need one. The build checks the
// program it made for runtime imports and stops if it finds any.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const tauriDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src-tauri",
);
const manifest = join(tauriDir, "crates", "nook-restore", "Cargo.toml");

const rustc = execFileSync("rustc", ["-vV"], {
  encoding: "utf8",
  windowsHide: true,
});
const host = /^host: (\S+)$/m.exec(rustc)?.[1];
// Tauri names the triple it builds for; built by hand, it is this machine's.
const target = process.env.TAURI_ENV_TARGET_TRIPLE || host;
if (!target) {
  throw new Error(
    "Couldn't tell which target to build nook-guard for: rustc -vV names no host.",
  );
}

const STATIC_CRT = "-Ctarget-feature=+crt-static";
// --target always, so the flag reaches the guard alone and not the build scripts. RUSTFLAGS, when
// set, overrides every rustflags setting in cargo's config, so the flag joins it there instead.
const args = [
  "build",
  "--release",
  "--locked",
  "--manifest-path",
  manifest,
  "--bin",
  "nook-guard",
  "--target",
  target,
  "--message-format=json-render-diagnostics",
];
const env = { ...process.env };
if (env.CARGO_ENCODED_RUSTFLAGS) {
  env.CARGO_ENCODED_RUSTFLAGS += `\x1f${STATIC_CRT}`;
} else if (env.RUSTFLAGS) {
  env.RUSTFLAGS += ` ${STATIC_CRT}`;
} else {
  args.push("--config", `target.${target}.rustflags=["${STATIC_CRT}"]`);
}

// cargo's progress and errors go straight to this terminal; its JSON messages say where the
// program landed, which depends on CARGO_TARGET_DIR and --target.
const messages = execFileSync("cargo", args, {
  encoding: "utf8",
  env,
  stdio: ["ignore", "pipe", "inherit"],
  windowsHide: true,
  maxBuffer: 64 * 1024 * 1024,
});
let built: string | undefined;
for (const line of messages.split("\n")) {
  if (!line.startsWith("{")) continue;
  const message = JSON.parse(line);
  if (
    message.reason === "compiler-artifact" &&
    message.target?.name === "nook-guard"
  ) {
    built = message.executable ?? built;
  }
}
if (!built) throw new Error("cargo finished without building nook-guard.");

/** The DLLs a PE program imports, read from its import directory. */
function imports(exe: Buffer): string[] {
  const pe = exe.readUInt32LE(0x3c);
  if (exe.toString("latin1", pe, pe + 4) !== "PE\0\0") {
    throw new Error("nook-guard.exe isn't a Windows program.");
  }
  const sections = exe.readUInt16LE(pe + 6);
  const optional = pe + 24;
  const optionalSize = exe.readUInt16LE(pe + 20);
  const wide = exe.readUInt16LE(optional) === 0x20b;
  const directories = optional + (wide ? 112 : 96);
  const importRva = exe.readUInt32LE(directories + 8);
  const table = optional + optionalSize;
  const offset = (rva: number): number => {
    for (let i = 0; i < sections; i++) {
      const at = table + i * 40;
      const size = exe.readUInt32LE(at + 8);
      const start = exe.readUInt32LE(at + 12);
      if (rva >= start && rva < start + size) {
        return rva - start + exe.readUInt32LE(at + 20);
      }
    }
    throw new Error(`nook-guard.exe has no section for address ${rva}.`);
  };
  const names: string[] = [];
  if (importRva === 0) return names;
  for (let at = offset(importRva); ; at += 20) {
    const nameRva = exe.readUInt32LE(at + 12);
    if (nameRva === 0) break;
    const start = offset(nameRva);
    names.push(exe.toString("latin1", start, exe.indexOf(0, start)));
  }
  return names;
}

const runtime = imports(readFileSync(built)).filter((dll) =>
  /^(vcruntime|msvcp|ucrtbase|api-ms-win-crt-)/i.test(dll),
);
if (runtime.length > 0) {
  throw new Error(
    `nook-guard.exe needs the C runtime (${runtime.join(", ")}); it must link it statically.`,
  );
}

const staged = join(tauriDir, "binaries", `nook-guard-${target}.exe`);
mkdirSync(dirname(staged), { recursive: true });
copyFileSync(built, staged);
// The copy keeps cargo's build time, which can be older than build.rs's last run. A fresh time
// makes cargo run build.rs again, so tauri-build copies the real guard over a stand-in.
const now = new Date();
utimesSync(staged, now, now);
console.log(`nook-guard: ${staged}`);
