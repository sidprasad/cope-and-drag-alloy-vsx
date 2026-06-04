#!/usr/bin/env node
/*
 * Prepares what the extension ships — note it does NOT bundle the Alloy jar (the extension
 * downloads that at runtime, or uses an auto-detected / configured one):
 *   1. compiles the Alloy bridge (alloy-bridge/CnDServer.java) against a pinned Alloy release
 *      (downloaded once into build/)  ->  server/cnd-alloy-server.jar
 *   2. copies the Cope and Drag Alloy build  ->  media/copeanddrag/
 *
 * Requires a JDK 17+ (javac/jar). Configure via env:
 *   JAVA_HOME  - JDK to compile the bridge with (default: javac/jar on PATH)
 *   ALLOY_JAR  - Alloy jar to compile against (default: download the pinned release into build/)
 *   CND_DIST   - the Cope and Drag Alloy build (`build:alloy`; default: ../../../spytial-org/copeanddrag/dist)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

// Pinned, verified-compatible Alloy release. Keep in sync with src/downloadAlloy.ts.
const ALLOY_VERSION = '6.2.0';
const ALLOY_URL = `https://github.com/AlloyTools/org.alloytools.alloy/releases/download/v${ALLOY_VERSION}/org.alloytools.alloy.dist.jar`;

const root = path.resolve(__dirname, '..');
const buildDir = path.join(root, 'build');
const serverDir = path.join(root, 'server');
const mediaDir = path.join(root, 'media', 'copeanddrag');
const bridgeSrc = path.join(root, 'alloy-bridge', 'src', 'org', 'alloytools', 'cnd', 'CnDServer.java');
const bridgeOut = path.join(buildDir, 'bridge-out');
const CND_DIST = process.env.CND_DIST || path.resolve(root, '..', '..', '..', 'spytial-org', 'copeanddrag', 'dist');

const JAVA_HOME = process.env.JAVA_HOME || '';
const javac = JAVA_HOME ? path.join(JAVA_HOME, 'bin', 'javac') : 'javac';
const jartool = JAVA_HOME ? path.join(JAVA_HOME, 'bin', 'jar') : 'jar';

function fail(msg) {
  console.error(`\n[bundle] ${msg}\n`);
  process.exit(1);
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    https
      .get(url, (res) => {
        const s = res.statusCode || 0;
        if (s >= 300 && s < 400 && res.headers.location) {
          res.resume();
          return resolve(download(res.headers.location, dest, redirects + 1));
        }
        if (s !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${s}`));
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
      })
      .on('error', reject);
  });
}

async function main() {
  // 1. Alloy jar to compile the bridge against (downloaded, cached in build/; NOT bundled).
  let alloyJar = process.env.ALLOY_JAR && fs.existsSync(process.env.ALLOY_JAR) ? process.env.ALLOY_JAR : '';
  if (!alloyJar) {
    fs.mkdirSync(buildDir, { recursive: true });
    alloyJar = path.join(buildDir, `alloy-${ALLOY_VERSION}.dist.jar`);
    if (!fs.existsSync(alloyJar)) {
      console.log(`[bundle] downloading Alloy ${ALLOY_VERSION} to compile the bridge against...`);
      await download(ALLOY_URL, alloyJar).catch((e) => fail(`download failed: ${e.message}`));
    }
  }
  console.log(`[bundle] compile against: ${alloyJar}`);

  // 2. compile the bridge (fresh server/ so no stale bundled jar lingers)
  fs.rmSync(serverDir, { recursive: true, force: true });
  fs.mkdirSync(serverDir, { recursive: true });
  fs.rmSync(bridgeOut, { recursive: true, force: true });
  fs.mkdirSync(bridgeOut, { recursive: true });
  try {
    execSync(`"${javac}" -cp "${alloyJar}" -d "${bridgeOut}" "${bridgeSrc}"`, { stdio: 'inherit' });
    execSync(
      `"${jartool}" cfe "${path.join(serverDir, 'cnd-alloy-server.jar')}" org.alloytools.cnd.CnDServer -C "${bridgeOut}" .`,
      { stdio: 'inherit' }
    );
  } catch {
    fail(`Failed to build the bridge. Set JAVA_HOME to a JDK 17+ (current javac: ${javac}).`);
  }
  console.log('[bundle] bridge -> server/cnd-alloy-server.jar');

  // 3. copy the Cope and Drag Alloy build (the Alloy jar is intentionally NOT bundled)
  if (!fs.existsSync(path.join(CND_DIST, 'index.html')))
    fail(`Cope and Drag Alloy build not found:\n  ${CND_DIST}\nRun "yarn build:alloy" in copeanddrag, or set CND_DIST.`);
  fs.rmSync(mediaDir, { recursive: true, force: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.cpSync(CND_DIST, mediaDir, { recursive: true });
  console.log('[bundle] cnd    -> media/copeanddrag/');

  // 3a. The Alloy build hardcodes its Sterling URL (ws://localhost:4000/alloy); the extension
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
