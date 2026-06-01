#!/usr/bin/env node
/*
 * Tag the current commit as v<package.json version> and push it, which triggers the Publish
 * workflow (.github/workflows/publish.yml) to build and publish that version.
 *
 *   npm run tag              # create + push the tag
 *   npm run tag -- --dry-run # print what it would do, change nothing
 *
 * Refuses to run if package.json has uncommitted changes (the CI guard compares the tag to the
 * tagged commit's package.json, so the version bump must be committed first) or if the tag exists.
 */
const { execSync } = require('child_process');
const pkg = require('../package.json');

const dryRun = process.argv.includes('--dry-run');
const tag = `v${pkg.version}`;

function git(args, opts = {}) {
  return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString().trim();
}
function fail(msg) {
  console.error(`[tag-release] ${msg}`);
  process.exit(1);
}

// 1. The version bump must be committed, or the tagged commit's package.json won't match the tag.
if (git('status --porcelain -- package.json')) {
  fail('package.json has uncommitted changes — commit the version bump before tagging.');
}

// 2. Don't reuse a version (the Marketplace rejects republishing, and the tag would be ambiguous).
let exists = false;
try {
  execSync(`git rev-parse -q --verify refs/tags/${tag}`, { stdio: 'ignore' });
  exists = true;
} catch {
  /* tag does not exist — good */
}
if (exists) fail(`tag ${tag} already exists — bump "version" in package.json first.`);

const head = git('rev-parse --short HEAD');

if (dryRun) {
  console.log(`[tag-release] dry run: would create annotated tag ${tag} at ${head} and push it to origin.`);
  process.exit(0);
}

console.log(`[tag-release] tagging ${tag} at ${head} and pushing to origin...`);
execSync(`git tag -a ${tag} -m "Release ${tag}"`, { stdio: 'inherit' });
execSync(`git push origin ${tag}`, { stdio: 'inherit' });
console.log(`[tag-release] pushed ${tag}. The Publish workflow will build and publish ${pkg.version}.`);
