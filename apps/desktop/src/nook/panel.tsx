// Nook's panel (docs/nook-wm.md, "OPT-IN FLOW", step 2): what Nook sees while it observes. The
// monitors, every window with the verdict Nook would give it and why, and proof that nothing was
// changed, and the bar's switch. It is a local page in Hearth's app; it talks only to nook_ui and
// listens only for 'nook://state' and 'nook://chrome', which carries the theme.

import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import type {
  ChromeView,
  MonitorView,
  NookState,
  VerdictName,
  WindowView,
} from "@/bindings";
import { ask, newer, onState } from "./api";
import { applyChrome, bootTheme } from "./chrome";
import { copy } from "./copy";
import { newerChrome, tauriLink } from "./link";
import "./nook.css";
import "./panel.css";

bootTheme();

type Filter = VerdictName | "all";
const FILTERS: Filter[] = ["all", "tile", "float", "ignore"];

function Monitor({ m }: { m: MonitorView }) {
  return (
    <li className="monitor" data-managed={m.managed}>
      <div className="monitor-name">
        <span>{m.name}</span>
        {m.primary && <span className="tag">{copy.primary}</span>}
      </div>
      <div className="monitor-size">
        {copy.size(m.rect.width, m.rect.height, m.dpi)}
      </div>
      <div className="monitor-note">
        {m.managed ? copy.arranged : copy.leftAlone}
        {m.note && (
          <span className="muted">
            {copy.sep}
            {m.note}
          </span>
        )}
      </div>
    </li>
  );
}

function Row({ w }: { w: WindowView }) {
  const state = copy.state[w.state];
  return (
    <tr>
      <td>
        <div className="app">{w.app}</div>
        <div className="muted mono">
          {w.exe ?? w.class}
          {w.exe && (
            <span>
              {copy.sep}
              {w.class}
            </span>
          )}
        </div>
      </td>
      <td>
        <span className={`verdict verdict-${w.verdict}`}>
          {copy.verdict[w.verdict]}
        </span>
      </td>
      <td>
        <div>{w.why}</div>
        {(state || w.sticky) && (
          <div className="muted">
            {[state, w.sticky ? copy.sticky : ""]
              .filter(Boolean)
              .join(copy.sep)}
          </div>
        )}
      </td>
      <td className="muted">{w.monitor ?? ""}</td>
    </tr>
  );
}

