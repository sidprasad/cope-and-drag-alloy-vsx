import { WebSocketServer, WebSocket } from 'ws';

/**
 * A Sterling "provider" — the websocket server side of the Sterling protocol that Cope and Drag
 * (built with provider=forge / WS=query) connects to. We bridge it to the Alloy language server:
 * instances come from the LS's solver runs, and `eval` / `next` are forwarded to the LS's
 * EvaluateAlloyExpression / NextInstance requests.
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
  /** True for temporal (var) instances — they additionally get a "Fork" button. */
  temporal?: boolean;
}

export interface SterlingHandlers {
  /** Runnable command/generator names, shown as "Run" buttons in CnD's explorer. */
  getGenerators(): Promise<string[]>;
  /** Run a command (by name, or the default) and return its instance. */
  run(generatorName: string | undefined): Promise<SterlingInstance | null>;
  /** Enumerate the next instance of the current command. */
  next(): Promise<SterlingInstance | null>;
  /** Fork the current temporal trace (alternative continuation). */
  fork(): Promise<SterlingInstance | null>;
  /** Evaluate an expression against the current instance; return the result string. */
  evaluate(expression: string): Promise<string>;
}

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
        const inst = await this.safe(() => this.handlers.next());
        if (inst) {
          this.current = inst;
          this.sendJson(ws, this.dataMessage(inst));
        }
        break;
      }

      case 'click': {
        // Datum buttons ("Next" -> enumerate, "Fork" -> fork the trace) and the explorer's
        // "Run <generator>" button (onClick 'run' / context.generatorName -> run).
        const onClick = msg.payload?.onClick;
        const inst =
          onClick === 'next'
            ? await this.safe(() => this.handlers.next())
            : onClick === 'fork'
              ? await this.safe(() => this.handlers.fork())
              : await this.safe(() => this.handlers.run(msg.payload?.context?.generatorName));
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
            // The graph header renders a button per entry; clicking sends a `click` with this
            // `onClick`, which we route. Without this there is no "Next"/"Fork" control. Fork only
            // applies to temporal traces, so it's offered only for temporal instances.
            buttons: instanceButtons(inst)
          }
        ],
        update: [],
        exit: []
      }
    };
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
}

/** Buttons for an instance: always "Next"; plus "Fork" when it's a temporal trace. */
function instanceButtons(inst: SterlingInstance): Array<{ text: string; onClick: string; mouseover: string }> {
  const buttons = [{ text: 'Next', onClick: 'next', mouseover: 'Show the next instance' }];
  if (inst.temporal) {
    buttons.push({ text: 'Fork', onClick: 'fork', mouseover: 'Fork the trace: an alternative continuation' });
  }
  return buttons;
}
