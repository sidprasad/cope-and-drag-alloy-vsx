import { WebSocketServer, WebSocket } from 'ws';

/**
 * A Sterling "provider" — the websocket server side of the Sterling protocol that Cope and Drag
 * (the Alloy build) connects to. We bridge it to the CnD Java backend (CnDServer): instances,
 * enumeration, and evaluation are forwarded to that bridge over its JSON socket as
 * `{op:'run'|'fork'|'eval'}` (see SterlingHandlers, wired in extension.ts -> CnDServerClient).
 *
 * Wire protocol (see copeanddrag/packages/sterling-connection):
 *   client -> server : raw "ping"; or JSON {type:'meta'|'data'|'click'|'eval', version, payload?}
 *   server -> client : raw "pong"; or JSON {type:'meta'|'data'|'eval', version:1, payload}
 *   data payload     : {enter:[{id, generatorName?, format:'alloy', data:<xml>, evaluator:true}], update:[], exit:[]}
 *   eval request     : {id, datumId, expression}   eval response: {id, result}
 */

const VERSION = 1;

export interface SterlingInstance {
  id: string;
  xml: string;
  generatorName?: string;
  /** True for temporal (trace) instances — shows the trace-only nav buttons (config/init/fork). */
  temporal?: boolean;
}

export interface SterlingHandlers {
  /** Runnable command/generator names, shown as "Run" buttons in CnD's explorer. */
  getGenerators(): Promise<string[]>;
  /** Run a command (by name, or the default) and return its instance. */
  run(generatorName: string | undefined): Promise<SterlingInstance | null>;
  /**
   * Enumerate the next instance via Alloy's `fork(state)`, the primitive behind the Analyzer's
   * trace buttons: -3 = next/"New Trace", -1 = "New Config", 0 = "New Init".
   */
  fork(state: number): Promise<SterlingInstance | null>;
  /** Evaluate an expression against the current instance; return the result string. */
  evaluate(expression: string): Promise<string>;
  /**
   * Surface a user-facing message when a click-driven action (enumeration or run) fails — e.g. the
   * solver reports "no more satisfying instances". Optional; if absent, failures are dropped. The
   * connect-time `data` fetch stays silent regardless, since a failure there is expected.
   */
  notify?(message: string): void;
}

// The Analyzer's trace-navigation buttons each map to one `A4Solution.fork(state)` arg. We expose
// the three that need no extra state: New Trace (also the plain "Next"), New Config, and New Init.
// ("New Fork" forks at the *displayed* trace state, which the click protocol doesn't carry, so it's
// intentionally omitted.)
/** Alloy's fork() arg for the plain "next instance" / "New Trace" enumeration. */
const FORK_NEXT = -3;
/** fork() args for the temporal-only nav buttons. */
const FORK_CONFIG = -1;
const FORK_INIT = 0;

export class SterlingProvider {
  private wss: WebSocketServer | undefined;
  private readonly sockets = new Set<WebSocket>();
  private current: SterlingInstance | undefined;
  // On (re)connect, Cope and Drag fires one `data` request to fetch the initial instance. If we
  // already have a `current` (e.g. the iframe was reloaded to apply an edited layout), that request
  // must replay `current` rather than enumerate the *next* instance — otherwise reloading the
  // layout would silently advance the model. This one-shot flag arms that replay per connect.
  private replayPending = false;

