#!/usr/bin/env node
/*
 * Update the pinned Cope and Drag release in .github/workflows/publish.yml — the release the
 * Publish workflow downloads `sterling-alloy.zip` from to bundle into the extension.
 *
 *   npm run update:cnd               # bump the pin to copeanddrag's latest release
 *   npm run update:cnd -- --dry-run  # print the latest release + what would change, write nothing
 *   npm run update:cnd -- vX.Y.Z     # pin a specific release tag instead of "latest"
 *
 * Verifies the target release actually has a `sterling-alloy.zip` asset before writing, so we never
 * pin a release the workflow can't build from. Set GITHUB_TOKEN to avoid the API rate limit.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const CND_REPO = 'sidprasad/copeanddrag'; // keep in sync with the download URL in publish.yml
const ASSET = 'sterling-alloy.zip';
const workflow = path.resolve(__dirname, '..', '.github', 'workflows', 'publish.yml');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const explicitTag = args.find((a) => /^v\d+\.\d+\.\d+/.test(a));

function fail(msg) {
  console.error(`[update-cnd] ${msg}`);
  process.exit(1);
}

function getJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const headers = { 'User-Agent': 'cope-and-drag-alloy-update-cnd', Accept: 'application/vnd.github+json' };
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

async function main() {
  const url = explicitTag
    ? `https://api.github.com/repos/${CND_REPO}/releases/tags/${explicitTag}`
    : `https://api.github.com/repos/${CND_REPO}/releases/latest`;
  const release = await getJson(url).catch((e) =>
    fail(`could not fetch ${explicitTag || 'latest'} release from ${CND_REPO}: ${e.message}`)
  );
  const tag = release.tag_name;
  if (!tag) fail(`no tag_name in the release response from ${CND_REPO}`);

  // Never pin a release the workflow can't build from.
  if (!(release.assets || []).some((a) => a.name === ASSET))
    fail(`release ${tag} has no ${ASSET} asset — the Publish workflow needs it. Pick another release.`);

  const yml = fs.readFileSync(workflow, 'utf8');
  const current = (yml.match(/cnd_release\s*\|\|\s*'(v\d+\.\d+\.\d+)'/) || [])[1] || '(unknown)';

  // Both pins live in publish.yml: the workflow_dispatch default and the CND_RELEASE fallback.
  let count = 0;
  const updated = yml
    .replace(/(default:\s*)'v\d+\.\d+\.\d+'/, (_, p) => (count++, `${p}'${tag}'`))
    .replace(/(cnd_release\s*\|\|\s*)'v\d+\.\d+\.\d+'/, (_, p) => (count++, `${p}'${tag}'`));

  if (count !== 2)
    fail(`expected to update 2 pins in publish.yml but matched ${count} — has the workflow changed? Update by hand.`);

  if (current === tag) {
    console.log(`[update-cnd] already pinned to ${tag} (latest from ${CND_REPO}) — nothing to do.`);
    return;
  }

  if (dryRun) {
    console.log(`[update-cnd] dry run: would bump Cope and Drag ${current} -> ${tag} in ${path.relative(process.cwd(), workflow)}.`);
    return;
  }

  fs.writeFileSync(workflow, updated);
  console.log(`[update-cnd] bumped Cope and Drag ${current} -> ${tag} in ${path.relative(process.cwd(), workflow)}.`);
  console.log('[update-cnd] next: add a CHANGELOG entry, bump "version" in package.json, commit, then `npm run tag` to publish.');
}

main().catch((e) => fail(e.message));
