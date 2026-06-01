import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveJava, resolveAlloyJar } from './resolve';

/**
 * On-save (and on-open) error checking for Alloy files. Runs the bridge's one-shot `check` —
 * Alloy's own parser + type-checker — and publishes the results as VS Code diagnostics.
 *
 * This is the same mainline-Alloy compiler the visualizer uses, but a separate short-lived process,
 * so it's completely independent of the Cope and Drag session (and the "next" path).
 */

let collection: vscode.DiagnosticCollection;
const inFlight = new Set<string>();

export function activateDiagnostics(context: vscode.ExtensionContext): void {
  collection = vscode.languages.createDiagnosticCollection('alloy');
  context.subscriptions.push(
    collection,
    vscode.workspace.onDidSaveTextDocument((doc) => check(context, doc)),
    vscode.workspace.onDidOpenTextDocument((doc) => check(context, doc)),
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri))
  );
  vscode.workspace.textDocuments.forEach((doc) => check(context, doc));
}

function check(context: vscode.ExtensionContext, doc: vscode.TextDocument): void {
  if (doc.languageId !== 'alloy' || doc.uri.scheme !== 'file') return;
  const file = doc.uri.fsPath;
  if (inFlight.has(file)) return;

  const { jar } = resolveAlloyJar(context);
  const serverJar = context.asAbsolutePath(path.join('server', 'cnd-alloy-server.jar'));
  if (!jar || !fs.existsSync(jar) || !fs.existsSync(serverJar)) return; // no Alloy yet — skip quietly

  inFlight.add(file);
  const classpath = [jar, serverJar].join(path.delimiter);
  const proc = spawn(resolveJava(), ['-cp', classpath, 'org.alloytools.cnd.CnDServer', 'check', file]);
  let out = '';
  proc.stdout.on('data', (d) => (out += d.toString()));
  proc.on('error', () => inFlight.delete(file));
  proc.on('exit', () => {
    inFlight.delete(file);
    let parsed: { diagnostics?: RawDiag[] };
    try {
      parsed = JSON.parse(lastJsonLine(out));
    } catch {
      return; // couldn't run / parse — leave existing diagnostics untouched
    }
    collection.set(doc.uri, (parsed.diagnostics || []).map(toDiagnostic));
  });
}

interface RawDiag {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  message: string;
  severity: string;
}

function toDiagnostic(d: RawDiag): vscode.Diagnostic {
  const range = new vscode.Range(d.line, d.col, d.endLine, d.endCol);
  const severity = d.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
  const diag = new vscode.Diagnostic(range, d.message, severity);
  diag.source = 'alloy';
  return diag;
}

/** The bridge prints one JSON object on stdout; pick the last `{...}` line, ignoring any JVM noise. */
function lastJsonLine(s: string): string {
  const lines = s.trim().split('\n').filter((l) => l.trim().startsWith('{'));
  return lines.length ? lines[lines.length - 1] : '{}';
}
