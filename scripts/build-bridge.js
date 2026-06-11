#!/usr/bin/env node
/*
 * Compiles the Alloy bridge (alloy-bridge/CnDServer.java) against a pinned Alloy release
 * (downloaded once into build/) -> server/cnd-alloy-server.jar. The Alloy jar itself is NOT bundled
 * (the extension downloads/auto-detects one at runtime); it's only a compile-time classpath here.
 *
 * This is the jar-only half of `bundle:assets` — it never touches media/copeanddrag/, so you can
 * rebuild the bridge after editing CnDServer.java without re-copying (and risking clobbering) the
 * Cope and Drag frontend. `bundle:assets` calls buildBridge() and then copies the CnD build on top.
 *
 *   npm run build:bridge        # compile the bridge into server/cnd-alloy-server.jar
 *
 * Requires a JDK 17+ (javac/jar). Configure via env:
 *   JAVA_HOME  - JDK to compile the bridge with (default: javac/jar on PATH)
 *   ALLOY_JAR  - Alloy jar to compile against (default: download the pinned release into build/)
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
const bridgeSrc = path.join(root, 'alloy-bridge', 'src', 'org', 'alloytools', 'cnd', 'CnDServer.java');
const bridgeOut = path.join(buildDir, 'bridge-out');

const JAVA_HOME = process.env.JAVA_HOME || '';
const javac = JAVA_HOME ? path.join(JAVA_HOME, 'bin', 'javac') : 'javac';
const jartool = JAVA_HOME ? path.join(JAVA_HOME, 'bin', 'jar') : 'jar';

function fail(msg) {
  console.error(`\n[bridge] ${msg}\n`);
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

/** Resolve an Alloy jar to compile against: ALLOY_JAR if set, else the pinned release (cached in build/). */
async function resolveAlloyJar() {
  if (process.env.ALLOY_JAR && fs.existsSync(process.env.ALLOY_JAR)) return process.env.ALLOY_JAR;
  fs.mkdirSync(buildDir, { recursive: true });
  const alloyJar = path.join(buildDir, `alloy-${ALLOY_VERSION}.dist.jar`);
  if (!fs.existsSync(alloyJar)) {
    console.log(`[bridge] downloading Alloy ${ALLOY_VERSION} to compile the bridge against...`);
    await download(ALLOY_URL, alloyJar).catch((e) => fail(`download failed: ${e.message}`));
  }
  return alloyJar;
}

/** Compile CnDServer.java and package it into server/cnd-alloy-server.jar. Returns nothing. */
async function buildBridge() {
  const alloyJar = await resolveAlloyJar();
  console.log(`[bridge] compile against: ${alloyJar}`);

  // Fresh server/ + bridge-out/ so no stale class/jar lingers.
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
  console.log('[bridge] bridge -> server/cnd-alloy-server.jar');
}

module.exports = { buildBridge };

if (require.main === module) {
  buildBridge().catch((e) => fail(e.message));
}
