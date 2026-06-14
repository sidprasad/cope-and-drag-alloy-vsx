import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CnDServerClient } from './cndServerClient';
import { SterlingProvider, SterlingInstance } from './sterlingProvider';
import { openCndWebview, disposeCndWebview, reloadCndWebview } from './cndWebview';
import { resolveJava, resolveAlloyJar } from './resolve';
import { obtainAlloyJar } from './downloadAlloy';
import { AlloyCommandCodeLensProvider } from './codeLens';
import { startAlloyLsp } from './languageClient';
import { activateDiagnostics } from './diagnostics';
import { cndSidecarPath, readCndSpec, injectVisualizer } from './cndSpec';

let cndClient: CnDServerClient | undefined;
let provider: SterlingProvider | undefined;
let currentFile: string | undefined;
let currentCommand: string | undefined;
let lastRawXml: string | undefined;
let currentTemporal = false;
let specWatcher: vscode.FileSystemWatcher | undefined;
let specReloadTimer: ReturnType<typeof setTimeout> | undefined;
let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Alloy + Cope and Drag');
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('alloy.openCnd', () => openActiveFile(context)),
    vscode.commands.registerCommand('alloy.runCommand', (uri: vscode.Uri, index: number) =>
      runFileCommand(context, uri, index)
    ),
    vscode.commands.registerCommand('alloy.reloadCnd', () => reloadCndLayout()),
    vscode.languages.registerCodeLensProvider({ language: 'alloy' }, new AlloyCommandCodeLensProvider()),
    { dispose: tearDown }
  );

  logBundledCndVersion(context);

  // On-save error checking via Alloy's compiler (the bridge's `check`), published as diagnostics.
  activateDiagnostics(context);

  // Nav features (symbols/def/refs/rename) via the Alloy jar's language server — independent of the
  // visualizer. No-op if no Alloy jar is available yet; retried after one is obtained.
  startAlloyLsp(context);
}

export function deactivate(): void {
  tearDown();
}

/**
 * Log the bundled Cope and Drag build to the output channel so the running version is visible
 * during debug. The build stamps itself in media/copeanddrag/version.json (see scripts/fetch-cnd.js
 * and bundle-assets.js); locally that's whatever you last pulled/bundled, which can differ from the
 * release the Publish workflow ships.
 */
function logBundledCndVersion(context: vscode.ExtensionContext): void {
  try {
    const raw = fs.readFileSync(context.asAbsolutePath(path.join('media', 'copeanddrag', 'version.json')), 'utf8');
    const v = JSON.parse(raw);
    output.appendLine(`Cope and Drag v${v.version} (${v.build} build, built ${v.timestamp})`);
  } catch {
    output.appendLine('Cope and Drag: bundled build version unknown (no media/copeanddrag/version.json).');
  }
}

/** "Open Cope and Drag" (title bar): open the session for the active file and run its first command. */
async function openActiveFile(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document.fileName.endsWith('.als')) {
    vscode.window.showInformationMessage('Open an Alloy (.als) file, then run "Open Cope and Drag".');
    return;
  }
  await editor.document.save();
  if (!(await ensureSession(context, editor.document.fileName))) return;
  await runIndex(0);
}

/** A "Run/Check in Cope and Drag" CodeLens: open the session for the file and run that command. */
async function runFileCommand(context: vscode.ExtensionContext, uri: vscode.Uri, index: number): Promise<void> {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  if (doc && doc.isDirty) await doc.save();
  if (!(await ensureSession(context, uri.fsPath))) return;
  await runIndex(index);
}

