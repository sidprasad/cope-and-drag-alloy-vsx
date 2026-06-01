import * as vscode from 'vscode';

/**
 * Shows a "Run / Check in Cope and Drag" CodeLens above each Alloy command (`run` / `check`).
 *
 * Commands are matched by scanning the source top-to-bottom — which is the same order the Alloy
 * Analyzer itself reports them (verified) — so the Nth lens maps to command index N that the bridge
 * runs. Comments and string literals are masked first so keywords inside them don't count.
 */
export class AlloyCommandCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const masked = maskCommentsAndStrings(document.getText());
    const re = /\b(run|check)\b/g;
    const lenses: vscode.CodeLens[] = [];
    let index = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      const verb = m[1] === 'check' ? 'Check' : 'Run';
      const pos = document.positionAt(m.index);
      lenses.push(
        new vscode.CodeLens(new vscode.Range(pos, pos), {
          title: `$(play) ${verb} in Cope and Drag`,
          command: 'alloy.runCommand',
          arguments: [document.uri, index]
        })
      );
      index++;
    }
    return lenses;
  }
}

/** Blank out `/* *​/` and `//` / `--` comments and "string" literals, preserving length + newlines. */
function maskCommentsAndStrings(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(\/\/|--)[^\n]*/g, blank)
    .replace(/"(?:[^"\\]|\\.)*"/g, blank);
}

function blank(s: string): string {
  return s.replace(/[^\n]/g, ' ');
}
