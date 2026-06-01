import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CnDServerClient } from './cndServerClient';
import { SterlingProvider, SterlingInstance } from './sterlingProvider';
import { openCndWebview, disposeCndWebview } from './cndWebview';
import { resolveJava, resolveAlloyJar } from './resolve';
import { obtainAlloyJar } from './downloadAlloy';

let cndClient: CnDServerClient | undefined;
let provider: SterlingProvider | undefined;
let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Alloy + Cope and Drag');
  context.subscriptions.push(output);
  context.subscriptions.push(
    vscode.commands.registerCommand('alloy.openCnd', () => openForActiveFile(context))
  );
  context.subscriptions.push({ dispose: tearDown });
}

export function deactivate(): void {
  tearDown();
}

async function openForActiveFile(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document.fileName.endsWith('.als')) {
    vscode.window.showInformationMessage('Open an Alloy (.als) file, then run "Open Cope and Drag".');
    return;
  }
  await editor.document.save();
  const file = editor.document.fileName;

  // Restart the backend for this file (a fresh CnDServer process + provider).
  tearDown();

  const java = resolveJava();
  const resolution = resolveAlloyJar(context);
  let alloyJar = resolution.jar;
  let source: string = resolution.source;

  // Nothing found locally — offer to download the pinned Alloy release (or pick a local jar).
  if (!alloyJar) {
    alloyJar = await obtainAlloyJar(context);
    source = 'downloaded';
    if (!alloyJar) return; // user declined or the download failed (already reported)
  }

  const serverJar = context.asAbsolutePath(path.join('server', 'cnd-alloy-server.jar'));
  if (!fs.existsSync(alloyJar)) {
    vscode.window.showErrorMessage(`Alloy jar not found at ${alloyJar} (from ${source}). Set "alloy.jarPath".`);
    return;
  }
  if (!fs.existsSync(serverJar)) {
    vscode.window.showErrorMessage(`Bridge jar missing at ${serverJar}. Run "npm run bundle" in the extension folder.`);
    return;
  }
  output.appendLine(`[alloy] java: ${java}`);
  output.appendLine(`[alloy] alloy jar (${source}): ${alloyJar}`);

  cndClient = new CnDServerClient(java, alloyJar, serverJar, (m) => output.append(m));
  try {
    await cndClient.start(file);
  } catch (e) {
    vscode.window.showErrorMessage(
      `Could not start the Alloy backend: ${e instanceof Error ? e.message : String(e)}. ` +
        `Check Java 17+ ("alloy.javaPath") and that the Alloy jar is 6.x ("alloy.jarPath").`
    );
    tearDown();
    return;
  }

  const client = cndClient;
  const handlers = {
    getGenerators: () => client.list(),
    run: async (name: string | undefined): Promise<SterlingInstance> => {
      const cmds = await client.list();
      const index = name ? Math.max(0, cmds.indexOf(name)) : 0;
      const r = await client.run(index);
      return { id: 'i' + idCounter(), xml: r.xml, generatorName: r.command };
    },
    next: async (): Promise<SterlingInstance> => ({ id: 'i' + idCounter(), xml: await client.next() }),
    evaluate: (expr: string) => client.evaluate(expr)
  };

  provider = new SterlingProvider(handlers);
  const wsPort = await provider.start();

  await openCndWebview(context, wsPort);

  // Run the first command so the visualizer isn't empty; the user can pick others in CnD's UI.
  try {
    const cmds = await client.list();
    if (cmds.length) provider.pushInstance(await handlers.run(undefined));
    else vscode.window.showInformationMessage('This Alloy file has no commands to run.');
  } catch (e) {
    output.appendLine(`[alloy] initial run failed: ${e instanceof Error ? e.message : e}`);
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
}
