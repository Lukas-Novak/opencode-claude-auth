import { Credential, Integration, Plugin, Provider } from "@opencode/plugin"
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/promise/integration"
import type { SessionRequest } from "@opencode/plugin/promise/session"
import {
  chooseInitialAccount,
  getAccountBySource,
  getActiveAccount,
  getCachedCredentials,
  initAccounts,
  loadPersistedAccountSource,
  refreshAccountsList,
  saveAccountSource,
  setActiveAccountSource,
} from "./credentials.ts"
import { readAllClaudeAccounts } from "./keychain.ts"
import { initLogger, log } from "./logger.ts"
import {
  authorizeOAuth,
  CLAUDE_CODE_OAUTH_METADATA_KEY,
  CLAUDE_CODE_OAUTH_METADATA_VALUE,
  INTEGRATION_ID,
  labelOAuthCredential,
  oauthMethodDescriptor,
  realOAuthDeps,
  refreshOAuthCredential,
} from "./oauth-method.ts"
import { finishClaudeResponse, prepareClaudeRequest } from "./provider.ts"
import { activeCooldowns } from "./rotation.ts"
import {
  addTokens,
  isTokenSource,
  listTokenEntries,
  parsePastedTokens,
  removeToken,
  tokenFingerprint,
  validateTokenInput,
} from "./token-store.ts"

export * from "./betas.ts"
export * from "./credentials.ts"
export * from "./oauth-method.ts"
export * from "./provider.ts"
export * from "./signing.ts"
export * from "./transforms.ts"

const PROVIDER_ID = Provider.ID.make("anthropic")
const SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude."

/** Method id for pasted `claude setup-token` credentials (never refreshed). */
export const TOKEN_METHOD_ID = Integration.MethodID.make("claude-setup-token")
/** Method id for the remove-a-stored-token flow. */
export const REMOVE_TOKEN_METHOD_ID = Integration.MethodID.make(
  "claude-token-remove",
)

/**
 * Session request kinds that reach the model and are billed to the connected
 * subscription. OpenCode 2 dispatches one hook per kind - `context` drives the
 * agent loop, and compaction, generation and title are issued alongside it - so
 * a hook registered for only one of them leaves the rest without the identity
 * Claude Code requests are expected to carry.
 */
export const IDENTITY_REQUEST_HOOKS = [
  "context",
  "compaction",
  "generate",
  "title",
] as const

/** Prepends the Claude Code identity to an Anthropic request, once. */
export function injectClaudeIdentity(event: SessionRequest): void {
  if (event.model.providerID !== PROVIDER_ID) return
  if (event.system.some((part) => part.text.includes(SYSTEM_IDENTITY))) return
  event.system.unshift({ type: "text", text: SYSTEM_IDENTITY })
}

/** True for any credential produced by this plugin, whichever method made it. */
function isPluginCredential(credential: {
  type: string
  metadata?: Record<string, unknown>
}): boolean {
  return (
    credential.type === "oauth" &&
    credential.metadata?.[CLAUDE_CODE_OAUTH_METADATA_KEY] ===
      CLAUDE_CODE_OAUTH_METADATA_VALUE
  )
}

function oauth(accounts: ReturnType<typeof readAllClaudeAccounts>) {
  return {
    integrationID: INTEGRATION_ID,
    method: oauthMethodDescriptor(accounts),
    authorize: async (inputs) => {
      const value = await authorizeOAuth(inputs, accounts, realOAuthDeps)
      return {
        mode: "auto" as const,
        url: "",
        instructions: "Claude Code credentials imported from this device.",
        callback: Promise.resolve(value),
      }
    },
    refresh: (value) => refreshOAuthCredential(value, realOAuthDeps),
    label: (value) => labelOAuthCredential(value),
  } satisfies IntegrationOAuthMethodRegistration
}

interface StaticCredentialShape {
  readonly type: "oauth"
  readonly access: string
  readonly refresh?: string
  readonly metadata?: Record<string, unknown>
}

function buildTokenCredential(
  account: { source: string; label: string },
  creds: { accessToken: string; refreshToken: string; expiresAt: number },
): Credential.OAuth {
  return Credential.OAuth.make({
    type: "oauth",
    methodID: isTokenSource(account.source)
      ? TOKEN_METHOD_ID
      : Integration.MethodID.make("claude-code"),
    access: creds.accessToken,
    refresh: creds.refreshToken,
    expires: creds.expiresAt,
    metadata: {
      [CLAUDE_CODE_OAUTH_METADATA_KEY]: CLAUDE_CODE_OAUTH_METADATA_VALUE,
      source: account.source,
      label: account.label,
    },
  })
}

/**
 * A pasted token cannot be refreshed — but it also cannot expire, so the host
 * should never call this. If it does, re-read the store so a token the user
 * replaced or removed is reflected instead of replaying a stale copy.
 */
function refreshStaticTokenCredential(
  value: StaticCredentialShape,
): Promise<Credential.OAuth> {
  const source =
    typeof value.metadata?.source === "string" ? value.metadata.source : ""
  const account = source ? getAccountBySource(source) : null
  if (!account)
    throw new Error(
      "The stored Claude token is no longer available — paste it again to reconnect.",
    )
  return Promise.resolve(buildTokenCredential(account, account.credentials))
}

