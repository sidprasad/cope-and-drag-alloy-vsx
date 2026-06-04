# Changelog

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
