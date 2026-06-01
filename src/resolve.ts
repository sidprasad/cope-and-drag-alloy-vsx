import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import AdmZip from 'adm-zip';

// The bundled Alloy 6.3 build is compiled to Java 17 bytecode. resolveJava prefers the newest
// JDK anyway, so this is just the floor for what counts as "usable".
const MIN_JAVA = 17;
const MIN_ALLOY_MAJOR = 6;

// ─── Java ──────────────────────────────────────────────────────────────────────

/**
 * Resolve a Java 17+ executable: `alloy.javaPath` → JAVA_HOME → OS auto-detect → `java`.
 * The bundled Alloy Analyzer needs Java 17+; the machine's default `java` may be older.
 */
export function resolveJava(): string {
  const configured = vscode.workspace.getConfiguration('alloy').get<string>('javaPath');
  if (configured && configured.trim()) return configured.trim();

  const candidates: string[] = [];
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', javaExe()));
  candidates.push(...detectJavaHomes().map((h) => path.join(h, 'bin', javaExe())));

  // Prefer the newest suitable JDK.
  let best: { java: string; major: number } | undefined;
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    const major = javaMajor(c);
    if (major >= MIN_JAVA && (!best || major > best.major)) best = { java: c, major };
  }
  return best?.java ?? 'java';
}

/** Major Java version of a `java` executable (8 for "1.8.x", 17 for "17.x"), or 0 on failure. */
function javaMajor(javaBin: string): number {
  try {
    const r = spawnSync(javaBin, ['-version'], { encoding: 'utf8' });
    const out = `${r.stderr || ''}${r.stdout || ''}`;
    const m = /version "(\d+)(?:\.(\d+))?/.exec(out);
    if (!m) return 0;
    const major = parseInt(m[1], 10);
    return major === 1 ? parseInt(m[2] || '0', 10) : major;
  } catch {
    return 0;
  }
}

function detectJavaHomes(): string[] {
  const homes: string[] = [];
  if (process.platform === 'darwin') {
    try {
      const out = spawnSync('/usr/libexec/java_home', ['-v', `${MIN_JAVA}+`], { encoding: 'utf8' });
      if (out.status === 0 && out.stdout.trim()) homes.push(out.stdout.trim());
    } catch {
      /* ignore */
    }
    homes.push(...listDirs('/Library/Java/JavaVirtualMachines').map((d) => path.join(d, 'Contents', 'Home')));
  } else if (process.platform === 'win32') {
    homes.push(...listDirs('C:\\Program Files\\Java'), ...listDirs('C:\\Program Files\\Eclipse Adoptium'));
  } else {
    homes.push(...listDirs('/usr/lib/jvm'), ...listDirs('/usr/java'));
  }
  return homes;
}

function javaExe(): string {
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

// ─── Alloy jar ─────────────────────────────────────────────────────────────────

export type AlloyJarSource = 'configured' | 'env' | 'detected' | 'bundled' | 'none';
export interface AlloyJarResolution {
  jar?: string;
  source: AlloyJarSource;
}

/**
 * Resolve an Alloy jar: `alloy.jarPath` → `ALLOY_JAR` → auto-detected install (Alloy 6+) →
 * the jar bundled with the extension. Configured/env paths are trusted as-is.
 */
export function resolveAlloyJar(context: vscode.ExtensionContext): AlloyJarResolution {
  const configured = vscode.workspace.getConfiguration('alloy').get<string>('jarPath');
  if (configured && configured.trim()) return { jar: configured.trim(), source: 'configured' };

  if (process.env.ALLOY_JAR && fs.existsSync(process.env.ALLOY_JAR)) {
    return { jar: process.env.ALLOY_JAR, source: 'env' };
  }

  const detected = detectAlloyJar();
  if (detected) return { jar: detected, source: 'detected' };

  const bundled = context.asAbsolutePath(path.join('server', 'org.alloytools.alloy.dist.jar'));
  if (fs.existsSync(bundled)) return { jar: bundled, source: 'bundled' };

  return { source: 'none' };
}

/** Find the newest Alloy 6+ jar in the workspace and common download/install locations. */
function detectAlloyJar(): string | undefined {
  const dirs = [
    ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    path.join(os.homedir(), 'Downloads'),
    path.join(os.homedir(), 'Desktop'),
    os.homedir(),
    '/Applications'
  ];

  const found: Array<{ jar: string; major: number; mtime: number }> = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/\.jar$/i.test(name) || !/alloy/i.test(name)) continue;
      const jar = path.join(dir, name);
      if (seen.has(jar)) continue;
      seen.add(jar);
      const major = alloyMajorVersion(jar);
      if (major >= MIN_ALLOY_MAJOR) {
        found.push({ jar, major, mtime: mtimeOf(jar) });
      }
    }
  }
  found.sort((a, b) => b.major - a.major || b.mtime - a.mtime);
  return found[0]?.jar;
}

/** Read the Alloy major version from a jar's MANIFEST.MF `Bundle-Version`, or 0 if not an Alloy jar. */
function alloyMajorVersion(jar: string): number {
  try {
    const entry = new AdmZip(jar).getEntry('META-INF/MANIFEST.MF');
    if (!entry) return 0;
    const m = /Bundle-Version:\s*(\d+)/i.exec(entry.getData().toString('utf8'));
    return m ? parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

// ─── small fs helpers ────────────────────────────────────────────────────────────

function listDirs(parent: string): string[] {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(parent, d.name));
  } catch {
    return [];
  }
}

function mtimeOf(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}
