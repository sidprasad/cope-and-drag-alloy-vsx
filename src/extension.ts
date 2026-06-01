import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CnDServerClient } from './cndServerClient';
import { SterlingProvider } from './sterlingProvider';
import { openCndWebview, disposeCndWebview } from './cndWebview';
import { resolveJava, resolveAlloyJar } from './resolve';
import { obtainAlloyJar } from './downloadAlloy';
import { AlloyCommandCodeLensProvider } from './codeLens';
import { startAlloyLsp } from './languageClient';

let cndClient: CnDServerClient | undefined;
let provider: SterlingProvider | undefined;
let currentFile: string | undefined;
let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Alloy + Cope and Drag');
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('alloy.openCnd', () => openActiveFile(context)),
    vscode.commands.registerCommand('alloy.runCommand', (uri: vscode.Uri, index: number) =>
      runFileCommand(context, uri, index)
    ),
    vscode.languages.registerCodeLensProvider({ language: 'alloy' }, new AlloyCommandCodeLensProvider()),
    { dispose: tearDown }
  );

  // Editor features (diagnostics/hover/nav) via the Alloy jar's language server — independent of
  // the visualizer. No-op if no Alloy jar is available yet; retried after one is obtained.
  startAlloyLsp(context);
}

export function deactivate(): void {
  tearDown();
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
      return { id: 'i' + idCounter(), xml: r.xml, generatorName: r.command };
    },
    next: async () => ({ id: 'i' + idCounter(), xml: await client.next() }),
    evaluate: (expr) => client.evaluate(expr)
  });
  const wsPort = await provider.start();
  await openCndWebview(context, wsPort);
  currentFile = file;
  return true;
}

/** Run the command at `index` and push the instance to the visualizer. */
async function runIndex(index: number): Promise<void> {
  if (!cndClient || !provider) return;
  try {
    const r = await cndClient.run(index);
    provider.pushInstance({ id: 'i' + idCounter(), xml: r.xml, generatorName: r.command });
  } catch (e) {
    vscode.window.showWarningMessage(`Alloy: ${e instanceof Error ? e.message : String(e)}`);
  }
}

let counter = 0;
function idCounter(): string {
  return String(++counter);
}

function tearDown(): void {
  disposeCndWebview();
  provider?.dispose();
  provider = undefined;
  cndClient?.dispose();
  cndClient = undefined;
  currentFile = undefined;
}
