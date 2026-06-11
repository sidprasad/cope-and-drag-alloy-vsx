#!/usr/bin/env node
/*
 * Prepares what the extension ships — note it does NOT bundle the Alloy jar (the extension
 * downloads that at runtime, or uses an auto-detected / configured one):
 *   1. compiles the Alloy bridge  ->  server/cnd-alloy-server.jar   (delegated to build-bridge.js)
 *   2. copies the Cope and Drag Alloy build  ->  media/copeanddrag/
 *
 * To rebuild only the jar (e.g. after editing CnDServer.java) without touching media/, run the jar
 * half directly: `npm run build:bridge`.
 *
 * Requires a JDK 17+ (javac/jar). Configure via env:
 *   JAVA_HOME  - JDK to compile the bridge with (default: javac/jar on PATH)
 *   ALLOY_JAR  - Alloy jar to compile against (default: download the pinned release into build/)
 *   CND_DIST   - the Cope and Drag Alloy build (`build:alloy`; default: ../../../spytial-org/copeanddrag/dist)
 */
const fs = require('fs');
const path = require('path');
const { buildBridge } = require('./build-bridge');

const root = path.resolve(__dirname, '..');
const mediaDir = path.join(root, 'media', 'copeanddrag');
const CND_DIST = process.env.CND_DIST || path.resolve(root, '..', '..', '..', 'spytial-org', 'copeanddrag', 'dist');

function fail(msg) {
  console.error(`\n[bundle] ${msg}\n`);
  process.exit(1);
}

async function main() {
  // 1. compile the bridge into server/cnd-alloy-server.jar (downloads a pinned Alloy to compile against).
  await buildBridge();

  // 2. copy the Cope and Drag Alloy build (the Alloy jar is intentionally NOT bundled)
  if (!fs.existsSync(path.join(CND_DIST, 'index.html')))
    fail(`Cope and Drag Alloy build not found:\n  ${CND_DIST}\nRun "yarn build:alloy" in copeanddrag, or set CND_DIST.`);
  fs.rmSync(mediaDir, { recursive: true, force: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.cpSync(CND_DIST, mediaDir, { recursive: true });
  console.log('[bundle] cnd    -> media/copeanddrag/');

  // 2a. The Alloy build hardcodes its Sterling URL (ws://localhost:4000/alloy); the extension
  // rewrites it to the live ephemeral port at serve time (see src/cndWebview.ts). Fail loudly if
  // it's missing/duplicated so we never ship a bundle that can't connect (e.g. a forge build).
  const WS_LITERAL = 'ws://localhost:4000/alloy';
  const jsFiles = fs.readdirSync(mediaDir).filter((f) => f.endsWith('.js'));
  let wsHits = 0;
  for (const f of jsFiles) wsHits += fs.readFileSync(path.join(mediaDir, f), 'utf8').split(WS_LITERAL).length - 1;
  if (wsHits !== 1)
    fail(
      `Expected exactly one "${WS_LITERAL}" across media/copeanddrag/*.js (the Alloy build's\n` +
        `  Sterling URL the extension rewrites at runtime) but found ${wsHits}. Did you build CnD with\n` +
        `  "build:alloy" (or use sterling-alloy.zip)?  CND_DIST=${CND_DIST}`
    );
  console.log('[bundle] verified Alloy Sterling URL literal (rewritten to the live port at serve time)');

  console.log('[bundle] done — Alloy jar is downloaded at runtime, not bundled.');
}

main().catch((e) => fail(e.message));
