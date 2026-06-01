import * as fs from 'fs';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';
import { resolveJava, resolveAlloyJar } from './resolve';

let client: LanguageClient | undefined;

/**
 * Start the Alloy language server bundled in the Alloy jar (`java -jar <alloy> lsp`, stdio) for
 * editor features: diagnostics, hover, go-to-definition, references, symbols, rename.
 *
 * This is independent of the Cope and Drag visualizer — running commands / enumeration go through
 * CnDServer, not this server — so the language server never touches the "next" path. We also hide
 * the server's own CodeLenses (which would launch Alloy's built-in visualizer); our CodeLens
 * provider supplies "Run in Cope and Drag" instead.
 *
 * Idempotent and best-effort: a no-op if already running or if no Alloy jar is available yet (it's
 * retried once a jar is obtained). Java/jar are resolved the same way as the visualizer backend.
 */
export function startAlloyLsp(context: vscode.ExtensionContext): void {
  if (client) return;

  const { jar } = resolveAlloyJar(context);
  if (!jar || !fs.existsSync(jar)) return; // no jar yet — caller retries after one is obtained

  const executable = { command: resolveJava(), args: ['-jar', jar, 'lsp'] };
  const serverOptions: ServerOptions = { run: executable, debug: executable };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: 'alloy' }],
    middleware: {
      // Suppress the server's "run command" CodeLenses (they'd trigger Alloy's own visualizer);
      // our provider contributes "Run in Cope and Drag" instead.
      provideCodeLenses: () => []
    }
  };

  client = new LanguageClient('alloyLanguageServer', 'Alloy Language Server', serverOptions, clientOptions);
  client.start().catch((e) => {
    void vscode.window.showWarningMessage(
      `Alloy language server didn't start: ${e instanceof Error ? e.message : String(e)}. ` +
        `Editor features (diagnostics, hover) are off; the visualizer still works.`
    );
    client = undefined;
  });
  context.subscriptions.push({ dispose: () => void client?.stop() });
}
