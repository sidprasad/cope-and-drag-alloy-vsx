import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Cope and Drag in a VS Code webview.
 *
 * We ship CnD's **Alloy** build (`build:alloy`), which starts with the explorer drawer collapsed so
 * the graph shows immediately. That build hardcodes its Sterling websocket URL to
 * `ws://localhost:4000/alloy`; since our Sterling provider binds an *ephemeral* port, the loopback
 * HTTP server rewrites that one literal to the live port (`ws://localhost:<wsPort>/alloy`) as it
 * serves the JS. CnD is embedded in an <iframe> pointed at `http://127.0.0.1:<staticPort>/` and
 * connects directly to the Sterling provider (backed by the Alloy Analyzer) over that websocket.
 */

let panel: vscode.WebviewPanel | undefined;
let server: http.Server | undefined;
let staticPort: number | undefined;
let lastFrameUri: vscode.Uri | undefined;
let reloadToken = 0;
// The Alloy build compiles in this fixed Sterling URL; we rewrite it to the live provider port as
// we serve the JS (see the file header). Set whenever the panel is (re)opened.
const CND_WS_LITERAL = 'ws://localhost:4000/alloy';
let currentWsPort: number | undefined;
// Called when the user closes the panel (so the extension can tear the session down). Cleared
// before a programmatic dispose so closing it ourselves doesn't re-enter teardown.
let onClose: (() => void) | undefined;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.xml': 'application/xml'
};

function ensureServer(root: string): Promise<number> {
  if (server && staticPort) return Promise.resolve(staticPort);
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      try {
        const rawPath = decodeURIComponent((req.url || '/').split('?')[0]);
        const rel = rawPath === '/' ? 'index.html' : rawPath.replace(/^\/+/, '');
        let filePath = path.join(root, rel);
        if (!path.resolve(filePath).startsWith(path.resolve(root) + path.sep)) {
          res.statusCode = 403;
          res.end('Forbidden');
          return;
        }
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          filePath = path.join(root, 'index.html');
        }
        const ext = path.extname(filePath).toLowerCase();
        res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
        // Rewrite the Alloy build's hardcoded Sterling URL to our live ephemeral port. The literal
        // lives in main.bundle.js, but we scan every .js chunk so a CnD reshuffle can't break it.
        if (ext === '.js' && currentWsPort) {
          const js = fs
            .readFileSync(filePath, 'utf8')
            .split(CND_WS_LITERAL)
            .join(`ws://localhost:${currentWsPort}/alloy`);
          res.end(js);
        } else {
          fs.createReadStream(filePath).pipe(res);
        }
      } catch {
        res.statusCode = 500;
        res.end('Internal error');
      }
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        server = srv;
        staticPort = addr.port;
        resolve(addr.port);
      } else {
        reject(new Error('Could not start the Cope and Drag static server.'));
      }
    });
  });
}

/**
 * Open (or refresh) the Cope and Drag panel, pointing CnD at the given Sterling websocket port.
 * `closeCb` is invoked if the user closes the panel, so the caller can tear the session down.
 */
export async function openCndWebview(
  context: vscode.ExtensionContext,
  wsPort: number,
  closeCb?: () => void
): Promise<void> {
  const root = context.asAbsolutePath(path.join('media', 'copeanddrag'));
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    vscode.window.showErrorMessage(
      'The Cope and Drag bundle is missing. Run "npm run bundle" in the extension (client) folder.'
    );
    return;
  }

  currentWsPort = wsPort; // the served JS is rewritten to dial this port (see file header)
  const port = await ensureServer(root);
  const frameUri = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${port}/`));
  lastFrameUri = frameUri;
  onClose = closeCb;
  const html = getHtml(frameUri);

  if (panel) {
    panel.webview.html = html;
    panel.reveal(vscode.ViewColumn.Beside, true);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'alloyCnd',
    'Cope and Drag',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.onDidDispose(() => {
    panel = undefined;
    // User closed the window — hand off to the teardown callback (cleared first so it runs once).
    const cb = onClose;
    onClose = undefined;
    cb?.();
  });
  panel.webview.html = html;
}

/**
 * Reload the Cope and Drag iframe (same Sterling port), discarding CnD's in-memory layout state so
 * an edited spec is re-seeded from the replayed instance. No-op if the panel isn't open.
 */
export function reloadCndWebview(): void {
  if (!panel || !lastFrameUri) return;
  reloadToken++; // change the outer document so VS Code re-renders it, forcing a fresh iframe load
  panel.webview.html = getHtml(lastFrameUri);
}

export function disposeCndWebview(): void {
  onClose = undefined; // we're closing it ourselves — don't fire the user-close callback
  panel?.dispose();
  panel = undefined;
  lastFrameUri = undefined;
  currentWsPort = undefined;
  if (server) {
    server.close();
    server = undefined;
    staticPort = undefined;
  }
}

function getHtml(frameUri: vscode.Uri): string {
  const src = frameUri.toString(true);
  const frameOrigin = `${frameUri.scheme}://${frameUri.authority}`;
  // The iframe is a normal http origin (no CSP of its own), so CnD's scripts, the d3 CDN load, and
  // the ws:// connection all happen inside it. `https:` in frame-src covers the d3 CDN.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<!-- reload ${reloadToken} -->
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; frame-src ${frameOrigin} https:; style-src 'unsafe-inline';" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; width: 100%; overflow: hidden; }
  iframe { display: block; border: 0; height: 100%; width: 100%; }
</style>
</head>
<body>
<iframe src="${src}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
</body>
</html>`;
}