/**
 * `/connect` flow: paste one or more long-lived tokens from
 * `claude setup-token`. They join the rotation pool as static credentials —
 * never refreshed, never written back — and the first newly added token
 * becomes the active account immediately, because pasting one is an explicit
 * statement of intent.
 */
function tokenMethod() {
  return {
    integrationID: INTEGRATION_ID,
    method: {
      id: TOKEN_METHOD_ID,
      type: "oauth",
      label: "Add Claude token (paste from `claude setup-token`)",
      form: [
        {
          type: "string",
          key: "tokens",
          title: "Token(s) from `claude setup-token`",
          required: true,
          placeholder: "sk-ant-oat01-… sk-ant-oat01-…",
        },
        {
          type: "string",
          key: "label",
          title: "Label for these accounts (optional)",
          required: false,
          placeholder: "work",
        },
      ],
    },
    authorize: async (inputs: { tokens?: unknown; label?: unknown }) => {
      const raw = typeof inputs?.tokens === "string" ? inputs.tokens : ""
      const problem = validateTokenInput(raw)
      if (problem) throw new Error(problem)
      const label =
        typeof inputs?.label === "string" && inputs.label.trim().length > 0
          ? inputs.label.trim()
          : undefined
      const { tokens } = parsePastedTokens(raw)
      const result = addTokens(tokens, label)

      const roster = refreshAccountsList()
      const target = result.added[0]
        ? roster.find(
            (a) => a.source === `token:${result.added[0]?.id ?? ""}`,
          )
        : undefined

      if (target) {
        setActiveAccountSource(target.source)
        saveAccountSource(target.source)
      }
      const creds = await getCachedCredentials()

      const parts: string[] = []
      if (result.added.length > 0)
        parts.push(
          `Added ${result.added.length} token${result.added.length === 1 ? "" : "s"}`,
        )
      if (result.duplicates.length > 0)
        parts.push(`${result.duplicates.length} already stored`)
      if (!result.persisted)
        parts.push(
          "WARNING: could not write the token store — tokens apply to this session only",
        )
      if (target) parts.push(`now using ${target.label}`)
      parts.push(`${roster.length} accounts available for rotation`)
      const summary = parts.join("; ")

      if (!creds)
        throw new Error(
          `${summary}. No usable credentials — run \`claude\` or paste a valid token.`,
        )
      const active = getActiveAccount() ?? target
      if (!active)
        throw new Error(
          `${summary}. No usable credentials — run \`claude\` or paste a valid token.`,
        )
      return {
        mode: "auto" as const,
        url: "",
        instructions: `${summary}.`,
        callback: Promise.resolve(buildTokenCredential(active, creds)),
      }
    },
    refresh: (value: StaticCredentialShape) =>
      refreshStaticTokenCredential(value),
    label: (value: { metadata?: Record<string, unknown> }) =>
      typeof value.metadata?.label === "string"
        ? value.metadata.label
        : undefined,
  } satisfies IntegrationOAuthMethodRegistration
}

/**
 * `/connect` flow: remove a pasted token from the store. Environment-supplied
 * tokens (addedAt === 0) have no stored record and can't be removed here.
 * Registered only when there is something to remove — the form's option list
 * is built once at startup, so a token added later appears after a restart.
 */
function removeTokenMethod(
  entries: ReturnType<typeof listTokenEntries>,
) {
  return {
    integrationID: INTEGRATION_ID,
    method: {
      id: REMOVE_TOKEN_METHOD_ID,
      type: "oauth",
      label: "Remove a stored Claude token",
      form: [
        {
          type: "string",
          key: "id",
          title: "Which stored token should be removed?",
          required: true,
          options: entries.map((entry) => ({
            value: entry.id,
            label: entry.label
              ? `${entry.label} (${tokenFingerprint(entry.token)})`
              : `Token ${tokenFingerprint(entry.token)}`,
          })),
        },
      ],
    },
    authorize: async (inputs: { id?: unknown }) => {
      const id = typeof inputs?.id === "string" ? inputs.id : ""
      const removed = id ? removeToken(id) : false
      const roster = refreshAccountsList()

      // The removed token may have been the active account, so re-resolve
      // rather than assuming the session still has usable credentials.
      if (!getActiveAccount() && roster[0]) {
        setActiveAccountSource(roster[0].source)
        saveAccountSource(roster[0].source)
      }
      const creds = await getCachedCredentials()
      const summary = removed
        ? `Removed the token; ${roster.length} accounts remain`
        : "No matching token was stored"
      if (!creds)
        throw new Error(
          `${summary}. No usable credentials remain — run \`claude\` or paste a token.`,
        )
      const active = getActiveAccount() ?? roster[0]
      if (!active)
        throw new Error(
          `${summary}. No usable credentials remain — run \`claude\` or paste a token.`,
        )
      return {
        mode: "auto" as const,
        url: "",
        instructions: `${summary}.`,
        callback: Promise.resolve(buildTokenCredential(active, creds)),
      }
    },
    refresh: (value: StaticCredentialShape) =>
      refreshStaticTokenCredential(value),
    label: (value: { metadata?: Record<string, unknown> }) =>
      typeof value.metadata?.label === "string"
        ? value.metadata.label
        : undefined,
  } satisfies IntegrationOAuthMethodRegistration
}

