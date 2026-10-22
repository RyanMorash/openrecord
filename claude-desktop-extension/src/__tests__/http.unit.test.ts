// Copyright (c) Fan Pier Labs. Use of this software is governed by the LICENSE file in the project root.

/**
 * Streamable HTTP auth and session handshake. No MyChart calls — the server
 * under test registers nothing, so a successful initialize only proves the
 * listener, the bearer check, and the session map.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { request as httpRequest } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { startHttpServer, type HttpServer } from '../http';
import { checkPendingCall, collectionWaitsInFlight, runGuarded } from '../pending-call';

const TOKEN = 'test-token';
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const mcpHeaders = {
  authorization: `Bearer ${TOKEN}`,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'http-unit', version: '0.0.0' },
  },
});

/** Headers only. The body stays unsent so the server is inside initialize before the session exists. */
function holdInitialize(port: number): {
  finish: (body: string) => void;
  result: Promise<{ status: number; sessionId: string | undefined }>;
} {
  let finishBody: ((body: string) => void) | undefined;
  const result = new Promise<{ status: number; sessionId: string | undefined }>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: { ...mcpHeaders, 'content-length': Buffer.byteLength(INITIALIZE_BODY) },
      },
      (res) => {
        const raw = res.headers['mcp-session-id'];
        const sessionId = typeof raw === 'string' ? raw : undefined;
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, sessionId }));
      },
    );
    req.on('error', reject);
    finishBody = (body: string) => req.end(body);
    req.flushHeaders();
  });
  return { finish: (body: string) => finishBody?.(body), result };
}

async function initialize(url: string): Promise<string> {
  const init = await fetch(url, {
    method: 'POST',
    headers: mcpHeaders,
    body: INITIALIZE_BODY,
  });
  expect(init.status).toBe(200);
  const sessionId = init.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();
  await init.text();
  return sessionId!;
}

function bareServer(): McpServer {
  return new McpServer({ name: 'openrecord-test', version: '0.0.0' });
}

async function readRpc(res: Response): Promise<unknown> {
  const text = await res.text();
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice('data: '.length) : text) as unknown;
}

