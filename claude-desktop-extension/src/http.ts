// Copyright (c) Fan Pier Labs. Use of this software is governed by the LICENSE file in the project root.

/**
 * Streamable HTTP entry for one Docker container behind a Cloudflare MCP portal.
 *
 * Stateful on purpose. Pending 2FA, parked tool calls, and the live MyChart
 * session all sit in this process. `sessionIdGenerator` is what keeps the SDK
 * from treating the transport as stateless — a stateless server would answer
 * each POST with a fresh transport and drop that state. One container: a
 * second replica would split the same memory.
 *
 * The portal authenticates users with Cloudflare Access and sends this
 * process a static bearer token. A 401 here must not carry a
 * WWW-Authenticate challenge. That header is how the portal detects an
 * OAuth server, and this process is not one.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { withLostResponse, withResponseDelivery } from './pending-call';

/** `--http` always binds this. The image and compose file publish it. */
export const HTTP_PORT = 8787;

const MCP_PATH = '/mcp';
/** A client that exits without DELETE must not keep a transport for the life of the container. */
const SESSION_IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 8;

export interface HttpServer {
  port: number;
  close(): Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  lastUsed: number;
  /** A request currently inside handleRequest. Idle expiry skips these so a reconnect can still use the session. */
  inflight: number;
}

/**
 * SHA-256 both sides so a different length still compares in constant time.
 * `timingSafeEqual` throws when the buffers differ in length.
 */
