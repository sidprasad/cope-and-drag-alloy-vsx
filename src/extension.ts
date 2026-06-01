import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CnDServerClient } from './cndServerClient';
import { SterlingProvider, SterlingInstance } from './sterlingProvider';
import { openCndWebview, disposeCndWebview } from './cndWebview';

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
  const alloyJar = resolveAlloyJar(context);
  const serverJar = context.asAbsolutePath(path.join('server', 'cnd-alloy-server.jar'));
  for (const [label, p] of [['Alloy jar', alloyJar], ['CnD server jar', serverJar]] as const) {
    if (!fs.existsSync(p)) {
      vscode.window.showErrorMessage(`${label} not found at ${p}. Run "npm run bundle" in the extension folder.`);
      return;
    }
  }

  cndClient = new CnDServerClient(java, alloyJar, serverJar, (m) => output.append(m));
  try {
    await cndClient.start(file);
  } catch (e) {
    vscode.window.showErrorMessage(
      `Could not start the Alloy backend: ${e instanceof Error ? e.message : String(e)}. ` +
        `Ensure Java 11+ is installed and set "alloy.javaPath" if needed.`
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

function resolveJava(): string {
  const configured = vscode.workspace.getConfiguration('alloy').get<string>('javaPath');
  if (configured && configured.trim().length > 0) return configured.trim();
  // The Alloy Analyzer requires Java 11+. JAVA_HOME (if newer) beats a possibly-old `java` on PATH.
  if (process.env.JAVA_HOME) {
    const j = path.join(process.env.JAVA_HOME, 'bin', 'java');
    if (fs.existsSync(j)) return j;
  }
  return 'java';
}

function resolveAlloyJar(context: vscode.ExtensionContext): string {
  const configured = vscode.workspace.getConfiguration('alloy').get<string>('jarPath');
  if (configured && configured.trim().length > 0) return configured.trim();
  return context.asAbsolutePath(path.join('server', 'org.alloytools.alloy.dist.jar'));
}

function tearDown(): void {
  disposeCndWebview();
  provider?.dispose();
  provider = undefined;
  cndClient?.dispose();
  cndClient = undefined;
}