/** Ensure a CnDServer + Sterling provider + webview are live for `file` (reusing if already open). */
async function ensureSession(context: vscode.ExtensionContext, file: string): Promise<boolean> {
  if (currentFile === file && cndClient && provider) return true;
  tearDown();

  const java = resolveJava();
  let { jar: alloyJar, source } = resolveAlloyJar(context) as { jar?: string; source: string };
  if (!alloyJar) {
    alloyJar = await obtainAlloyJar(context);
    source = 'downloaded';
    if (!alloyJar) return false; // declined or failed (already reported)
  }

  const serverJar = context.asAbsolutePath(path.join('server', 'cnd-alloy-server.jar'));
  if (!fs.existsSync(alloyJar)) {
    vscode.window.showErrorMessage(`Alloy jar not found at ${alloyJar} (from ${source}). Set "alloy.jarPath".`);
    return false;
  }
  if (!fs.existsSync(serverJar)) {
    vscode.window.showErrorMessage(`Bridge jar missing at ${serverJar}. Run "npm run bundle" in the extension folder.`);
    return false;
  }
  output.appendLine(`[alloy] java: ${java}`);
  output.appendLine(`[alloy] alloy jar (${source}): ${alloyJar}`);

  // A jar is now available — start the language server if it wasn't already (idempotent).
  startAlloyLsp(context);

  const client = new CnDServerClient(java, alloyJar, serverJar, (m) => output.append(m));
  try {
    await client.start(file);
  } catch (e) {
    vscode.window.showErrorMessage(
      `Could not start the Alloy backend: ${e instanceof Error ? e.message : String(e)}. ` +
        `Check Java 17+ ("alloy.javaPath") and that the Alloy jar is 6.x ("alloy.jarPath").`
    );
    return false;
  }
  cndClient = client;

  provider = new SterlingProvider({
    getGenerators: () => client.list(),
    run: async (name) => {
      const cmds = await client.list();
      const r = await client.run(name ? Math.max(0, cmds.indexOf(name)) : 0);
      return buildInstance(r.xml, r.command ?? '', r.temporal);
    },
    fork: async (state) => {
      const r = await client.fork(state);
      return buildInstance(r.xml, currentCommand ?? '', r.temporal);
    },
    evaluate: (expr) => client.evaluate(expr),
    // Surface a failed enumeration/run from a graph-header button (e.g. "There are no more
    // satisfying instances.") transiently, so a deliberate click isn't a silent no-op.
    notify: (message) => void vscode.window.setStatusBarMessage(`Alloy: ${message}`, 4000)
  });
  const wsPort = await provider.start();
  // Closing the panel tears the whole session down (kills the Java backend + ws server), so the
  // next "Open Cope and Drag" starts fresh rather than reusing stale state.
  await openCndWebview(context, wsPort, () => tearDown());
  currentFile = file;
  watchSpec(file);
  return true;
}

/**
 * Build a Sterling instance from raw Alloy XML: splice in the sidecar `.cnd` layout (if any) and tag
 * it with the command name. The command tag is what makes the layout persist across enumeration —
 * Cope and Drag keys a datum's layout spec by its generator name. Also records the raw XML so an
 * edited `.cnd` can be re-applied to this same instance (see reloadCndLayout).
 */
function buildInstance(rawXml: string, command: string, temporal = false): SterlingInstance {
  lastRawXml = rawXml;
  currentCommand = command;
  currentTemporal = temporal;
  const spec = currentFile ? readCndSpec(currentFile) : undefined;
  return { id: 'i' + idCounter(), xml: injectVisualizer(rawXml, spec), generatorName: command, temporal };
}

/** Watch the model's sidecar `.cnd` so saving it re-applies the layout (debounced). */
function watchSpec(file: string): void {
  disposeSpecWatcher();
  const sidecar = cndSidecarPath(file);
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(path.dirname(sidecar), path.basename(sidecar))
  );
  const schedule = () => {
    if (specReloadTimer) clearTimeout(specReloadTimer);
    specReloadTimer = setTimeout(() => reloadCndLayout(), 250);
  };
  watcher.onDidChange(schedule);
  watcher.onDidCreate(schedule);
  watcher.onDidDelete(schedule);
  specWatcher = watcher;
}

function disposeSpecWatcher(): void {
  if (specReloadTimer) {
    clearTimeout(specReloadTimer);
    specReloadTimer = undefined;
  }
  specWatcher?.dispose();
  specWatcher = undefined;
}

/**
 * Re-read the sidecar `.cnd` and re-apply it to the instance currently on screen by reloading the
 * Cope and Drag iframe (which resets CnD's per-command layout cache so the new spec takes effect).
 * Invoked by the "Reload Cope and Drag Layout" command and automatically when the `.cnd` is saved.
 */
function reloadCndLayout(): void {
  if (!provider || lastRawXml === undefined || currentCommand === undefined) return;
  const spec = currentFile ? readCndSpec(currentFile) : undefined;
  provider.setCurrent({
    id: 'i' + idCounter(),
    xml: injectVisualizer(lastRawXml, spec),
    generatorName: currentCommand,
    temporal: currentTemporal
  });
  reloadCndWebview();
}

/** Run the command at `index` and push the instance to the visualizer. */
async function runIndex(index: number): Promise<void> {
  if (!cndClient || !provider) return;
  try {
    const r = await cndClient.run(index);
    provider.pushInstance(buildInstance(r.xml, r.command ?? '', r.temporal));
  } catch (e) {
    vscode.window.showWarningMessage(`Alloy: ${e instanceof Error ? e.message : String(e)}`);
  }
}

let counter = 0;
function idCounter(): string {
  return String(++counter);
}

function tearDown(): void {
  disposeSpecWatcher();
  disposeCndWebview();
  provider?.dispose();
  provider = undefined;
  cndClient?.dispose();
  cndClient = undefined;
  currentFile = undefined;
  currentCommand = undefined;
  lastRawXml = undefined;
  currentTemporal = false;
}
