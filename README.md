# Cope and Drag for Alloy

Pairs the **Alloy Analyzer** with the **[Cope and Drag](https://github.com/sidprasad/copeanddrag)** (CnD)
visualizer inside VS Code. Run a command in a `.als` model and explore the instance in a webview with
full interactivity — **instances, evaluator, and next/previous enumeration** — straight from Alloy's
own engine.

It **forks nothing**: it drives upstream Alloy through its public API via a tiny bridge, and embeds
stock Cope and Drag unmodified.

## Features

- **Visualize in Cope and Drag** — open any `.als` and run a command; the instance renders in a CnD
  webview beside your editor.
- **Full interactivity** — pick commands, evaluate expressions in CnD's REPL, and step through
  instances (next/previous) using Alloy's own solver.
- **Run / Check CodeLens** — a one-click ▶ above every `run` / `check` command.
- **Custom layouts via sidecar `.cnd` files** — describe how an instance should be drawn (the same
  spec language Forge embeds in its XML). A model `foo.als` automatically pairs with `foo.cnd`; save
  it and the open visualization re-lays-out live.
- **`.cnd` syntax highlighting** — YAML structure plus highlighting for CnD constraints, directives,
  and options, with comment/bracket editing support.
- **On-save error checking** — Alloy's own parser/type-checker surfaces errors and warnings as
  squiggles.
- **Editor navigation** — symbols, definitions, references, and rename via Alloy's bundled language
  server.
- **Bring your own Alloy** — no jar is bundled; a compatible Alloy 6+ install is auto-detected, or
  downloaded on demand (cached), or pointed at via a setting.

## Requirements

- **JDK 17+** — auto-detected (`JAVA_HOME`, then `/usr/libexec/java_home` / common JVM locations),
  or set `alloy.javaPath`. The Alloy release is Java-17 bytecode, so a 17+ runtime is required even
  if your default `java` is older.
- **Alloy 6+** — auto-detected from your workspace, `~/Downloads`, `~/Desktop`, `/Applications`, or a
  prior download; otherwise the extension offers to download a pinned release once, or set
  `alloy.jarPath`.

## Quick start

1. Open a `.als` file.
2. Click **Open Cope and Drag** (the graph icon in the editor title bar), or use the ▶ **Run**
   CodeLens above a command.
3. Explore the instance in the CnD panel — evaluate expressions, switch commands, and step through
   instances.

## Custom layouts (`.cnd` sidecar)

Create a `foo.cnd` next to `foo.als` to control the visualization — for example:

```yaml
constraints:
  - cyclic:
      selector: next
      direction: clockwise
directives:
  - flag: hideDisconnectedBuiltIns
  - attribute:
      field: value
```

The spec is attached to every instance (and persists across enumeration). Saving the `.cnd` re-applies
the layout to the open visualization; the **Alloy: Reload Cope and Drag Layout** command does the same
on demand.

## Settings

- `alloy.javaPath` — explicit Java 17+ executable (otherwise auto-detected).
- `alloy.jarPath` — explicit Alloy 6+ jar (otherwise auto-detected, then downloaded on demand).

## How it works

```
.als ─"Open Cope and Drag"─▶ extension spawns
        java -cp <alloy.jar>:<cnd-alloy-server.jar> org.alloytools.cnd.CnDServer <port> <file>
                                          │  (calls the Alloy API: run / fork / eval)
                                          │  line-based JSON socket
   Sterling provider (Node, in-extension) ── Sterling ws ─▶ <iframe> Cope and Drag
```

The bridge (`alloy-bridge/CnDServer.java`) only *calls* Alloy's public API
(`execute_commandFromBook`, `A4Solution.fork(int)`/`.eval()`, `A4SolutionWriter.writeInstance`), so it
runs against any compatible Alloy jar. Enumeration goes through `fork(int)`, the primitive behind the
Analyzer's trace buttons (`next()` is `fork(-3)`); for temporal models the explorer offers New Config,
New Trace, and New Init. The extension translates between that socket and the Sterling websocket
protocol Cope and Drag speaks.

The bundled Cope and Drag is its **Alloy** build — the explorer drawer is collapsed by default, so a
run opens straight to the graph. That build hardcodes its websocket URL, so the extension rewrites it
to the live provider port as it serves the bundle.

## Building from source

Prerequisites: **JDK 17+**, **Node 18+**, and a Cope and Drag `build:alloy` bundle.

```bash
npm install
# CND_DIST is a Cope and Drag dist built with `yarn build:alloy`
JAVA_HOME=/path/to/jdk-17 CND_DIST=/path/to/copeanddrag/dist npm run bundle
npm run compile
```

`npm run bundle` writes `server/cnd-alloy-server.jar` (the bridge) and `media/copeanddrag/`. No Alloy
jar is packaged — it's downloaded at runtime or auto-detected. Press **F5** to launch an Extension
Development Host.

## License

[MIT](LICENSE)
