#!/usr/bin/env node
/**
 * Interactive one-time setup: walks the Zoho OAuth consent flow and writes the
 * resulting refresh token to `.env`.
 *
 * Zoho authorization codes are single-use and expire in about a minute, so the
 * exchange happens inside the callback handler rather than after any prompting.
 */

import http from 'node:http';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  DATA_CENTERS,
  OAUTH_SCOPES,
  READ_ONLY_SCOPES,
  loadDotEnv,
  resolveDataCenter,
  type DataCenter,
} from './config.js';
import { buildAuthorizeUrl, exchangeCodeForTokens } from './zoho/auth.js';

const DEFAULT_PORT = 53_682;
const CALLBACK_PATH = '/callback';

async function main(): Promise<void> {
  loadDotEnv();
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    console.log('\nZoho Mail connector — OAuth setup\n' + '='.repeat(34) + '\n');

    const dataCenter = await promptDataCenter(rl);
    const port = Number.parseInt(process.env.ZOHO_CALLBACK_PORT ?? String(DEFAULT_PORT), 10);
    const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;

    console.log(
      `\nRegister a "Server-based Application" at ${dataCenter.consoleUrl}\n` +
        `and set its Authorized Redirect URI to exactly:\n\n  ${redirectUri}\n`,
    );

    const clientId = await promptRequired(rl, 'Client ID', process.env.ZOHO_CLIENT_ID);
    const clientSecret = await promptRequired(rl, 'Client Secret', process.env.ZOHO_CLIENT_SECRET);

    const readOnlyAnswer = await rl.question(
      '\nGrant send/modify permissions too? [Y/n] (n = read-only) ',
    );
    const readOnly = readOnlyAnswer.trim().toLowerCase().startsWith('n');
    const scopes = readOnly ? READ_ONLY_SCOPES : OAUTH_SCOPES;

    const state = randomUUID();
    const authorizeUrl = buildAuthorizeUrl({
      dataCenter,
      clientId,
      redirectUri,
      scopes,
      state,
    });

    console.log(
      `\nScopes requested: ${scopes.join(', ')}\n\n` +
        'Open this URL in a browser signed in to the Zoho account you want to connect:\n\n' +
        `  ${authorizeUrl}\n\n` +
        `Waiting for the redirect on ${redirectUri} …`,
    );

    const result = await waitForCallback({
      port,
      state,
      exchange: (code) =>
        exchangeCodeForTokens({
          dataCenter,
          clientId,
          clientSecret,
          redirectUri,
          code,
        }),
    });

    if (result.reportedLocation && result.reportedLocation !== dataCenter.key) {
      console.warn(
        `\nNote: Zoho reported this account lives in the "${result.reportedLocation}" data ` +
          `center, but you chose "${dataCenter.key}". If API calls fail with 404s, re-run ` +
          `with the reported region.`,
      );
    }

    await writeEnvFile({
      clientId,
      clientSecret,
      refreshToken: result.refreshToken,
      dataCenter,
      readOnly,
    });

    console.log(
      '\nDone. Credentials written to .env (git-ignored).\n\n' +
        'Next: `npm run build`, then add the connector to Claude Code with\n\n' +
        `  claude mcp add zoho-mail --env-file .env -- node ${process.cwd()}/dist/stdio.js\n\n` +
        'See SETUP.md for Claude Desktop and remote/HTTP options.',
    );
  } finally {
    rl.close();
  }
}

async function promptDataCenter(rl: readline.Interface): Promise<DataCenter> {
  const keys = Object.values(DATA_CENTERS)
    .map((dc) => `  ${dc.key.padEnd(3)} ${dc.label}`)
    .join('\n');
  console.log(`Which Zoho data center hosts your account?\n${keys}\n`);
  console.log('(Check the domain you sign in on — mail.zoho.com is "us", mail.zoho.eu is "eu".)\n');

  for (;;) {
    const answer = await rl.question(`Data center [${process.env.ZOHO_DC ?? 'us'}]: `);
    try {
      return resolveDataCenter(answer.trim() || process.env.ZOHO_DC || 'us');
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
}

async function promptRequired(
  rl: readline.Interface,
  label: string,
  existing: string | undefined,
): Promise<string> {
  const suffix = existing ? ' [press enter to keep the value from .env]' : '';
  for (;;) {
    const answer = (await rl.question(`${label}${suffix}: `)).trim();
    if (answer) return answer;
    if (existing) return existing;
    console.error(`${label} is required.`);
  }
}

interface CallbackResult {
  refreshToken: string;
  reportedLocation: string | undefined;
}

/**
 * Serves the redirect URI exactly once, exchanges the code, and resolves.
 * The browser gets a plain success or failure page either way.
 */
function waitForCallback(options: {
  port: number;
  state: string;
  exchange: (code: string) => Promise<{ refreshToken: string }>;
}): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${options.port}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end('Not found');
        return;
      }

      const finish = (statusCode: number, message: string) => {
        res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' }).end(message);
        server.close();
      };

      const error = url.searchParams.get('error');
      if (error) {
        finish(400, `Authorization failed: ${error}. You can close this tab.`);
        reject(new Error(`Zoho returned error="${error}" on the callback.`));
        return;
      }

      const returnedState = url.searchParams.get('state');
      if (returnedState !== options.state) {
        finish(400, 'State mismatch — this callback did not come from the request we started.');
        reject(new Error('OAuth state mismatch; aborting rather than trusting the callback.'));
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        finish(400, 'No authorization code in the callback.');
        reject(new Error('Callback carried no ?code= parameter.'));
        return;
      }

      const reportedLocation = url.searchParams.get('location') ?? undefined;

      options
        .exchange(code)
        .then(({ refreshToken }) => {
          finish(200, 'Zoho Mail connector authorized. You can close this tab.');
          resolve({ refreshToken, reportedLocation });
        })
        .catch((cause: unknown) => {
          finish(500, 'Token exchange failed. Check the terminal for details.');
          reject(cause);
        });
    });

    server.on('error', reject);
    server.listen(options.port, '127.0.0.1');

    // Codes expire quickly; don't leave the process hanging forever.
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('Timed out after 5 minutes waiting for the OAuth callback.'));
    }, 5 * 60_000);
    timeout.unref();
  });
}

async function writeEnvFile(values: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  dataCenter: DataCenter;
  readOnly: boolean;
}): Promise<void> {
  const managed: Record<string, string> = {
    ZOHO_CLIENT_ID: values.clientId,
    ZOHO_CLIENT_SECRET: values.clientSecret,
    ZOHO_REFRESH_TOKEN: values.refreshToken,
    ZOHO_DC: values.dataCenter.key,
    ZOHO_MAIL_READ_ONLY: String(values.readOnly),
  };

  // Preserve any unrelated keys the user added by hand.
  let existing = '';
  try {
    existing = await readFile('.env', 'utf8');
  } catch {
    // No existing file — start fresh.
  }

  const preserved = existing
    .split('\n')
    .filter((line) => {
      const key = line.split('=')[0]?.trim();
      return line.trim() !== '' && !line.trim().startsWith('#') && key && !(key in managed);
    })
    .join('\n');

  const body =
    '# Written by `npm run auth`. Contains credentials — never commit this file.\n' +
    Object.entries(managed)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') +
    (preserved ? `\n${preserved}` : '') +
    '\n';

  await writeFile('.env', body, { mode: 0o600 });
}

main().catch((error: unknown) => {
  console.error(`\nSetup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