  constructor(private readonly handlers: SterlingHandlers) {}

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      wss.on('connection', (ws) => this.onConnection(ws));
      wss.on('error', reject);
      wss.on('listening', () => {
        const addr = wss.address();
        if (addr && typeof addr === 'object') {
          this.wss = wss;
          resolve(addr.port);
        } else {
          reject(new Error('Could not start the Sterling provider server.'));
        }
      });
    });
  }

  /** Broadcast a freshly-produced instance to all connected clients (e.g. after a VS Code "Run"). */
  pushInstance(instance: SterlingInstance): void {
    this.current = instance;
    this.broadcast(this.dataMessage(instance));
  }

  /**
   * Replace the current instance without broadcasting. Used before reloading the webview to apply an
   * edited layout: the fresh iframe reconnects and is replayed `current` (with the new spec).
   */
  setCurrent(instance: SterlingInstance): void {
    this.current = instance;
  }

  dispose(): void {
    for (const ws of this.sockets) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this.sockets.clear();
    this.wss?.close();
    this.wss = undefined;
    this.current = undefined;
  }

  private onConnection(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
    ws.on('message', (raw) => void this.onMessage(ws, raw.toString()));
    // Announce metadata; replay the current instance if a run already happened. Arm the one-shot so
    // CnD's connect-time `data` request replays this instance instead of advancing past it.
    void this.sendMeta(ws);
    if (this.current) {
      this.replayPending = true;
      this.sendJson(ws, this.dataMessage(this.current));
    }
  }

  private async onMessage(ws: WebSocket, text: string): Promise<void> {
    if (text === 'ping') {
      ws.send('pong');
      return;
    }
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }

    switch (msg?.type) {
      case 'meta':
        await this.sendMeta(ws);
        break;

      case 'data': {
        // CnD's "next instance" request. The first one after a (re)connect with an existing
        // instance is the connect-time fetch — replay `current` instead of enumerating.
        if (this.replayPending) {
          this.replayPending = false;
          if (this.current) this.sendJson(ws, this.dataMessage(this.current));
          break;
        }
        const inst = await this.safe(() => this.handlers.fork(FORK_NEXT));
        if (inst) {
          this.current = inst;
          this.sendJson(ws, this.dataMessage(inst));
        }
        break;
      }

      case 'click': {
        // A datum's trace-nav button -> enumerate via fork(state); or the explorer's
        // "Run <generator>" button (context.generatorName) -> run.
        //   next -> fork(-3) "New Trace"   config -> fork(-1) "New Config"   init -> fork(0) "New Init"
        const onClick = msg.payload?.onClick;
        const forkState =
          onClick === 'next'   ? FORK_NEXT   :
          onClick === 'config' ? FORK_CONFIG :
          onClick === 'init'   ? FORK_INIT   :
          undefined;
        const inst =
          forkState !== undefined
            ? await this.enumerate(() => this.handlers.fork(forkState))
            : await this.enumerate(() => this.handlers.run(msg.payload?.context?.generatorName));
        if (inst) {
          this.current = inst;
          this.broadcast(this.dataMessage(inst));
        }
        break;
      }

      case 'eval': {
        const id = msg.payload?.id;
        const expression = msg.payload?.expression ?? '';
        let result: string;
        try {
          result = await this.handlers.evaluate(expression);
        } catch (e) {
          result = 'Error: ' + (e instanceof Error ? e.message : String(e));
        }
        this.sendJson(ws, { type: 'eval', version: VERSION, payload: { id, result } });
        break;
      }
    }
  }

  private async sendMeta(ws: WebSocket): Promise<void> {
    const generators = (await this.safe(() => this.handlers.getGenerators())) ?? [];
    this.sendJson(ws, {
      type: 'meta',
      version: VERSION,
      payload: {
        name: 'Alloy',
        evaluator: 'alloy',
        views: ['graph', 'table', 'script', 'edit'],
        generators
      }
    });
  }

  private dataMessage(inst: SterlingInstance) {
    return {
      type: 'data',
      version: VERSION,
      payload: {
        enter: [
          {
            id: inst.id,
            generatorName: inst.generatorName,
            format: 'alloy',
            data: inst.xml,
            evaluator: true,
            // The graph header renders a button per entry; clicking sends a `click` with the
            // button's `onClick`, which we route to fork-based enumeration (see onMessage 'click').
            // Without these there is no enumeration control. Stepping *within* a trace is handled by
            // Cope and Drag itself (it has the full trace); these buttons ask the solver for a new one.
            buttons: this.navButtons(inst)
          }
        ],
        update: [],
        exit: []
      }
    };
  }

  /**
   * The enumeration buttons shown in the graph header. Non-temporal models get a single "Next"
   * (fork -3). Temporal models get the Analyzer's trace-navigation buttons that need no extra
   * state — New Config (fork -1), New Trace (fork -3), and New Init (fork 0) — since those only
   * make sense once there's a trace to vary. `onClick` strings are routed in onMessage.
   */
  private navButtons(inst: SterlingInstance) {
    const next = { text: 'New Trace', onClick: 'next', mouseover: 'Solve for a different trace' };
    if (!inst.temporal) return [{ ...next, text: 'Next', mouseover: 'Show the next instance' }];
    return [
      { text: 'New Config', onClick: 'config', mouseover: 'Solve for a different configuration' },
      next,
      { text: 'New Init', onClick: 'init', mouseover: 'Keep the configuration; solve for a different initial state' }
    ];
  }

  private broadcast(obj: unknown): void {
    for (const ws of this.sockets) this.sendJson(ws, obj);
  }

  private sendJson(ws: WebSocket, obj: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  private async safe<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch {
      return null;
    }
  }

  /**
   * Like `safe`, but for explicit user button clicks: a failure (e.g. the solver has no further
   * instance) is surfaced via `handlers.notify` rather than dropped, since a silent no-op on a
   * deliberate click reads as "broken". The connect-time `data` fetch deliberately keeps using
   * `safe` so its expected "run a command first" error doesn't toast.
   */
  private async enumerate(fn: () => Promise<SterlingInstance | null>): Promise<SterlingInstance | null> {
    try {
      return await fn();
    } catch (e) {
      this.handlers.notify?.(e instanceof Error ? e.message : String(e));
      return null;
    }
  }
}
