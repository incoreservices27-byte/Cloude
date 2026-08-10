/**
 * Assembles the MCP server from configuration. Both transports (stdio and
 * streamable HTTP) build their server through here so the tool surface stays
 * identical however the connector is mounted.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig, type Config } from './config.js';
import { TokenManager } from './zoho/auth.js';
import { ZohoMailClient } from './zoho/client.js';
import { ZohoMailApi } from './zoho/mail.js';
import { registerTools } from './tools.js';

export const SERVER_NAME = 'zoho-mail';
export const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = `Access to a Zoho Mail mailbox.

Typical flow: list_folders or list_emails to see what is there, get_email to read
one in full, then act. Message IDs come from list_emails / search_emails — they
cannot be guessed, and they are only valid within the folder they were listed from.

Before sending anything (send_email, reply_to_email), show the user the recipients,
subject, and body and get their agreement. Mail cannot be recalled once sent.
Moving messages to Trash is likewise not something to do on your own initiative.`;

export function createServer(config: Config = loadConfig()): McpServer {
  const tokenManager = new TokenManager({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    refreshToken: config.refreshToken,
    dataCenter: config.dataCenter,
    timeoutMs: config.timeoutMs,
  });

  const client = new ZohoMailClient({
    tokenManager,
    dataCenter: config.dataCenter,
    timeoutMs: config.timeoutMs,
  });

  const api = new ZohoMailApi(client, { accountId: config.accountId });

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: INSTRUCTIONS,
      capabilities: { tools: {} },
    },
  );

  registerTools(server, { api, readOnly: config.readOnly });
  return server;
}