function bearerMatches(authorization: string | string[] | undefined, token: string): boolean {
  const header = typeof authorization === 'string' ? authorization : '';
  const presented = /^Bearer (.*)$/i.exec(header)?.[1] ?? '';
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

function endEmpty(req: IncomingMessage, res: ServerResponse, status: number): void {
  req.resume();
  res.writeHead(status);
  res.end();
}

/**
 * A proxy drops the socket without `notifications/cancelled`, which is the
 * only abort the SDK raises on its own. `end()` sets `writableEnded` before the
 * buffered bytes are written, and `writableFinished` can already be true then
 * too, so neither flag means the client can have the body. The `finish` event
 * does: it is withheld when the socket write never completes.
 */
function handleOnTransport(transport: StreamableHTTPServerTransport, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const lost = new AbortController();
  const waiters: Array<(wrote: boolean) => void> = [];
  let outcome: boolean | undefined;
  const complete = (wrote: boolean): void => {
    if (outcome !== undefined) return;
    outcome = wrote;
    res.off('finish', onFinish);
    res.off('close', onClose);
    if (!wrote) lost.abort();
    for (const waiter of waiters.splice(0)) waiter(wrote);
  };
  const onFinish = (): void => complete(true);
  const onClose = (): void => complete(false);
  res.on('finish', onFinish);
  res.on('close', onClose);
  const notify = (cb: (wrote: boolean) => void): void => {
    if (outcome !== undefined) cb(outcome);
    else waiters.push(cb);
  };
  return withResponseDelivery(notify, () => withLostResponse(lost.signal, () => transport.handleRequest(req, res)));
}

function jsonError(req: IncomingMessage, res: ServerResponse, status: number, message: string): void {
  req.resume();
  const body = JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

export function startHttpServer(options: {
  token: string;
  port: number;
  createServer: () => McpServer;
  /** Test seams. Production leaves both unset. */
  idleMs?: number;
  maxSessions?: number;
}): Promise<HttpServer> {
  const { token, port, createServer: newMcpServer } = options;
  const idleMs = options.idleMs ?? SESSION_IDLE_MS;
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  if (token.length === 0) {
    return Promise.reject(new Error('OPENRECORD_MCP_TOKEN is required for --http'));
  }

  const sessions = new Map<string, Session>();
  // An initialize is not in `sessions` until its body has been read. Count it
  // now so concurrent handshakes cannot all pass the cap.
  let pendingInits = 0;
  let closed = false;

  function drop(session: Session): void {
    const id = session.transport.sessionId;
    if (id) sessions.delete(id);
    void session.transport.close();
  }

  function expireIdle(now = Date.now()): void {
    for (const session of [...sessions.values()]) {
      if (session.inflight === 0 && now - session.lastUsed >= idleMs) drop(session);
    }
  }

  /** Close the oldest idle session until a new one fits. False when every slot is mid-request or still starting. */
  function makeRoom(): boolean {
    expireIdle();
    while (sessions.size + pendingInits >= maxSessions) {
      const idle = [...sessions.values()].filter((session) => session.inflight === 0).sort((a, b) => a.lastUsed - b.lastUsed);
      const victim = idle[0];
      if (!victim) return false;
      drop(victim);
    }
    return true;
  }

  async function openSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!makeRoom()) {
      jsonError(req, res, 503, 'Too many MCP sessions');
      return;
    }
    // Take the slot before the first await. The body is read inside handleRequest,
    // and that is where the session actually joins the map.
    pendingInits += 1;
    let held = true;
    const releaseReservation = (): void => {
      if (!held) return;
      held = false;
      pendingInits -= 1;
    };
    let transport: StreamableHTTPServerTransport | undefined;
    try {
      const mcp = newMcpServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          if (!transport) return;
          sessions.set(sessionId, { transport, lastUsed: Date.now(), inflight: 1 });
          releaseReservation();
        },
      });
      // Set before connect(): the protocol wraps whatever onclose is already there.
      transport.onclose = () => {
        const id = transport?.sessionId;
        if (id) sessions.delete(id);
      };
      // The class types onclose as `(() => void) | undefined`. With
      // exactOptionalPropertyTypes that is not a Transport, whose callback is
      // optional but never explicitly undefined.
      await mcp.connect(transport as Transport);
      await handleOnTransport(transport, req, res);
    } finally {
      releaseReservation();
      const id = transport?.sessionId;
      const session = id ? sessions.get(id) : undefined;
      if (!session) {
        // A POST that was not initialize never joins the map.
        if (transport) await transport.close();
      } else {
        session.inflight -= 1;
        session.lastUsed = Date.now();
      }
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== MCP_PATH) {
      endEmpty(req, res, 404);
      return;
    }
    if (!bearerMatches(req.headers.authorization, token)) {
      endEmpty(req, res, 401);
      return;
    }

    const method = req.method ?? 'GET';
    if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
      jsonError(req, res, 405, 'Method not allowed');
      return;
    }

    expireIdle();
    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined;
    if (method === 'POST' && !sessionId) {
      await openSession(req, res);
      return;
    }

    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (!existing) {
      jsonError(req, res, sessionId ? 404 : 400, sessionId ? 'Session not found' : 'Mcp-Session-Id header is required');
      return;
    }
    existing.inflight += 1;
    existing.lastUsed = Date.now();
    try {
      await handleOnTransport(existing.transport, req, res);
    } finally {
      existing.inflight -= 1;
      existing.lastUsed = Date.now();
    }
  }

  const httpServer = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      process.stderr.write(`[openrecord] ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) endEmpty(req, res, 500);
    });
  });
  const idleTimer = setInterval(() => expireIdle(), Math.min(idleMs, 60_000));
  idleTimer.unref?.();

  return new Promise((resolve, reject) => {
    const onListenError = (err: Error): void => {
      clearInterval(idleTimer);
      reject(err);
    };
    httpServer.once('error', onListenError);
    httpServer.listen(port, '0.0.0.0', () => {
      httpServer.off('error', onListenError);
      const address = httpServer.address();
      const bound = typeof address === 'object' && address ? address.port : port;
      process.stderr.write(`[openrecord] listening on http://0.0.0.0:${bound}/mcp\n`);
      resolve({
        port: bound,
        async close() {
          if (closed) return;
          closed = true;
          clearInterval(idleTimer);
          const open = [...sessions.values()];
          sessions.clear();
          await Promise.all(open.map((session) => session.transport.close()));
          await new Promise<void>((done, fail) => {
            httpServer.close((err) => (err ? fail(err) : done()));
          });
        },
      });
    });
  });
}
