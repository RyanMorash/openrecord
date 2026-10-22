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

/** `--http` always binds this. The image and compose file publish it. */
export const HTTP_PORT = 8787;

const MCP_PATH = '/mcp';

export interface HttpServer {
  port: number;
  close(): Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
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
}): Promise<HttpServer> {
  const { token, port, createServer: newMcpServer } = options;
  if (token.length === 0) {
    return Promise.reject(new Error('OPENRECORD_MCP_TOKEN is required for --http'));
  }

  const sessions = new Map<string, Session>();
  let closed = false;

  async function openSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const mcp = newMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport });
      },
    });
    // Set before connect(): the protocol wraps whatever onclose is already there.
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
    };
    try {
      // The class types onclose as `(() => void) | undefined`. With
      // exactOptionalPropertyTypes that is not a Transport, whose callback is
      // optional but never explicitly undefined.
      await mcp.connect(transport as Transport);
      await transport.handleRequest(req, res);
    } finally {
      // A POST that was not initialize never joins the map. Drop it.
      if (!transport.sessionId) await transport.close();
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
    await existing.transport.handleRequest(req, res);
  }

  const httpServer = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      process.stderr.write(`[openrecord] ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) endEmpty(req, res, 500);
    });
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '0.0.0.0', () => {
      httpServer.off('error', reject);
      const address = httpServer.address();
      const bound = typeof address === 'object' && address ? address.port : port;
      process.stderr.write(`[openrecord] listening on http://0.0.0.0:${bound}/mcp\n`);
      resolve({
        port: bound,
        async close() {
          if (closed) return;
          closed = true;
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
