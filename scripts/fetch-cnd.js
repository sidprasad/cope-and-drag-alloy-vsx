#!/usr/bin/env node
/*
 * Pull a prebuilt Cope and Drag (Alloy) dist into media/copeanddrag/ for LOCAL debug — the same
 * sterling-alloy.zip the Publish workflow ships, so F5 runs a real release build without needing a
 * copeanddrag checkout. (`npm run bundle:assets` instead copies from a local CND_DIST checkout.)
 *
 *   npm run cnd:fetch               # pull copeanddrag's latest release
 *   npm run cnd:fetch -- v4.0.7     # pull a specific release tag
 *   npm run cnd:fetch -- --pinned   # pull whatever publish.yml ships (match production locally)
 *
 * The F5 "watch" task only rebuilds the extension TS, never media/, so re-run this when you want a
 * newer Cope and Drag locally. Set GITHUB_TOKEN to avoid the API rate limit.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const AdmZip = require('adm-zip');

const CND_REPO = 'sidprasad/copeanddrag'; // keep in sync with publish.yml
const ASSET = 'sterling-alloy.zip';
const WS_LITERAL = 'ws://localhost:4000/alloy'; // the Alloy build's Sterling URL (see bundle-assets.js)

const root = path.resolve(__dirname, '..');
const buildDir = path.join(root, 'build');
const mediaDir = path.join(root, 'media', 'copeanddrag');
const workflow = path.join(root, '.github', 'workflows', 'publish.yml');

const args = process.argv.slice(2);
const explicitTag = args.find((a) => /^v\d+\.\d+\.\d+/.test(a));
const usePinned = args.includes('--pinned');

function fail(msg) {
  console.error(`[fetch-cnd] ${msg}`);
  process.exit(1);
}

function getJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const headers = { 'User-Agent': 'cope-and-drag-alloy-fetch-cnd', Accept: 'application/vnd.github+json' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    https
      .get(url, { headers }, (res) => {
        const s = res.statusCode || 0;
        if (s >= 300 && s < 400 && res.headers.location) {
          res.resume();
          return resolve(getJson(res.headers.location, redirects + 1));
        }
        if (s !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${s} for ${url}`));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    https
      .get(url, { headers: { 'User-Agent': 'cope-and-drag-alloy-fetch-cnd' } }, (res) => {
        const s = res.statusCode || 0;
        if (s >= 300 && s < 400 && res.headers.location) {
          res.resume();
          return resolve(download(res.headers.location, dest, redirects + 1));
        }
        if (s !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${s} for ${url}`));
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
      })
      .on('error', reject);
  });
}

function pinnedTag() {
  const yml = fs.readFileSync(workflow, 'utf8');
  const m = yml.match(/cnd_release\s*\|\|\s*'(v\d+\.\d+\.\d+)'/);
  if (!m) fail(`could not read the pinned release from ${path.relative(root, workflow)}`);
  return m[1];
}

async function resolveTag() {
  if (explicitTag) return explicitTag;
  if (usePinned) return pinnedTag();
  const latest = await getJson(`https://api.github.com/repos/${CND_REPO}/releases/latest`).catch((e) =>
    fail(`could not fetch latest release from ${CND_REPO}: ${e.message}`)
  );
  if (!latest.tag_name) fail(`no tag_name in the latest release response from ${CND_REPO}`);
  return latest.tag_name;
}

async function main() {
  const tag = await resolveTag();
  const url = `https://github.com/${CND_REPO}/releases/download/${tag}/${ASSET}`;

  fs.mkdirSync(buildDir, { recursive: true });
  const zipPath = path.join(buildDir, `${ASSET.replace('.zip', '')}-${tag}.zip`);
  console.log(`[fetch-cnd] downloading ${tag} ${ASSET}...`);
  await download(url, zipPath).catch((e) => fail(`download failed (${url}): ${e.message}`));

  // Fresh media/ so no stale files from the previous build linger.
  fs.rmSync(mediaDir, { recursive: true, force: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  try {
    new AdmZip(zipPath).extractAllTo(mediaDir, true);
  } catch (e) {
    fail(`could not extract ${zipPath}: ${e.message}`);
  }

  // Sanity-check it's a real Alloy build (mirrors bundle-assets.js), so we never serve a bad/forge zip.
  if (!fs.existsSync(path.join(mediaDir, 'index.html'))) fail(`${ASSET} for ${tag} has no index.html — wrong asset?`);
  const jsFiles = fs.readdirSync(mediaDir).filter((f) => f.endsWith('.js'));
  let wsHits = 0;
  for (const f of jsFiles) wsHits += fs.readFileSync(path.join(mediaDir, f), 'utf8').split(WS_LITERAL).length - 1;
  if (wsHits !== 1)
    fail(`expected exactly one "${WS_LITERAL}" across media/copeanddrag/*.js but found ${wsHits} — not an Alloy build?`);

  let stamp = '';
  try {
    const v = JSON.parse(fs.readFileSync(path.join(mediaDir, 'version.json'), 'utf8'));
    stamp = ` (reports v${v.version}, ${v.build} build, built ${v.timestamp})`;
  } catch {
    /* no version.json — older build */
  }
  console.log(`[fetch-cnd] media/copeanddrag/ now holds Cope and Drag ${tag}${stamp}.`);

  const pinned = pinnedTag();
  if (tag !== pinned)
    console.log(`[fetch-cnd] note: local debug is now ${tag} but the Publish workflow still ships ${pinned}.`);
}

main().catch((e) => fail(e.message));