export const ClaudeAuthPlugin = Plugin.define({
  id: "griffinmartin.claude-auth",
  setup: async (ctx) => {
    initLogger()
    let accounts: ReturnType<typeof readAllClaudeAccounts> = []
    try {
      accounts = readAllClaudeAccounts()
    } catch (cause) {
      log("plugin_init_error", { cause: String(cause) })
    }
    initAccounts(accounts)

    // Step over an account that is still benched from a rate limit hit in an
    // earlier session, so restarting OpenCode during a usage limit lands on a
    // working account instead of replaying the limit on the first prompt.
    const persisted = loadPersistedAccountSource()
    const initial =
      accounts.length > 0
        ? (chooseInitialAccount(accounts, persisted) ?? accounts[0])
        : undefined
    if (initial) setActiveAccountSource(initial.source)

    await ctx.integration.transform((draft) => {
      draft.update(INTEGRATION_ID, (integration) => {
        integration.name = "Anthropic"
      })
      draft.method.update(oauth(accounts))
      draft.method.update(tokenMethod())
      const stored = listTokenEntries().filter((entry) => entry.addedAt !== 0)
      if (stored.length > 0) draft.method.update(removeTokenMethod(stored))
    })

    // The Anthropic integration keeps its built-in API-key method alongside
    // the subscription methods registered above, so only OAuth usage is free.
    const hasSubscriptionConnection = async (): Promise<boolean> => {
      const connection = await ctx.integration.connection.active(INTEGRATION_ID)
      if (!connection) return false
      const credential = await ctx.integration.connection.resolve(connection)
      return !!credential && isPluginCredential(credential)
    }

    let subscription: boolean = false
    const loadConnection = async () => {
      try {
        subscription = await hasSubscriptionConnection()
      } catch (cause) {
        subscription = false
        log("connection_lookup_failed", { cause: String(cause) })
      }
    }
    await loadConnection()

    await ctx.provider.transform((provider) => {
      const anthropic = provider.get(PROVIDER_ID)
      if (!anthropic) return
      provider.update(PROVIDER_ID, (info) => {
        info.name = "Anthropic"
        info.integrationID = INTEGRATION_ID
      })
      for (const [modelID] of anthropic.models) {
        provider.models.update(PROVIDER_ID, modelID, (model) => {
          if (subscription) model.cost = []
        })
      }
    })

    // Re-evaluate when the user switches credentials so the provider follows
    // the active connection instead of whatever was selected at startup.
    const watcher = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({
        signal: watcher.signal,
      })) {
        if (
          event.type === "credential.updated" ||
          (event.type === "credential.switched" &&
            event.data.integrationID === INTEGRATION_ID)
        ) {
          const before: boolean = subscription
          await loadConnection()
          if (subscription !== before) await ctx.provider.reload()
        }
      }
    })().catch((cause) => {
      if (!watcher.signal.aborted)
        log("connection_watch_failed", { cause: String(cause) })
    })

    for (const kind of IDENTITY_REQUEST_HOOKS)
      await ctx.session.hook(kind, (event) => {
        if (subscription) injectClaudeIdentity(event)
      })

    // OpenCode's native Anthropic provider owns prompt conversion and streaming.
    // These HTTP hooks apply only the Claude Code subscription wire contract.
    // Cross-account rotation on rate limits lives in finishClaudeResponse.
    const requests = new WeakMap<Request, { source?: string }>()
    await ctx.session.hook("http.request", async (event) => {
      if (event.model.providerID !== PROVIDER_ID) return
      const connection = await ctx.integration.connection.active(INTEGRATION_ID)
      if (!connection) return
      const credential = await ctx.integration.connection.resolve(connection)
      if (!credential || !isPluginCredential(credential)) return
      const source =
        typeof credential.metadata?.source === "string"
          ? credential.metadata.source
          : undefined
      event.request = await prepareClaudeRequest(
        event.request,
        credential.access,
        source,
      )
      requests.set(event.request, { source })
    })
    await ctx.session.hook("http.response", async (event) => {
      const context = requests.get(event.request)
      if (!context) return
      requests.delete(event.request)
      event.response = await finishClaudeResponse(
        event.request,
        event.response,
        context.source,
      )
    })

    if (accounts.length === 0) {
      log("plugin_init_no_accounts", { reason: "no credentials found" })
    } else {
      log("plugin_init", {
        accountCount: accounts.length,
        sources: accounts.map((account) => account.source),
        activeSource: initial?.source ?? null,
        pastedTokens: accounts.filter((account) =>
          isTokenSource(account.source),
        ).length,
        cooldowns: activeCooldowns().length,
      })
    }

    return () => {
      watcher.abort()
    }
  },
})

export default ClaudeAuthPlugin
