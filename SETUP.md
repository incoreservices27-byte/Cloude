# Connecting Zoho Mail

Roughly ten minutes, most of it in Zoho's developer console. You need the Zoho account
whose mail you want to reach — the one you sign in with at
<https://www.zoho.com/mail/login>.

---

## 1. Find your data centre

Zoho shards accounts by region, and nothing works across regions: an OAuth client
registered in the EU cannot authorize a US account, and IDs from one region 404 in
another. Check the domain your mailbox actually loads on after signing in.

| Sign-in domain | `ZOHO_DC` | API console |
| --- | --- | --- |
| mail.zoho.com | `us` | <https://api-console.zoho.com> |
| mail.zoho.eu | `eu` | <https://api-console.zoho.eu> |
| mail.zoho.in | `in` | <https://api-console.zoho.in> |
| mail.zoho.com.au | `au` | <https://api-console.zoho.com.au> |
| mail.zoho.jp | `jp` | <https://api-console.zoho.jp> |
| mail.zohocloud.ca | `ca` | <https://api-console.zohocloud.ca> |
| mail.zoho.sa | `sa` | <https://api-console.zoho.sa> |
| mail.zoho.uk | `uk` | <https://api-console.zoho.uk> |

If you pick wrong, the setup wizard notices — Zoho reports the account's real region on
the OAuth callback and the wizard warns when it disagrees with your choice.

---

## 2. Register an OAuth client

1. Open the API console for your region (table above) and sign in with the same Zoho
   account.
2. **Add Client** → choose **Server-based Applications**.
3. Fill in:
   - **Client Name** — anything, e.g. `Claude Zoho Mail connector`
   - **Homepage URL** — anything, e.g. `http://localhost`
   - **Authorized Redirect URIs** — exactly:

     ```
     http://localhost:53682/callback
     ```

     This must match character for character. A trailing slash breaks it.
4. **Create**, then copy the **Client ID** and **Client Secret**.

> Pick *Server-based Applications*, not *Self Client*. Self Client uses a different,
> manual code-generation flow that this wizard does not drive.

---

## 3. Run the setup wizard

```bash
npm install
npm run build
npm run auth
```

It asks for your data centre, client ID, and client secret, then whether to grant
send/modify permission or stay read-only. It prints a Zoho consent URL — open it in a
browser signed in to the right account, approve, and the wizard captures the callback,
exchanges the code, and writes `.env`.

Scopes requested:

| Mode | Scopes |
| --- | --- |
| Read-write | `ZohoMail.accounts.READ`, `ZohoMail.folders.READ`, `ZohoMail.messages.ALL`, `ZohoMail.attachments.READ` |
| Read-only | same, but `ZohoMail.messages.READ` instead of `.ALL` |

`.env` is git-ignored and written with `0600` permissions. The refresh token in it
grants ongoing access to your mailbox — treat it like a password.

**Authorization codes are single-use and expire in about a minute.** If the exchange
fails, just run `npm run auth` again rather than reusing the URL.

---

## 4. Add it to Claude

### Claude Code

```bash
claude mcp add zoho-mail --env-file .env -- node "$PWD/dist/stdio.js"
```

Check it came up:

```bash
claude mcp list
```

### Claude Desktop

Edit the config file:

- macOS — `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows — `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "zoho-mail": {
      "command": "node",
      "args": ["/absolute/path/to/Cloude/dist/stdio.js"],
      "env": {
        "ZOHO_CLIENT_ID": "...",
        "ZOHO_CLIENT_SECRET": "...",
        "ZOHO_REFRESH_TOKEN": "...",
        "ZOHO_DC": "us"
      }
    }
  }
}
```

Use an absolute path — Claude Desktop does not expand `~` or `$PWD`. Restart the app
afterwards.

### Remote / HTTP

```bash
MCP_BEARER_TOKEN="$(openssl rand -hex 32)" npm run start:http
```

Serves Streamable HTTP on `http://127.0.0.1:3000/mcp`, plus `/health`. It refuses to
start without a bearer token unless you set `MCP_ALLOW_NO_AUTH=true` — this endpoint can
read and send your mail, so an open port is a real exposure.

To attach it to Claude Code:

```bash
claude mcp add zoho-mail --transport http https://your-host/mcp \
  --header "Authorization: Bearer $MCP_BEARER_TOKEN"
```

Put it behind TLS if it leaves localhost (a tunnel like `cloudflared`, or a reverse
proxy).

**On claude.ai custom connectors:** those expect a public HTTPS endpoint that
implements OAuth 2.0 authorization-server discovery, so the browser can run its own
consent flow against your server. This connector authenticates with a static bearer
token instead. Making it a claude.ai custom connector would mean adding OAuth metadata
endpoints (`/.well-known/oauth-authorization-server`), dynamic client registration, and
per-user token issuance in front of the Zoho credentials — a real piece of work, not a
config flag. For a personal mailbox, the stdio setup above is simpler and keeps the
credentials on your machine.

---

## 5. Try it

> List my unread emails from this week

> Search my Zoho mail for anything from billing@acme.com

> Read the message from Bob about the Q3 report and summarize it

Sending is deliberately not silent — the tool descriptions tell Claude to confirm
recipients and content with you first, and your MCP client will prompt for approval on
each call.

---

## Troubleshooting

**`Missing required environment variable ZOHO_CLIENT_ID`**
The server was started without its environment. In Claude Code, use `--env-file .env`;
in Claude Desktop, put the values in the `env` block. Running `npm start` from the
project directory picks up `.env` automatically.

**`invalid_client`**
The client ID/secret pair does not exist in that region. Almost always a `ZOHO_DC`
mismatch — check where you registered the client.

**`invalid_grant` / `invalid_code`**
The refresh token was revoked or expired. Regenerating the client secret in the console
also invalidates it. Run `npm run auth` again.

**404s on account or folder IDs that look right**
Wrong region. IDs are not portable across data centres.

**`no_refresh_token` during setup**
The authorization code was already used, or consent was opened without offline access.
Re-run `npm run auth` and complete it in one pass.

**Tools do not appear in Claude**
Check the server starts on its own first:

```bash
npm start
```

It should print `[zoho-mail] v0.1.0 ready on stdio` to stderr. If it exits, the message
above the exit says why.
