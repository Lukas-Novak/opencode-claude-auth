# Changelog

## Unreleased (fork, OpenCode 2 port)

Port of the fork's multi-account features onto upstream v3.0.0 (OpenCode 2
plugin API). The request-path wiring moved from v1's auth-loader `fetch`
wrapper into OpenCode 2's `http.request` / `http.response` hooks.

### Features

* accept long-lived tokens pasted from `claude setup-token`, as an additional credential source alongside the Keychain and credentials file. Tokens paste in via `/connect` ("Add Claude token"), or through `OPENCODE_CLAUDE_AUTH_TOKENS` / `CLAUDE_CODE_OAUTH_TOKEN` for headless use. Such tokens are modelled as static credentials: never refreshed, never written back.
* rotate accounts automatically on rate limits. The limited account is benched for a cooldown derived from `retry-after` / `anthropic-ratelimit-unified-*-reset` (short default for an unexplained 429, capped at 6h), the request retries in-flight on the next healthy account in priority order, and benches persist across restarts. Configurable via `OPENCODE_CLAUDE_AUTH_ROTATE*` and `OPENCODE_CLAUDE_AUTH_ACCOUNT_ORDER`; long-context 429s are excluded, since they affect every account equally.
* skip accounts still benched from an earlier session when choosing the startup account.
* remove a stored token via `/connect` ("Remove a stored Claude token").

### Bug Fixes

* redact `sk-ant-*` values in the debug log. Only JWT-shaped values and three specific keys were redacted before, so a `sk-ant-oat…` or `sk-ant-api…` value logged under another key could reach a file the README describes as safe to attach to an issue.

### Port simplifications vs the v1 fork

* rate-limit recovery rides OpenCode 2's native request hooks: rotation happens inside the `http.response` hook instead of a replaced `fetch`. If every account is benched, the 429 surfaces and OpenCode's own retry/backoff re-enters the hook, so requests still complete once a cooldown elapses — but without the v1 fork's in-wrapper wait loop, countdown toasts and cross-process lock handoff.
* account-switch and quota events go to the debug log only; TUI toasts are not ported yet.
* the remove-token method's option list is built at startup; tokens added in the same session appear after a restart.

## [3.0.0](https://github.com/griffinmartin/opencode-claude-auth/compare/v2.2.1...v3.0.0) (2026-10-16)


### ⚠ BREAKING CHANGES

* OpenCode 1 is no longer supported. The plugin now targets OpenCode 2's plugin and auth APIs and must be listed under `plugins` instead of `plugin`. OpenCode 1 users should pin `opencode-claude-auth@2.2.1`.

### Features

* support OpenCode 2 ([#274](https://github.com/griffinmartin/opencode-claude-auth/issues/274)) ([4c4b6cf](https://github.com/griffinmartin/opencode-claude-auth/commit/4c4b6cf1f7249e7ce1faa471d85e7a048d468b83))

## [2.2.1](https://github.com/griffinmartin/opencode-claude-auth/compare/v2.2.0...v2.2.1) (2026-09-22)


### Bug Fixes

* update Claude Code version to 2.1.280 for Opus 5.5 ([#285](https://github.com/griffinmartin/opencode-claude-auth/issues/285)) ([662ee99](https://github.com/griffinmartin/opencode-claude-auth/commit/662ee99d3ace0aa7123e8ca6b4fc0e1ff4fd48e8))

## [2.2.0](https://github.com/griffinmartin/opencode-claude-auth/compare/v2.1.6...v2.2.0) (2026-09-01)


### Features

* update model config for Claude CLI 2.1.257 ([#279](https://github.com/griffinmartin/opencode-claude-auth/issues/279)) ([09a13b4](https://github.com/griffinmartin/opencode-claude-auth/commit/09a13b4c3d5cf7c303cf234207627e667efa5277))

## [2.1.6](https://github.com/griffinmartin/opencode-claude-auth/compare/v2.1.5...v2.1.6) (2026-08-03)


### Bug Fixes

* make OAuth refresh resilient to transient rate-limits (+ diagnostics) ([#264](https://github.com/griffinmartin/opencode-claude-auth/issues/264)) ([5532c37](https://github.com/griffinmartin/opencode-claude-auth/commit/5532c37dec127f0a6cac2308901e030d75331f1a))
* preserve thinking blocks when repairing tool pairs after compaction ([#263](https://github.com/griffinmartin/opencode-claude-auth/issues/263)) ([8de49c8](https://github.com/griffinmartin/opencode-claude-auth/commit/8de49c81a0effeb0217b2d98aa7d7b4a1f389ed3))

## [2.1.5](https://github.com/griffinmartin/opencode-claude-auth/compare/v2.1.4...v2.1.5) (2026-07-30)


### Bug Fixes

* handle external rotation of the Claude Code credential ([#260](https://github.com/griffinmartin/opencode-claude-auth/issues/260)) ([5a44883](https://github.com/griffinmartin/opencode-claude-auth/commit/5a44883817bfc7f1aa497f2c06432d7e5c472c08))
* refresh OAuth tokens with native fetch instead of a subprocess ([#258](https://github.com/griffinmartin/opencode-claude-auth/issues/258)) ([231165b](https://github.com/griffinmartin/opencode-claude-auth/commit/231165b9859c6195c412896e1207daf2aed4affa))

## [2.1.4](https://github.com/griffinmartin/opencode-claude-auth/compare/v2.1.3...v2.1.4) (2026-07-26)


### Bug Fixes

* proactive OAuth token refresh before session expiry ([#238](https://github.com/griffinmartin/opencode-claude-auth/issues/238)) ([ed1d735](https://github.com/griffinmartin/opencode-claude-auth/commit/ed1d7357b62eb9e50461ef3e6b6f447bbc68fd71))

## [2.1.3](https://github.com/griffinmartin/opencode-claude-auth/compare/v2.1.2...v2.1.3) (2026-07-25)


### Bug Fixes

* honor `CLAUDE_CONFIG_DIR` ([#239](https://github.com/griffinmartin/opencode-claude-auth/issues/239)) ([65e1bb3](https://github.com/griffinmartin/opencode-claude-auth/commit/65e1bb367bd92bbae57e74d6c4d8db0ae91d688f))
