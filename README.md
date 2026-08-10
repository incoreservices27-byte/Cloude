# Zoho Mail connector

An MCP server that connects a Zoho Mail mailbox to Claude — read, search, send, and
organize mail from a conversation.

There is no Zoho **Mail** connector in the Claude connector directory (Zoho CRM, Desk,
Projects, Books and a few others are there; Mail is not), so this builds one against
Zoho's REST API and OAuth 2.0.

## What it can do

| Tool | What it does |
| --- | --- |
| `list_accounts` | Mailboxes on the login, their IDs and allowed from-addresses |
| `list_folders` | Folders with unread and total counts |
| `list_emails` | Headers from a folder (defaults to Inbox), newest first |
| `search_emails` | Search by `from:`, `subject:`, `to:`, `entire:`, or plain text |
| `get_email` | Full body of one message, HTML converted to text by default |
| `list_attachments` | Attachment names, sizes, and IDs for a message |
| `send_email` | Compose and send |
| `save_draft` | Save to Drafts without sending |
| `reply_to_email` | Reply, reply-all, or forward, threaded onto the original |
| `mark_emails` | Read / unread / flag / archive / spam, in bulk |
| `move_emails` | Move to another folder (moving to Trash is how Zoho deletes) |

Set `ZOHO_MAIL_READ_ONLY=true` and the six read tools are the only ones registered —
the mutating tools do not exist on the wire, so nothing can call them.

## Quick start

```bash
npm install
npm run build
npm run auth      # walks the OAuth consent flow, writes .env
```

Then add it to Claude Code:

```bash
claude mcp add zoho-mail --env-file .env -- node "$PWD/dist/stdio.js"
```

Full walkthrough, including registering the OAuth client and Claude Desktop config:
**[SETUP.md](SETUP.md)**.

## Design notes

**Regions are not interchangeable.** Zoho shards accounts across data centres, and a
token minted at `accounts.zoho.eu` is meaningless to `mail.zoho.com`. `ZOHO_DC` selects
the pair; a mismatch shows up as 404s on valid IDs, so that is called out in the error
hints.

**`Zoho-oauthtoken`, not `Bearer`.** Zoho uses its own authorization scheme. Sending a
`Bearer` header returns 401 with no useful explanation.

**Refresh tokens are the only stored credential.** Access tokens last an hour and are
minted on demand, cached in memory, and refreshed just before expiry. Concurrent tool
calls that all find a stale token share one refresh round-trip rather than stampeding.

**Failures come back as guidance, not stack traces.** Zoho reports OAuth errors as
HTTP 200 with an `error` field, and API errors inside a `status.description`. Both are
unwrapped and paired with a hint that says what to actually do — re-run `npm run auth`,
check `ZOHO_DC`, wait out a rate limit.

**Results are normalised before they reach the model.** Zoho returns dozens of fields
per message; the tools return the ones a mail assistant reasons over, with timestamps
as ISO strings and read state as a boolean. HTML bodies are converted to text unless
you ask for markup. This is about context cost, not tidiness.

**Names, not IDs.** Tools accept `"Inbox"` or `"/Clients/Acme"` and resolve to folder
IDs internally, because the model has only seen what earlier tool results showed it. An
unknown folder name comes back with the list of folders that do exist.

## Transports

- **stdio** (`npm start`) — for Claude Code and Claude Desktop. The mailbox credentials
  stay on your machine. This is the recommended setup.
- **Streamable HTTP** (`npm run start:http`) — for self-hosting the connector as a
  remote MCP server. It refuses to start without `MCP_BEARER_TOKEN` unless you
  explicitly set `MCP_ALLOW_NO_AUTH=true`, because anyone who can reach the URL can
  read and send your mail.

Claude.ai custom connectors expect a public HTTPS endpoint and negotiate OAuth against
the server itself. This server authenticates with a static bearer token instead, which
suits clients that let you set a header (Claude Code's `--header`) but is not a
drop-in for the claude.ai custom-connector flow. See SETUP.md for what that would take.

## Development

```bash
npm run typecheck
npm test          # builds, then runs 101 tests against the built output
```

Tests fake only the HTTP layer, so tool schemas, folder resolution, error mapping, and
the read-only gate are all exercised through a real MCP client over an in-memory
transport.

## Status

Endpoint paths and payloads follow Zoho's published Mail API. They are covered by tests
against a faked transport, and both entry points have been smoke-tested end to end —
but the code has not yet been run against a live Zoho mailbox. Expect first-run
adjustments, most likely in `search_emails` operator syntax and `list_attachments`,
whose response shape is passed through as-is.

## License

MIT
