#!/usr/bin/env node
/*
 * Prepares everything the extension ships with — fork-free:
 *   1. compiles the Alloy bridge (alloy-bridge/CnDServer.java) against an Alloy jar
 *      -> server/cnd-alloy-server.jar
 *   2. copies that Alloy jar                                    -> server/org.alloytools.alloy.dist.jar
 *   3. copies the Cope and Drag forge bundle                    -> media/copeanddrag/
 *
 * The bridge only *calls* Alloy's public API, so any compatible Alloy jar works (bring your own).
 *
 * Requires a JDK 11+ (for javac/jar). Configure via env:
 *   JAVA_HOME  - JDK to compile the bridge with (default: `javac`/`jar` on PATH)
 *   ALLOY_JAR  - the Alloy Analyzer jar (default: ../mainline-alloy build output)
 *   CND_DIST   - the Cope and Drag forge build (default: ../../../spytial-org/copeanddrag/dist)
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const t1710 = path.resolve(root, '..');

const ALLOY_JAR =
  process.env.ALLOY_JAR ||
  path.join(t1710, 'mainline-alloy', 'org.alloytools.alloy.dist', 'target', 'org.alloytools.alloy.dist.jar');
const CND_DIST =
  process.env.CND_DIST || path.resolve(t1710, '..', '..', 'spytial-org', 'copeanddrag', 'dist');

const JAVA_HOME = process.env.JAVA_HOME || '';
const javac = JAVA_HOME ? path.join(JAVA_HOME, 'bin', 'javac') : 'javac';
const jartool = JAVA_HOME ? path.join(JAVA_HOME, 'bin', 'jar') : 'jar';

const serverDir = path.join(root, 'server');
const mediaDir = path.join(root, 'media', 'copeanddrag');
const bridgeSrc = path.join(root, 'alloy-bridge', 'src', 'org', 'alloytools', 'cnd', 'CnDServer.java');
const bridgeOut = path.join(root, 'build', 'bridge-out');

function fail(msg) {
  console.error(`\n[bundle] ${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(ALLOY_JAR)) fail(`Alloy jar not found:\n  ${ALLOY_JAR}\nBuild it or set ALLOY_JAR.`);

// 1. compile the bridge against the Alloy jar
fs.rmSync(bridgeOut, { recursive: true, force: true });
fs.mkdirSync(bridgeOut, { recursive: true });
fs.mkdirSync(serverDir, { recursive: true });
console.log(`[bundle] compiling bridge (${javac}) against ${path.basename(ALLOY_JAR)}`);
try {
  execSync(`"${javac}" -cp "${ALLOY_JAR}" -d "${bridgeOut}" "${bridgeSrc}"`, { stdio: 'inherit' });
  execSync(
    `"${jartool}" cfe "${path.join(serverDir, 'cnd-alloy-server.jar')}" org.alloytools.cnd.CnDServer -C "${bridgeOut}" .`,
    { stdio: 'inherit' }
  );
} catch (e) {
  fail(`Failed to build the bridge. Set JAVA_HOME to a JDK 11+ (current javac: ${javac}).`);
}
console.log('[bundle] bridge -> server/cnd-alloy-server.jar');

// 2. copy the Alloy jar
fs.copyFileSync(ALLOY_JAR, path.join(serverDir, 'org.alloytools.alloy.dist.jar'));
console.log('[bundle] alloy  -> server/org.alloytools.alloy.dist.jar');

// 3. copy the Cope and Drag forge bundle
if (!fs.existsSync(path.join(CND_DIST, 'index.html')))
  fail(`Cope and Drag forge bundle not found:\n  ${CND_DIST}\nRun "yarn build:forge" in copeanddrag, or set CND_DIST.`);
fs.rmSync(mediaDir, { recursive: true, force: true });
fs.mkdirSync(mediaDir, { recursive: true });
fs.cpSync(CND_DIST, mediaDir, { recursive: true });
console.log('[bundle] cnd    -> media/copeanddrag/');

console.log('[bundle] done.');
