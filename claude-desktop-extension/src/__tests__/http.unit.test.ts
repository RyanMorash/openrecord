// Copyright (c) Fan Pier Labs. Use of this software is governed by the LICENSE file in the project root.

/**
 * Streamable HTTP auth and session handshake. No MyChart calls — the server
 * under test registers nothing, so a successful initialize only proves the
 * listener, the bearer check, and the session map.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startHttpServer, type HttpServer } from '../http';

const TOKEN = 'test-token';

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
});
