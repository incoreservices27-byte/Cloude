#!/usr/bin/env node
/**
 * stdio entry point — the transport Claude Code and Claude Desktop use.
 *
 * Nothing may be written to stdout except protocol frames, so all diagnostics
 * go to stderr.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, loadDotEnv } from './config.js';
import { createServer, SERVER_VERSION } from './server.js';

async function main(): Promise<void> {
  loadDotEnv();

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`[zoho-mail] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    `[zoho-mail] v${SERVER_VERSION} ready on stdio ` +
      `(dc=${config.dataCenter.key}, mode=${config.readOnly ? 'read-only' : 'read-write'})`,
  );

  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(`[zoho-mail] fatal: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