function Windows({ windows }: { windows: WindowView[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, tile: 0, float: 0, ignore: 0 };
    for (const w of windows) {
      c.all += 1;
      c[w.verdict] += 1;
    }
    return c;
  }, [windows]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return windows.filter(
      (w) =>
        (filter === "all" || w.verdict === filter) &&
        (q === "" ||
          w.app.toLowerCase().includes(q) ||
          w.class.toLowerCase().includes(q) ||
          (w.exe ?? "").toLowerCase().includes(q)),
    );
  }, [windows, filter, query]);
  return (
    <section aria-labelledby="windows-title">
      <h2 id="windows-title">{copy.windowsTitle}</h2>
      <p className="muted">{copy.windowsHint}</p>
      <div className="toolbar">
        <div
          className="segmented"
          role="group"
          aria-label={copy.columns.verdict}
        >
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? copy.all : copy.verdict[f]}
              <span className="count">{counts[f]}</span>
            </button>
          ))}
        </div>
        <input
          type="search"
          value={query}
          placeholder={copy.search}
          aria-label={copy.search}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {shown.length === 0 ? (
        <p className="empty">
          {windows.length === 0 ? copy.loading : copy.nothingMatches}
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">{copy.columns.app}</th>
              <th scope="col">{copy.columns.verdict}</th>
              <th scope="col">{copy.columns.why}</th>
              <th scope="col">{copy.columns.monitor}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((w) => (
              <Row key={w.id} w={w} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Panel() {
  const [state, setState] = useState<NookState | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const [chrome, setChrome] = useState<ChromeView | null>(null);

  const take = (next: NookState) =>
    setState((current) => (newer(current, next) ? next : current));
  const takeChrome = (next: ChromeView) =>
    setChrome((current) => (newerChrome(current, next) ? next : current));

  useEffect(() => {
    if (chrome) applyChrome(chrome);
  }, [chrome]);

  useEffect(() => {
    const unlisten = onState(take);
    tauriLink.onChrome(takeChrome);
    ask({ kind: "ready" })
      .then((reply) => {
        take(reply.state);
        takeChrome(reply.chrome);
      })
      .catch((e: unknown) => setMessage(copy.failed(String(e))));
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  const run = async (cmd: Parameters<typeof ask>[0]) => {
    setBusy(true);
    setMessage("");
    try {
      const reply = await ask(cmd);
      take(reply.state);
      takeChrome(reply.chrome);
      if (reply.saved) setMessage(copy.savedTo(reply.saved));
    } catch (e) {
      setMessage(copy.failed(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  if (state === null) {
    return <main className="nook loading">{copy.loading}</main>;
  }
  const observing = state.mode === "observing";
  return (
    <main className="nook">
      <header>
        <div className="title-row">
          <h1>{copy.title}</h1>
          <span className="tag">{copy.preview}</span>
        </div>
        <p className="intro">{copy.intro}</p>
        <p className="mode" role="status">
          <span className={`dot ${observing ? "on" : ""}`} aria-hidden="true" />
          {observing ? copy.observing : copy.off}
          {!observing && state.why_off && (
            <span className="muted">
              {copy.sep}
              {state.why_off}
            </span>
          )}
        </p>
      </header>

      {state.elevated && <p className="note">{copy.elevated}</p>}

      <div className="cards">
        <section className="card" aria-labelledby="writes-title">
          <h2 id="writes-title">{copy.writesTitle}</h2>
          <p>{copy.writes(state.writes.refused, state.writes.landed)}</p>
        </section>
        <section className="card">
          <label className="switch">
            <input
              type="checkbox"
              checked={state.observe}
              disabled={busy}
              onChange={(e) =>
                void run({ kind: "set_observe", on: e.target.checked })
              }
            />
            <span>{copy.observeLabel}</span>
          </label>
          <p className="muted">{copy.observeHint}</p>
        </section>
        <section className="card">
          <label className="switch">
            <input
              type="checkbox"
              checked={chrome?.bar.on ?? false}
              disabled={busy || chrome === null}
              onChange={(e) =>
                void run({ kind: "set_bar", on: e.target.checked })
              }
            />
            <span>{copy.barLabel}</span>
          </label>
          <p className="muted">{chrome?.bar.why_not ?? copy.barHint}</p>
        </section>
        <section className="card">
          <label className="switch">
            <input
              type="checkbox"
              checked={chrome?.dock.on ?? false}
              disabled={busy || chrome === null}
              onChange={(e) =>
                void run({ kind: "set_dock", on: e.target.checked })
              }
            />
            <span>{copy.dockLabel}</span>
          </label>
          <p className="muted">{chrome?.dock.why_not ?? copy.dockHint}</p>
        </section>
        {state.gates.length > 0 && (
          <section className="card" aria-labelledby="gates-title">
            <h2 id="gates-title">{copy.gatesTitle}</h2>
            <ul className="plain">
              {state.gates.map((g) => (
                <li key={g.name}>{g.text}</li>
              ))}
            </ul>
          </section>
        )}
        {state.problems.length > 0 && (
          <section className="card" aria-labelledby="problems-title">
            <h2 id="problems-title">{copy.problemsTitle}</h2>
            <ul className="plain">
              {state.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <section aria-labelledby="monitors-title">
        <h2 id="monitors-title">{copy.monitorsTitle}</h2>
        <ul className="monitors">
          {state.monitors.map((m) => (
            <Monitor key={m.id} m={m} />
          ))}
        </ul>
      </section>

      {observing && <Windows windows={state.windows} />}

      <footer>
        <div className="actions">
          <button
            type="button"
            disabled={busy || !observing}
            onClick={() => void run({ kind: "refresh" })}
          >
            {copy.refresh}
          </button>
          <button
            type="button"
            disabled={busy || !observing}
            onClick={() => void run({ kind: "save_fixtures" })}
          >
            {copy.saveFixtures}
          </button>
          <button
            type="button"
            disabled={busy || !observing}
            onClick={() => void run({ kind: "export_diag" })}
          >
            {copy.exportDiag}
          </button>
        </div>
        {message && (
          <p className="message" role="status">
            {message}
          </p>
        )}
      </footer>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Panel />
  </React.StrictMode>,
);
