# Changelog

## 0.1.6 — Update Cope and Drag

- **Change:** bundle Cope and Drag **v4.0.13** (was v4.0.11). v4.0.13 reworks the Sterling drawer
  to surface its sections as tabs (with the Time section shown only for temporal traces) and adds
  Single / Sliding Window / Compare presentation modes to the Time panel for stepping through trace
  states. Like the v4.0.11 bump, these are presentation-only changes on the Cope and Drag side — the
  Sterling provider protocol (meta / data / click / eval, datum buttons) is unchanged, so the
  upgrade needed no extension changes beyond the bundle bump.

## 0.1.5 — Update Cope and Drag + trace navigation

- **Feature:** temporal (trace) instances now offer the Alloy Analyzer's trace-navigation
  buttons — **New Config**, **New Trace**, and **New Init** — each mapping to `A4Solution.fork(-1
  / -3 / 0)`; static instances keep a single **Next**. (Alloy's "New Fork" is omitted: it forks at
  the on-screen trace state, which the visualizer's click protocol doesn't surface to the bridge.)
  The Java bridge gains a generic `fork` op and reports a `temporal` flag. When a button's
  enumeration has no further instance, the solver's reason (e.g. "no more satisfying instances") is
  shown transiently in the status bar instead of the click silently doing nothing.
- **Change:** bundle Cope and Drag **v4.0.11** (was v4.0.10). v4.0.11 reworks the Sterling shell
  into a compact, de-branded layout tuned for the narrow VS Code webview (bottom-docked drawer,
  view-switcher dropdown, slimmer headers). The upgrade itself is a presentation-only refactor on
  the Cope and Drag side — the Sterling provider protocol (meta / data / click / eval, datum
  buttons) is unchanged, so it needed no extension changes beyond the bundle bump.

## 0.1.4 — Update Cope and Drag

- **Change:** bundle Cope and Drag **v4.0.10** (was v4.0.7).
- **Tooling:** `npm run update:cnd` bumps the bundled Cope and Drag release; `npm run cnd:fetch`
  pulls a release's Alloy build into `media/copeanddrag/` for local debug. Activation now logs the
  bundled Cope and Drag version to the output channel.

## 0.1.3 — Update Cope and Drag

- **Change:** bundle Cope and Drag **v4.0.7** (was v4.0.6).

## 0.1.2 — Open straight to the graph

- **Change:** bundle Cope and Drag's **Alloy** build instead of the Forge build, so a run opens
  straight to the graph with the explorer drawer collapsed (no more explorer panel by default). The
  Alloy build's hardcoded Sterling websocket URL is rewritten to the extension's live ephemeral port
  as the bundle is served, so instances, evaluation, and next/previous enumeration keep working.

## 0.1.1 — Fix activation

- **Fix:** the extension failed to activate (`Cannot find module 'ws'`) because its runtime
  dependencies were neither packaged nor bundled. The extension is now bundled with esbuild
  into a single `dist/extension.js`, so it activates without a `node_modules` tree.

## 0.1.0 — Initial release

- Open the **Cope and Drag** visualizer for an Alloy `.als` model in a webview, with full
  interactivity: instances, evaluator, and next/previous enumeration driven by Alloy's own engine.
- **Run / Check CodeLens** above each command.
- **Sidecar `.cnd` layout specs** (the spec language Forge embeds in its XML): a model `foo.als`
  pairs with `foo.cnd`, attached to every instance and live-applied on save. Includes the
  **Alloy: Reload Cope and Drag Layout** command.
- **`.cnd` syntax highlighting** + YAML editing (comments, brackets).
- **On-save diagnostics** via Alloy's parser/type-checker.
- **Editor navigation** (symbols, definitions, references, rename) via Alloy's language server.
- **Alloy syntax highlighting**.
- No bundled Alloy jar — auto-detect Alloy 6+ / JDK 17+, download on demand, or configure via
  `alloy.jarPath` / `alloy.javaPath`.