describe('startHttpServer', () => {
  let listening: HttpServer | undefined;

  afterEach(async () => {
    await listening?.close();
    listening = undefined;
  });

  it('refuses to listen without a token', async () => {
    await expect(startHttpServer({ token: '', port: 0, createServer: bareServer })).rejects.toThrow(
      'OPENRECORD_MCP_TOKEN',
    );
  });

  it('answers 401 with an empty body and no OAuth challenge', async () => {
    listening = await startHttpServer({ token: TOKEN, port: 0, createServer: bareServer });
    const url = `http://127.0.0.1:${listening.port}/mcp`;
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{}',
    };

    const missing = await fetch(url, init);
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBeNull();
    expect(await missing.text()).toBe('');

    const wrong = await fetch(url, { ...init, headers: { ...init.headers, authorization: 'Bearer no' } });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('www-authenticate')).toBeNull();
    expect(await wrong.text()).toBe('');
  });

  it('returns a session from initialize and keeps it for the next call', async () => {
    listening = await startHttpServer({ token: TOKEN, port: 0, createServer: bareServer });
    const url = `http://127.0.0.1:${listening.port}/mcp`;
    const headers = {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };

    const init = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'http-unit', version: '0.0.0' },
        },
      }),
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    const body = (await readRpc(init)) as { result?: { protocolVersion?: string } };
    expect(body.result?.protocolVersion).toBe('2025-06-18');

    const noted = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': sessionId!, 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(noted.status).toBe(202);

    const tools = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': sessionId!, 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(tools.status).toBe(200);
    await tools.text();

    const unknown = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': 'not-a-session', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
    });
    expect(unknown.status).toBe(404);

    const removed = await fetch(url, {
      method: 'DELETE',
      headers: { ...headers, 'mcp-session-id': sessionId!, 'mcp-protocol-version': '2025-06-18' },
    });
    expect(removed.status).toBe(200);

    const gone = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': sessionId!, 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }),
    });
    expect(gone.status).toBe(404);
  });

  it('404s other paths, 405s other methods, and 500s when a session cannot be built', async () => {
    listening = await startHttpServer({
      token: TOKEN,
      port: 0,
      createServer: () => {
        throw new Error('no server');
      },
    });
    const base = `http://127.0.0.1:${listening.port}`;
    const headers = {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };

    const other = await fetch(`${base}/`);
    expect(other.status).toBe(404);

    const method = await fetch(`${base}/mcp`, { method: 'PUT', headers });
    expect(method.status).toBe(405);

    const get = await fetch(`${base}/mcp`, { headers });
    expect(get.status).toBe(400);

    const failed = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(failed.status).toBe(500);
  });

  it('drops an idle session and keeps one that has a request in flight', async () => {
    listening = await startHttpServer({ token: TOKEN, port: 0, createServer: bareServer, idleMs: 80, maxSessions: 2 });
    const url = `http://127.0.0.1:${listening.port}/mcp`;
    const sessionId = await initialize(url);
    const headers = { ...mcpHeaders, 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' };

    const stream = await fetch(url, { method: 'GET', headers: { ...headers, accept: 'text/event-stream' } });
    expect(stream.status).toBe(200);
    await sleep(120);
    const during = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    });
    expect(during.status).toBe(200);
    await during.text();
    await stream.body?.cancel();

    await sleep(120);
    const after = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
    });
    expect(after.status).toBe(404);
  });

  it('refuses a new session while every existing one is mid-request, then accepts one once a slot is idle', async () => {
    listening = await startHttpServer({ token: TOKEN, port: 0, createServer: bareServer, idleMs: 60_000, maxSessions: 1 });
    const url = `http://127.0.0.1:${listening.port}/mcp`;
    const sessionId = await initialize(url);
    const headers = { ...mcpHeaders, 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' };
    const stream = await fetch(url, { method: 'GET', headers: { ...headers, accept: 'text/event-stream' } });
    expect(stream.status).toBe(200);

    const refused = await fetch(url, {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'http-unit', version: '0.0.0' } },
      }),
    });
    expect(refused.status).toBe(503);
    await stream.body?.cancel();
    await sleep(30);

    const next = await initialize(url);
    const ping = await fetch(url, {
      method: 'POST',
      headers: { ...mcpHeaders, 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }),
    });
    expect(ping.status).toBe(404);
    expect(next).not.toBe(sessionId);
  });

  it('counts an initialize against the cap before the session is registered', async () => {
    listening = await startHttpServer({ token: TOKEN, port: 0, createServer: bareServer, idleMs: 60_000, maxSessions: 1 });
    const url = `http://127.0.0.1:${listening.port}/mcp`;
    const held = holdInitialize(listening.port);
    await sleep(50);

    const refused = await fetch(url, { method: 'POST', headers: mcpHeaders, body: INITIALIZE_BODY });
    expect(refused.status).toBe(503);
    await refused.text();

    held.finish('x'.repeat(Buffer.byteLength(INITIALIZE_BODY)));
    const failed = await held.result;
    expect(failed.status).not.toBe(200);
    expect(failed.sessionId).toBeUndefined();

    const next = await initialize(url);
    expect(next).toBeTruthy();
  });

  it('keeps a parked result when the waiting collection is disconnected', async () => {
    let release: (result: CallToolResult) => void = () => {};
    const work = new Promise<CallToolResult>((resolve) => {
      release = resolve;
    });
    listening = await startHttpServer({
      token: TOKEN,
      port: 0,
      idleMs: 60_000,
      maxSessions: 2,
      createServer: () => {
        const mcp = new McpServer({ name: 'openrecord-test', version: '0.0.0' });
        mcp.registerTool('slow_read', { description: 'test', inputSchema: {} }, () => runGuarded('slow_read', {}, () => work, 15));
        mcp.registerTool(
          'check_pending_call',
          { description: 'test', inputSchema: { id: z.string().optional(), wait: z.boolean().optional() } },
          (args) =>
            checkPendingCall({
              ...(args.id !== undefined ? { id: args.id } : {}),
              ...(args.wait !== undefined ? { wait: args.wait } : {}),
            }),
        );
        return mcp;
      },
    });
    const port = listening.port;
    const url = `http://127.0.0.1:${port}/mcp`;
    const sessionId = await initialize(url);
    const headers = { ...mcpHeaders, 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' };
    const call = (id: number, name: string, args: Record<string, unknown>) =>
      fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
      });

    const parked = await call(2, 'slow_read', {});
    expect(parked.status).toBe(200);
    const parkedText = toolText(await readRpc(parked));
    const parkedId = /id "([^"]+)"/.exec(parkedText)?.[1];
    expect(parkedId).toBeTruthy();

    const collectBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'check_pending_call', arguments: { id: parkedId } },
    });
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: { ...headers, 'content-length': Buffer.byteLength(collectBody) },
        },
        (res) => {
          res.resume();
        },
      );
      req.on('error', () => {});
      req.end(collectBody);
      void (async () => {
        const started = Date.now();
        while (collectionWaitsInFlight() === 0) {
          if (Date.now() - started > 1000) {
            req.destroy();
            reject(new Error('collection never started waiting'));
            return;
          }
          await sleep(5);
        }
        req.destroy();
        resolve();
      })();
    });

    await sleep(30);
    release({ content: [{ type: 'text', text: 'labs' }] });
    await sleep(20);
    const again = await call(4, 'check_pending_call', { id: parkedId, wait: false });
    expect(again.status).toBe(200);
    expect(toolText(await readRpc(again))).toBe('labs');
  });
});

function toolText(body: unknown): string {
  const message = body as { result?: { content?: { text?: string }[] } };
  return message.result?.content?.[0]?.text ?? '';
}
