#!/usr/bin/env node
/*
 * Bundles the extension's own TypeScript (src/extension.ts + its imports + the npm runtime
 * deps: vscode-languageclient, ws, adm-zip) into a single dist/extension.js. This is the
 * "bundle your extension" step the Marketplace recommends — it speeds up activation and
 * ships one file instead of a tree of out/*.js.
 *
 * It does NOT touch the Cope and Drag webapp under media/ (that is served to the webview as
 * static files, not required at activation) or the Java bridge under server/. Those are handled
 * by scripts/bundle-assets.js.
 *
 *   node esbuild.js              dev build (sourcemap, unminified)
 *   node esbuild.js --production minified, no sourcemap (used by vscode:prepublish)
 *   node esbuild.js --watch      rebuild on change
 */
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile: 'dist/extension.js',
    // `vscode` is provided by the host, never bundle it. bufferutil / utf-8-validate are
    // optional native speedups for `ws` that are not installed — keep them external so esbuild
    // doesn't fail trying to resolve them (ws falls back to its JS implementation).
    external: ['vscode', 'bufferutil', 'utf-8-validate'],
    minify: production,
    sourcemap: !production,
    logLevel: 'info'
  });

  if (watch) {
    await ctx.watch();
    console.log('[esbuild] watching...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
