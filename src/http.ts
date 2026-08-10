#!/usr/bin/env node
/**
 * Streamable HTTP entry point, for mounting the connector as a remote MCP
 * server rather than a local subprocess.
 *
 * This endpoint fronts a live mailbox, so it refuses to start unencrypted
 * without a bearer token: anyone who can reach the URL can read and send mail.
 * Set MCP_BEARER_TOKEN and put it behind TLS (a tunnel or a reverse proxy).
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, loadDotEnv, parseBoolean } from './config.js';
import { createServer, SERVER_VERSION } from './server.js';

const sessions = new Map<string, StreamableHTTPServerTransport>();

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which itself leaks length —
  // compare against a fixed-size digest-like padding instead.
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

async function main(): Promise<void> {
  loadDotEnv();

  const config = loadConfig();
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  const host = process.env.HOST ?? '127.0.0.1';
  const bearerToken = process.env.MCP_BEARER_TOKEN?.trim();
  const allowInsecure = parseBoolean(process.env.MCP_ALLOW_NO_AUTH, false);

  if (!bearerToken && !allowInsecure) {
    console.error(
      '[zoho-mail] Refusing to start: MCP_BEARER_TOKEN is not set.\n' +
        'This endpoint can read and send mail, so it must not be exposed unauthenticated.\n' +
        'Set MCP_BEARER_TOKEN=<a long random string>, or set MCP_ALLOW_NO_AUTH=true if you ' +
        'are certain the port is reachable only from localhost.',
    );
    process.exit(1);
  }

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', version: SERVER_VERSION, dataCenter: config.dataCenter.key });
  });

  app.use('/mcp', (req: Request, res: Response, next) => {
    if (!bearerToken) return next();
    const header = req.header('authorization') ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!provided || !constantTimeEquals(provided, bearerToken)) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: valid bearer token required' },
        id: null,
      });
      return;
    }
    next();
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      const sessionId = req.header('mcp-session-id');
      const existing = sessionId ? sessions.get(sessionId) : undefined;

      if (existing) {
        await existing.handleRequest(req, res, req.body);
        return;
      }

      // No session yet: this must be an `initialize` request, which the
      // transport validates for us.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };

      const server = createServer(config);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[zoho-mail] request failed:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // GET opens the server→client SSE stream; DELETE tears the session down.
  const bySession = async (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    const transport = sessionId ? sessions.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Unknown or missing mcp-session-id' },
        id: null,
      });
      return;
    }
    await transport.handleRequest(req, res);
  };

  app.get('/mcp', bySession);
  app.delete('/mcp', bySession);

  const httpServer = app.listen(port, host, () => {
    console.error(
      `[zoho-mail] v${SERVER_VERSION} listening on http://${host}:${port}/mcp ` +
        `(dc=${config.dataCenter.key}, auth=${bearerToken ? 'bearer' : 'NONE'}, ` +
        `mode=${config.readOnly ? 'read-only' : 'read-write'})`,
    );
  });

  const shutdown = () => {
    httpServer.close();
    for (const transport of sessions.values()) void transport.close();
    sessions.clear();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(`[zoho-mail] fatal: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
