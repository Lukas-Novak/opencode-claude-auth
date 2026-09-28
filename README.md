# opencode-claude-auth

[![npm](https://img.shields.io/npm/v/opencode-claude-auth)](https://www.npmjs.com/package/opencode-claude-auth)
[![CI](https://github.com/griffinmartin/opencode-claude-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/griffinmartin/opencode-claude-auth/actions/workflows/ci.yml)
[![Socket Badge](https://socket.dev/api/badge/npm/package/opencode-claude-auth)](https://socket.dev/npm/package/opencode-claude-auth)

Self-contained Anthropic auth provider for OpenCode 2 using your Claude Code subscription credentials — no separate login or API key needed.

> **3.0.0 and later require OpenCode 2.0+ and will not load on OpenCode 1.x.** The last version that supports OpenCode 1.x is **2.2.1** — see [Migrating from OpenCode 1](#migrating-from-opencode-1).

## Compatibility

| opencode-claude-auth | OpenCode  | Config key | Install                       |
| -------------------- | --------- | ---------- | ----------------------------- |
| 3.0.0+               | 2.0+ only | `plugins`  | `opencode-claude-auth@latest` |
| 2.2.1 and earlier    | 1.x       | `plugin`   | `opencode-claude-auth@2.2.1`  |

## How it works

The plugin registers a Claude Code subscription auth method on OpenCode's built-in Anthropic provider. Run `/connect`, choose **Anthropic**, then **Import Claude Code subscription** — it reads OAuth tokens directly from the macOS Keychain (or `~/.claude/.credentials.json` — or `$CLAUDE_CONFIG_DIR/.credentials.json` if that env var is set — on other platforms) and hands them to OpenCode.

OpenCode's native Anthropic provider handles prompt conversion and streaming. Session hooks add the Claude Code identity and adjust subscription requests to set `Authorization: Bearer` with the current access token (and strip `x-api-key`), translate tool names, and process responses. OpenCode owns the credential's lifecycle from there and calls back into the plugin to refresh it as needed. Refreshes go directly to Anthropic's OAuth endpoint (zero LLM tokens consumed); the plugin always checks the keychain first and adopts whatever is there if it differs from what OpenCode handed back, so an independent `claude` re-login or refresh doesn't leave OpenCode stuck retrying a dead token. It falls back to the `claude` CLI only in the narrow window where Claude Code will actually rotate the token.

Beyond the accounts Claude Code already stores, you can paste in long-lived tokens from `claude setup-token` — one per subscription, no extra Claude Code logins — and the plugin moves between accounts automatically when one hits a rate limit. See [Pasted tokens](#pasted-tokens-multiple-subscriptions-without-multiple-logins) and [Automatic rotation](#automatic-rotation-on-rate-limits).

## Alternative: CLIProxyAPI (plugin not required)

If you run [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), you don't need this plugin. CLIProxyAPI logs in to your Claude Code account with OAuth, handles token refresh, and exposes a Claude-compatible API on `http://localhost:8317` by default. Point OpenCode's built-in Anthropic provider at it:

1. Log in with your Claude Code account (via the proxy's `-claude-login` flag) and set an `api-keys` entry in its `config.yaml`.
2. Configure the Anthropic provider in `~/.config/opencode/opencode.json`:

   ```json
   {
     "provider": {
       "anthropic": {
         "options": {
           "baseURL": "http://localhost:8317",
           "apiKey": "your-api-key-1"
         }
       }
     }
   }
   ```

Remove `opencode-claude-auth` from your `plugins` list when using this setup — the two approaches shouldn't be combined. CLIProxyAPI also supports multi-account load balancing and other providers (Codex, Gemini, Grok). This plugin remains the lighter option if you only need Claude Code credentials in OpenCode with no extra service running.

## Prerequisites

- OpenCode 2 installed — see the [OpenCode 2 migration guide](https://opencode.ai/v2/docs/migrate-v1) for installation instructions
- A Claude subscription, reached either way:
  - Claude Code installed and authenticated (run `claude` at least once), or
  - a long-lived token from `claude setup-token`, pasted in — see [Pasted tokens](#pasted-tokens-multiple-subscriptions-without-multiple-logins). This needs no Claude Code login on the machine.

macOS is preferred (uses Keychain). Linux and Windows work via the credentials file fallback, and pasted tokens work everywhere.

## Installation

**For Humans**

**Option A: Let an LLM do it**

Paste this into any LLM agent (Claude Code, OpenCode, Cursor, etc.):

```
Install the opencode-claude-auth plugin and configure it by following: https://raw.githubusercontent.com/griffinmartin/opencode-claude-auth/main/installation.md
```

**Option B: Manual setup**

1. **Add the plugin** to `~/.config/opencode/opencode.json`:

   ```json
   {
     "plugins": ["opencode-claude-auth@latest"]
   }
   ```

   > OpenCode 2 uses the `plugins` key (plural) — OpenCode 1 used `plugin` (singular). The `@latest` tag ensures OpenCode always pulls the newest version on startup. No manual `npm install` is needed — OpenCode [automatically installs npm plugins using Bun at startup](https://opencode.ai/docs/plugins/#how-plugins-are-installed).

2. **Connect it** — restart OpenCode, run `/connect`, choose **Anthropic**, then **Import Claude Code subscription**. Use `/models` and pick a model under **Anthropic**.

**For LLM Agents**

See [installation.md](installation.md) for step-by-step agent instructions.

## Usage

Run `/connect` once to import your Claude Code subscription, then use OpenCode normally — the plugin refreshes credentials automatically and provides them to the Anthropic API. If your credentials aren't OAuth-based, the connection falls through to standard API key auth.

## Migrating from OpenCode 1

OpenCode 2 replaced the plugin and auth APIs this plugin used under OpenCode 1, so 3.0.0 and later only load on OpenCode 2.

1. Upgrade OpenCode — see the [OpenCode 2 migration guide](https://opencode.ai/v2/docs/migrate-v1).
2. In `~/.config/opencode/opencode.json`, move the plugin from the `plugin` key (OpenCode 1) to `plugins` (OpenCode 2):

   ```json
   {
     "plugins": ["opencode-claude-auth@latest"]
   }
   ```

3. Restart OpenCode, run `/connect`, choose **Anthropic**, then **Import Claude Code subscription**. The OpenCode 1 connection isn't carried over.

### Staying on OpenCode 1

**2.2.1** is the last release that supports OpenCode 1. Pin it instead of tracking `@latest`:

```json
{
  "plugin": ["opencode-claude-auth@2.2.1"]
}
```

## Supported models

14 supported models. Run `pnpm run test:models` to verify against your account.

| Model                      |
| -------------------------- |
| claude-fable-5             |
| claude-fable-5-1           |
| claude-haiku-4-5           |
| claude-haiku-4-5-20251001  |
| claude-opus-4-5            |
| claude-opus-4-5-20251101   |
| claude-opus-4-6            |
| claude-opus-4-7            |
| claude-opus-4-8            |
| claude-opus-5              |
| claude-sonnet-4-5          |
| claude-sonnet-4-5-20250929 |
| claude-sonnet-4-6          |
| claude-sonnet-5            |

## Credential sources

The plugin checks these in order:

1. macOS Keychain (all `Claude Code-credentials*` entries — multiple accounts are detected automatically)
2. `~/.claude/.credentials.json` (fallback, works on all platforms; if `CLAUDE_CONFIG_DIR` is set, reads `$CLAUDE_CONFIG_DIR/.credentials.json` instead)
3. Long-lived tokens you pasted in from `claude setup-token` — see [Pasted tokens](#pasted-tokens-multiple-subscriptions-without-multiple-logins)

All of them form a single account pool. Keychain and credentials-file accounts come first, pasted tokens after, and that order is the priority order used by [automatic rotation](#automatic-rotation-on-rate-limits).

## Pasted tokens (multiple subscriptions without multiple logins)

If you have more than one Claude subscription, you don't need to juggle multiple Claude Code logins in the Keychain. Generate a long-lived token per subscription and paste them in.

For each subscription, log into Claude Code with that account and run:

```bash
claude setup-token
```

That prints a long-lived (1-year), inference-only token starting with `sk-ant-oat01-`. Then in OpenCode:

```bash
opencode auth login
```

Pick **"Add Claude token (paste from `claude setup-token`)"** and paste. You can paste several at once, separated by spaces or commas — no need to repeat the flow per token. The optional label is what you'll see in the account picker (`work` becomes `work 1`, `work 2`, … for a multi-token paste).

Pasting a token switches to it immediately. Re-pasting a token you already have is a no-op, not a duplicate account.

To remove one, run `opencode auth login` and pick **"Remove a stored Claude token"**.

Tokens are stored in `~/.local/share/opencode/claude-auth-tokens.json` with `0600` permissions. They are secrets — treat that file like an SSH key.

### Headless and CI

Where there's no TUI to paste into, use an environment variable instead. Both are read; multiple tokens separate with commas:

```bash
export OPENCODE_CLAUDE_AUTH_TOKENS="sk-ant-oat01-…,sk-ant-oat01-…"
export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-…"   # Claude Code's own variable
```

Environment tokens take priority over stored ones and are never written to disk, so unsetting the variable removes the account.

### What these tokens can and can't do

- They need no refresh — nothing expires mid-session and no `claude` CLI spawn is ever needed to renew one.
- They are **inference-only** by design (`setup-token` sessions are limited to `user:inference`).
- They work on any platform, with no Keychain and no Claude Code login on the machine.

## Automatic rotation on rate limits

When a request comes back rate-limited, the plugin benches that account and retries on the next healthy one — within the same request, so you usually just see a toast rather than an error.

- **Selection is sticky**, not round-robin: a healthy active account stays selected. Failover uses priority order among eligible accounts. Override that order with `OPENCODE_CLAUDE_AUTH_ACCOUNT_ORDER`.
- **Benches are remembered across restarts** (`~/.local/share/opencode/claude-auth-rotation.json`), so restarting OpenCode during a usage limit doesn't put you back on the exhausted account.
- **How long depends on what the API says.** A `retry-after` or `anthropic-ratelimit-unified-*-reset` header sets the bench; an unexplained 429 gets a short 60s bench instead, so a transient blip doesn't write an account off for hours. Benches are capped at 6h.
- **A bench clears as soon as the account works again**, so an early reset doesn't leave it sitting out.
- **Long-context 429s don't rotate.** That error is about request headers, not your allowance, and every account shares it — it's handled by the existing beta-flag retry instead.

The account picker in `opencode auth login` shows which accounts are benched and for how long. A request skips a benched sticky account when another account is eligible.

When every account is rate-limited, the plugin holds the request until the earliest recorded cooldown expires (plus a safety margin and jitter), then re-evaluates the pool and retries. Local changes to the roster or cooldowns trigger immediate re-evaluation. Progress ticks preserve the planned deadline and do not consume additional wait cycles. Concurrent processes serialize cooldown updates; each waiting request owns its own countdown file.

Caller cancellation stops the wait. If OpenCode's **response-header deadline** expires during a quota wait, the plugin returns a deferred 429 with `retry-after` computed from the earliest cooldown, allowing OpenCode's retry scheduler to continue. For uninterrupted long waits, merge `"headerTimeout": false` and `"timeout": false` into `provider.anthropic.options` and restart OpenCode. Actual network attempts still have their own header deadline (`OPENCODE_CLAUDE_AUTH_NETWORK_TIMEOUT_MS`, default 120 seconds).

`OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MAX_CYCLES` limits wait/replanning cycles and `OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MAX_MS` limits cumulative sleep. Both default to unlimited. `OPENCODE_CLAUDE_AUTH_ROTATE_WAIT=0` disables waiting.

### Regression and sandbox tests

```bash
npm run test:node18
npm run build
node scripts/e2e-notouch.mjs --scenario concurrent
node scripts/e2e-notouch.mjs --scenario stop
node scripts/e2e-notouch.mjs --scenario deadline
node scripts/e2e-notouch.mjs --scenario long
```

The sandbox scenarios start their own OpenCode server, use an isolated HOME/config/cache and mock tokens, and route plugin HTTP requests exclusively to a loopback stub. `long` takes roughly six minutes and asserts that automatic completion crosses the actual 300-second boundary. `deadline` shortens OpenCode's header deadline to exercise native retry. Successful runs remove their sandbox; failures print its path for inspection. Set `OPENCODE_BIN` to use a particular OpenCode binary.

### Seeing the real next-attempt countdown

`node scripts/quota-watch.mjs --watch` shows persisted account cooldowns and any plugin-held waits. To also see **OpenCode's native session retry schedule**, including the gap between HTTP attempts:

```bash
node scripts/quota-watch.mjs --watch \
  --server http://127.0.0.1:PORT \
  --session SESSION_ID \
  --directory /path/to/project \
  --time-zone Europe/Prague
```

The display ticks locally every second and refreshes OpenCode's read-only `/session/status` endpoint every 15 seconds. It makes no Anthropic requests and never sends credentials. A missing plugin-wait file does **not** imply a stopped session: OpenCode may be waiting on its own `retry.next` deadline. Account eligibility and a scheduled retry are displayed separately.

Plugin progress notifications use OpenCode's `tui.showToast`. Paseo's current OpenCode adapter does not forward those to its chat panel, and it forwards the native retry message without the `next` timestamp. Therefore the watcher provides a terminal countdown; displaying it inline in Paseo chat requires a separate adapter/UI change.

To turn rotation off and keep manual switching only:

```bash
export OPENCODE_CLAUDE_AUTH_ROTATE=0
```

## Multiple accounts (macOS)

If you have [multiple Claude Code accounts](https://gist.github.com/KMJ-007/0979814968722051620461ab2aa01bf2) authenticated on macOS, they're all detected from the Keychain automatically and offered as a selection prompt when you run `/connect`. Each account is labeled by its subscription tier (Claude Pro, Claude Max, etc.).

To switch accounts, re-run `/connect` and pick a different one. Your selection is persisted across sessions.

If only one account is found, the selection prompt is skipped and the plugin uses it directly.

## Troubleshooting

| Problem                                                                               | Solution                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Credentials not found"                                                               | Run `claude` to authenticate with Claude Code first                                                                                                                                                           |
| "Keychain is locked"                                                                  | Run `security unlock-keychain ~/Library/Keychains/login.keychain-db`                                                                                                                                          |
| "Token expired and refresh failed"                                                    | The plugin runs `claude` CLI to refresh automatically. If this fails, re-authenticate manually by running `claude`                                                                                            |
| Not working on Linux/Windows                                                          | Ensure `~/.claude/.credentials.json` exists (or `$CLAUDE_CONFIG_DIR/.credentials.json` if that env var is set). Run `claude` to create it                                                                     |
| Keychain access denied                                                                | Grant access when macOS prompts you                                                                                                                                                                           |
| Keychain read timed out                                                               | Restart Keychain Access (can happen on macOS Tahoe)                                                                                                                                                           |
| "Credentials are unavailable or expired"                                              | Run `claude` to refresh your Claude Code credentials                                                                                                                                                          |
| Auth keeps failing right after re-authenticating with `claude`                        | OpenCode may still be holding a refresh token from a previous `/connect` that's now stale. The plugin re-syncs from the keychain automatically on the next refresh; if it's still stuck, run `/connect` again |
| "Extra usage is required for long context requests"                                   | Your conversation exceeded 200k tokens. See [Long context (1M)](#long-context-1m) below                                                                                                                       |
| Plugin not updating to latest version                                                 | Delete the cached package: `rm -rf ~/.cache/opencode/packages/opencode-claude-auth@latest/` then restart OpenCode                                                                                             |
| `opencode auth login` prints "Only http and https links can be opened in the browser" | Harmless: importing has no browser step, but the CLI tries to open one anyway. The credential is still saved — confirm with `opencode auth list`                                                              |
| Pasted token rejected as invalid                    | It must look like `sk-ant-oat01-…` from `claude setup-token`. An `sk-ant-api03-…` API key is a different thing and won't work here        |
| "All Claude accounts are rate-limited"              | Every account is benched. Wait for the soonest cooldown (OpenCode retries pick back up automatically), or reconnect with a fresh account/token |
| Rotation isn't switching accounts                   | Confirm more than one account is in the pool and that `OPENCODE_CLAUDE_AUTH_ROTATE` isn't `0`                                           |
| Want one subscription used first                    | Set `OPENCODE_CLAUDE_AUTH_ACCOUNT_ORDER` to the account sources in your preferred order                                                   |

### Diagnostic logging

If you're hitting auth errors that are hard to reproduce, enable debug logging to capture the full auth flow:

```bash
export CLAUDE_AUTH_DEBUG=1
```

Restart OpenCode and reproduce the issue. The plugin writes structured JSON logs to `~/.local/share/opencode/claude-auth-debug.log`. All secrets (tokens, API keys) are automatically redacted — the log file is safe to paste into a GitHub issue.

To write logs to a custom path:

```bash
export CLAUDE_AUTH_DEBUG=/tmp/claude-auth-debug.log
```

Disable when done:

```bash
unset CLAUDE_AUTH_DEBUG
```

## Long context (1M)

1M token context is supported natively — the API no longer requires a beta flag for it, so the plugin doesn't send the legacy `context-1m-2025-08-07` header.

If your plan doesn't cover long context billing, requests beyond the standard window fail with "Extra usage is required for long context requests". When a long context error is caused by a beta flag (e.g. one added via `ANTHROPIC_BETA_FLAGS`), the plugin retries without the offending flag.

## Validating OAuth refresh

To verify the direct OAuth token refresh works with your credentials:

```bash
pnpm run validate:oauth           # refresh + write-back (safe, keeps credentials valid)
pnpm run validate:oauth -- --dry-run  # show what would be sent without making the request
```

This reads your stored credentials, calls Anthropic's OAuth token endpoint, and writes the new tokens back to storage. Refresh tokens rotate on each use, so write-back is enabled by default to keep your stored credentials valid.

## Environment variable overrides

All configurable parameters can be overridden via environment variables. If Anthropic changes something before we publish an update, set an env var and keep working:

| Variable                                      | Description                                                                                                                                                                                                                                                                       | Default                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ANTHROPIC_CLI_VERSION`                       | Claude CLI version for user-agent and billing headers                                                                                                                                                                                                                             | `config.ccVersion` in [`src/model-config.ts`](src/model-config.ts) |
| `ANTHROPIC_USER_AGENT`                        | Full User-Agent string (overrides CLI version)                                                                                                                                                                                                                                    | `claude-cli/{version} (external, sdk-cli)`                         |
| `ANTHROPIC_BETA_FLAGS`                        | Comma-separated beta feature flags                                                                                                                                                                                                                                                | `baseBetas` list in [`src/model-config.ts`](src/model-config.ts)   |
| `CLAUDE_AUTH_DEBUG`                           | Enable diagnostic logging (`1` for default path, or a custom file path)                                                                                                                                                                                                           | disabled                                                           |
| `CLAUDE_CONFIG_DIR`                           | Claude Code config directory used for the credentials-file fallback (reads `$CLAUDE_CONFIG_DIR/.credentials.json`). macOS still checks the Keychain first.                                                                                                                        | `~/.claude`                                                        |
| `OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS`           | Max ms the plugin waits when honouring a 429/529 `retry-after` header. Beyond this cap the response surfaces immediately so OpenCode doesn't appear to hang on hour-long quota resets.                                                                                            | `30000`                                                            |
| `OPENCODE_CLAUDE_AUTH_TOOL_REPAIR`            | Strategy for reconciling `tool_use`/`tool_result` adjacency broken by OpenCode auto-compaction. `placeholder` synthesizes a paired result for orphaned `tool_use` blocks (lossless, preserves `thinking` blocks); `drop` removes orphaned blocks (omitting whole thinking turns). | `placeholder`                                                      |
| `OPENCODE_CLAUDE_AUTH_REFRESH_WAIT_MS`        | Max ms a single request waits through a transient token-refresh rate-limit (429) before returning a retryable error instead of a hard "run `claude`".                                                                                                                             | `45000`                                                            |
| `OPENCODE_CLAUDE_AUTH_REFRESH_COOLDOWN_MS`    | Base per-account cooldown after a rate-limited refresh, before the plugin retries the token endpoint. Escalates with consecutive failures and is jittered; capped at 60s.                                                                                                         | `15000`                                                            |
| `OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_TTL_MS`    | TTL for the cross-process refresh lock. A held lock older than this is treated as stale (crashed holder) and taken over.                                                                                                                                                          | `20000`                                                            |
| `OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR`       | Directory for the advisory cross-process refresh lock files.                                                                                                                                                                                                                      | OpenCode data dir (`~/.local/share/opencode`)                      |
| `OPENCODE_CLAUDE_AUTH_TOKENS`                 | Comma- or space-separated long-lived tokens from `claude setup-token`, for headless use. Takes priority over the stored token file and is never persisted.                                                                                                                        | unset                                                              |
| `CLAUDE_CODE_OAUTH_TOKEN`                     | Claude Code's own variable for a `setup-token` value. Honoured as an additional pasted-token source.                                                                                                                                                                              | unset                                                              |
| `OPENCODE_CLAUDE_AUTH_TOKENS_FILE`            | Path to the pasted-token store.                                                                                                                                                                                                                                                   | `~/.local/share/opencode/claude-auth-tokens.json`                  |
| `OPENCODE_CLAUDE_AUTH_ROTATE`                 | Automatic account rotation on rate limits. Set to `0` to disable and keep manual switching only.                                                                                                                                                                                  | enabled                                                            |
| `OPENCODE_CLAUDE_AUTH_ACCOUNT_ORDER`          | Comma-separated account sources in preferred order (e.g. `Claude Code-credentials,token:a1b2c3d4`). Sources not listed follow, in discovery order.                                                                                                                                | discovery order                                                    |
| `OPENCODE_CLAUDE_AUTH_ROTATE_COOLDOWN_MS`     | Bench length for a 429 that carries no `retry-after` or reset header. Kept short so a transient limit doesn't sideline an account for hours.                                                                                                                                      | `60000`                                                            |
| `OPENCODE_CLAUDE_AUTH_ROTATE_MAX_COOLDOWN_MS` | Ceiling on any bench, however long the server says to wait. Exceeding it costs at most one extra 429; an uncapped weekly reset would park an account for days.                                                                                                                    | `21600000` (6h)                                                    |
| `OPENCODE_CLAUDE_AUTH_ROTATE_MAX_SWITCHES`    | How many accounts a single request may walk through before surfacing the rate limit.                                                                                                                                                                                              | `3`                                                                |
| `OPENCODE_CLAUDE_AUTH_ROTATION_FILE`          | Path to the persisted rate-limit cooldown state.                                                                                                                                                                                                                                  | `~/.local/share/opencode/claude-auth-rotation.json`                |

Example:

```bash
export ANTHROPIC_CLI_VERSION=2.2.0
```

## How it works (technical)

- Registers a Claude Code subscription auth method on OpenCode's built-in Anthropic integration (`ctx.integration.transform`), surfaced as **Import Claude Code subscription** under `/connect`
- Uses OpenCode 2's native Anthropic provider for prompt conversion and streaming, while session HTTP hooks in `src/index.ts` apply the subscription transport in `src/provider.ts` only to Claude Code OAuth connections
- The request hook sets `Authorization: Bearer` with the current OAuth access token and strips `x-api-key`, translates tool names between OpenCode and Anthropic API formats (adds/strips `mcp_` prefix), and sets required API headers (beta flags, billing, user-agent) with model-aware selection; the response hook buffers SSE streams at event boundaries for reliable tool name translation
- Injects the Claude Code identity into system prompts via the `context`, `compaction`, `generate`, and `title` session hooks — OpenCode 2 dispatches a separate hook per request kind, and all four bill to the connected subscription
- On macOS, enumerates all `Claude Code-credentials*` Keychain entries and labels them by subscription tier; multiple accounts are offered as a selection prompt during `/connect`
- OpenCode persists the resulting OAuth credential (access + refresh token) itself and calls back into the plugin's `refresh` hook whenever it decides one is needed — the plugin doesn't run its own background timer
- Before ever attempting a network refresh, re-reads the keychain directly and adopts whatever is there if it differs from the token OpenCode handed back. This keeps things working if `claude` rotated credentials independently of this connection (an interactive re-login, its own periodic refresh, ...) — otherwise OpenCode would keep retrying the same now-dead refresh token on every call, forever
- OpenCode's `refresh` callback and the request path share one in-flight refresh per account behind a cross-process lock, so they never spend the same single-use refresh token twice
- Refreshes directly via `POST https://claude.ai/v1/oauth/token` using the runtime's own `fetch` (no LLM tokens consumed, no subprocess); falls back to the `claude` CLI only within the window where Claude Code will actually rotate the token, and writes new tokens back to Keychain (macOS) or the credentials file (Linux/Windows) to keep stored credentials in sync
- Retries API requests on 429 (rate limit) and 529 (overloaded) with exponential backoff, respecting `retry-after` headers
- On a 401, recovers in place rather than surfacing it: adopts an externally rotated token if the keychain now holds one, otherwise forces an OAuth refresh, then retries the request
- If credentials aren't OAuth-based, the connection falls through to standard API key auth
- If credentials are unavailable or unreadable, the plugin logs the error and OpenCode continues without a Claude Code auth connection

## Disclaimer

This plugin uses Claude Code's OAuth credentials to authenticate with Anthropic's API. Anthropic's Terms of Service state that Claude Pro/Max subscription tokens should only be used with official Anthropic clients. This plugin exists as a community workaround and may stop working if Anthropic changes their OAuth infrastructure. Use at your own discretion.

## License

MIT
