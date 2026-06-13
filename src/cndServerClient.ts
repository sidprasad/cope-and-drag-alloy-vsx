import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';

export interface Instance {
  command?: string;
  xml: string;
  /** True for temporal (trace) instances — gates the trace-only nav buttons (config/init/fork). */
  temporal?: boolean;
}

/**
 * Launches and talks to the Java {@code CnDServer} (which drives the mainline Alloy Analyzer).
 * One CnDServer process per open Alloy file. Requests are serialized (the server handles one at a
 * time): list commands, run a command, enumerate the next instance, evaluate an expression.
 */
export class CnDServerClient {
  private proc: ChildProcess | undefined;
  private sock: net.Socket | undefined;
  private buf = '';
  private inflight: ((resp: any) => void) | undefined;
  private readonly queue: Array<{ req: unknown; resolve: (r: any) => void }> = [];

  constructor(
    private readonly java: string,
    private readonly alloyJar: string,
    private readonly serverJar: string,
    private readonly log?: (msg: string) => void
  ) {}

  /** Spawn CnDServer for `file` and connect to it. Resolves once the socket is open. */
  async start(file: string): Promise<void> {
    const classpath = [this.alloyJar, this.serverJar].join(path.delimiter);
    const port = await new Promise<number>((resolve, reject) => {
      this.proc = spawn(this.java, ['-cp', classpath, 'org.alloytools.cnd.CnDServer', '0', file], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let resolved = false;
      this.proc.stdout?.on('data', (d) => {
        const text = d.toString();
        const m = /CND_PORT=(\d+)/.exec(text);
        if (m && !resolved) {
          resolved = true;
          resolve(parseInt(m[1], 10));
        }
      });
      this.proc.stderr?.on('data', (d) => this.log?.(`[cnd-server] ${d.toString()}`));
      this.proc.on('error', (e) => !resolved && reject(e));
      this.proc.on('exit', (code) => !resolved && reject(new Error(`CnDServer exited (${code ?? 'null'})`)));
      setTimeout(() => !resolved && reject(new Error('CnDServer did not report a port in time.')), 30000);
    });

    await new Promise<void>((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        this.sock = sock;
        resolve();
      });
      sock.on('error', reject);
      sock.on('data', (d) => this.onData(d.toString()));
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      const resolve = this.inflight;
      this.inflight = undefined;
      if (resolve) {
        try { resolve(JSON.parse(line)); } catch { resolve({ ok: false, error: 'bad server response' }); }
      }
      this.pump();
    }
  }

  private rpc(req: unknown): Promise<any> {
    return new Promise((resolve) => {
      this.queue.push({ req, resolve });
      this.pump();
    });
  }

  private pump(): void {
    if (this.inflight || !this.sock) return;
    const next = this.queue.shift();
    if (!next) return;
    this.inflight = next.resolve;
    this.sock.write(JSON.stringify(next.req) + '\n');
  }

  list(): Promise<string[]> {
    return this.rpc({ op: 'list' }).then((r) => (r.ok ? r.commands : []));
  }

  private toInstance(r: any): Instance {
    if (!r.ok) throw new Error(r.error);
    return { command: r.command, xml: r.xml, temporal: r.temporal };
  }

  run(index: number): Promise<Instance> {
    return this.rpc({ op: 'run', index }).then((r) => this.toInstance(r));
  }

  /**
   * Enumerate via Alloy's `A4Solution.fork(state)`, the primitive behind the Analyzer's trace
   * buttons: -3 = next/"New Trace", -1 = "New Config", 0 = "New Init", n>=0 = "New Fork" at state n.
   */
  fork(state: number): Promise<Instance> {
    return this.rpc({ op: 'fork', state }).then((r) => this.toInstance(r));
  }

  evaluate(expr: string): Promise<string> {
    return this.rpc({ op: 'eval', expr }).then((r) => {
      if (!r.ok) throw new Error(r.error);
      return r.result;
    });
  }

  dispose(): void {
    try { this.sock?.end(); } catch { /* ignore */ }
    try { this.proc?.kill(); } catch { /* ignore */ }
    this.sock = undefined;
    this.proc = undefined;
  }
}
