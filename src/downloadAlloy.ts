import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import * as vscode from 'vscode';

// Pinned, verified-compatible Alloy release (has the bridge's API + enumerates).
// Keep in sync with scripts/bundle-assets.js (the bridge is compiled against this same release).
export const ALLOY_VERSION = '6.2.0';
const ALLOY_URL = `https://github.com/AlloyTools/org.alloytools.alloy/releases/download/v${ALLOY_VERSION}/org.alloytools.alloy.dist.jar`;

/** Path to the Alloy jar previously downloaded into the extension's global storage, if present. */
export function cachedAlloyJar(context: vscode.ExtensionContext): string | undefined {
  const p = cachePath(context);
  return fs.existsSync(p) ? p : undefined;
}

function cachePath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, `alloy-${ALLOY_VERSION}.dist.jar`);
}

/**
 * Obtain an Alloy jar when none was found: prompt to download the pinned release (cached in global
 * storage) or to pick a local jar. Returns the jar path, or undefined if the user declines/fails.
 */
export async function obtainAlloyJar(context: vscode.ExtensionContext): Promise<string | undefined> {
  const cached = cachedAlloyJar(context);
  if (cached) return cached;

  const choice = await vscode.window.showInformationMessage(
    `No Alloy Analyzer found. Download Alloy ${ALLOY_VERSION} (~20 MB, one time), or point at a local jar?`,
    { modal: false },
    'Download Alloy',
    'Select Jar…'
  );
  if (choice === 'Select Jar…') return pickJar();
  if (choice !== 'Download Alloy') return undefined;

  const dest = cachePath(context);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading Alloy ${ALLOY_VERSION}`, cancellable: false },
      (progress) => fetchToFile(ALLOY_URL, dest, progress)
    );
    return dest;
  } catch (e) {
    try { fs.unlinkSync(dest); } catch { /* ignore */ }
    const retry = await vscode.window.showErrorMessage(
      `Couldn't download Alloy: ${e instanceof Error ? e.message : String(e)}.`,
      'Select Jar…'
    );
    return retry === 'Select Jar…' ? pickJar() : undefined;
  }
}

/** Let the user pick a local Alloy jar; persists it to `alloy.jarPath`. */
async function pickJar(): Promise<string | undefined> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Use this Alloy jar',
    filters: { 'Alloy jar': ['jar'] }
  });
  if (!uris || uris.length === 0) return undefined;
  const jar = uris[0].fsPath;
  await vscode.workspace.getConfiguration('alloy').update('jarPath', jar, vscode.ConfigurationTarget.Global);
  return jar;
}

/** Download `url` to `dest`, following GitHub's redirects, reporting percent progress. */
function fetchToFile(
  url: string,
  dest: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  redirects = 0
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('too many redirects'));
      return;
    }
    https
      .get(url, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve(fetchToFile(res.headers.location, dest, progress, redirects + 1));
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        let lastPct = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (total > 0) {
            const pct = Math.floor((received / total) * 100);
            if (pct > lastPct) {
              progress.report({ increment: pct - lastPct, message: `${pct}%` });
              lastPct = pct;
            }
          }
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
        res.on('error', reject);
      })
      .on('error', reject);
  });
}
