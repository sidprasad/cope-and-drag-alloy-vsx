# Cope and Drag for Alloy

A VS Code extension that pairs the **Alloy Analyzer** with the **Cope and Drag** visualizer in a
webview. Run a command in a `.als` file and explore the instance in CnD with full interactivity —
**instances + evaluator + next/previous enumeration** — straight from Alloy's own engine.

This extension **forks nothing**. It uses upstream Alloy's *public API* through a small bridge, and
stock Cope and Drag (`build:forge`, unmodified).

## How it works

```
.als ─"Open Cope and Drag"─▶ extension spawns
        java -cp <alloy.jar>:<cnd-alloy-server.jar> org.alloytools.cnd.CnDServer <port> <file>
                                          │  (calls the Alloy Analyzer API: run / next / eval)
                                          │  line-based JSON socket
   Sterling provider (Node, in-extension) ─── Sterling ws ──▶ <iframe> Cope and Drag (build:forge)
        bridges CnD's Sterling protocol to the CnDServer socket
```

- **`alloy-bridge/`** — `CnDServer.java`, a ~150-line program that *calls* Alloy's API
  (`execute_commandFromBook`, `A4Solution.next()`/`.eval()`, `A4SolutionWriter.writeInstance`). It
  does not modify Alloy, so it runs against any compatible Alloy jar (bring your own).
- **`src/`** — the VS Code extension: `cndServerClient.ts` (spawn + socket), `sterlingProvider.ts`
  (the Sterling websocket server CnD connects to), `cndWebview.ts` (serve CnD + iframe), `extension.ts`.

## Build & run (dev)

Prerequisites: **JDK 11+** (to compile the bridge and run Alloy), Node 18+, an Alloy jar, and a CnD
`build:forge` bundle.

```bash
npm install

# Compile the bridge + bundle the Alloy jar and CnD dist (set JAVA_HOME to a JDK 17+):
JAVA_HOME=/path/to/jdk-17 npm run bundle

npm run compile
```

`npm run bundle` writes `server/cnd-alloy-server.jar`, `server/org.alloytools.alloy.dist.jar`, and
`media/copeanddrag/` (all gitignored). Override the inputs with `ALLOY_JAR` and `CND_DIST`.

Then open this folder in VS Code and press **F5**. In the dev host, open a `.als` file and run
**"Open Cope and Drag"** (the editor-title graph icon). The first command runs automatically; use
CnD's UI to pick other commands, evaluate expressions, and step through instances.

## Finding Alloy & Java (auto-detect or bring your own)

Both are resolved automatically; override either if needed.

**Alloy jar** — `alloy.jarPath` → `ALLOY_JAR` env → an auto-detected **Alloy 6+** install
(workspace, `~/Downloads`, `~/Desktop`, `/Applications`) → the bundled jar. Older Alloy (5.x) is
skipped (it lacks the API + enumerable solver this needs). So you can just drop a recent Alloy jar
in your Downloads, or point `alloy.jarPath` at one — the bridge only calls Alloy's *public API*, so
any reasonably recent 6.x jar works.

**Java** — `alloy.javaPath` → `JAVA_HOME` → the newest installed **JDK 17+** (via
`/usr/libexec/java_home` on macOS, common JVM dirs elsewhere) → `java`. The bundled Alloy build is
Java-17 bytecode, so a JDK 17+ is required; auto-detect finds it even if your default `java` is older.

## Settings

- `alloy.javaPath` — explicit Java 17+ executable (otherwise auto-detected).
- `alloy.jarPath` — explicit Alloy 6+ jar (otherwise auto-detected, then bundled).
