import crypto from "node:crypto"
import {
  acquireAvailableAccount,
  availabilityContext,
  deferredQuotaResponse,
  isDeferred,
} from "./availability.ts"
import {
  addExcludedBeta,
  getExcludedBetas,
  getModelBetas,
  getNextBetaToExclude,
  isLongContextError,
  LONG_CONTEXT_BETAS,
} from "./betas.ts"
import {
  forceRefreshActiveAccount,
  getAccountBySource,
  getActiveAccount,
  getActiveRefreshFailureKind,
  getCachedCredentials,
  getCredentialsWithBackoff,
  noteAccountSucceeded,
  reloadCredentialsFromSource,
  type ClaudeAccount,
  type ClaudeCredentials,
} from "./credentials.ts"
import {
  fetchWithHeaderDeadline,
  fetchWithRetry,
  throwIfAborted,
} from "./http.ts"
import { log } from "./logger.ts"
import {
  cooldownFromResponse,
  getRotationConfig,
  getRotationWaitConfig,
  isCoolingDown,
  markRateLimited,
} from "./rotation.ts"
import { getUserAgent } from "./model-config.ts"
import { transformBody, transformResponseStream } from "./transforms.ts"

const sessionID = crypto.randomUUID()

// A sticky connection may be preempted before dispatch. The response must be
// attributed to the account actually sent, not the connection's old metadata.
const preparedSources = new WeakMap<Request, string>()

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function buildRequestURL(input: RequestInfo | URL) {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url
  const url = new URL(raw)
  if (url.pathname === "/v1/messages" && !url.searchParams.has("beta"))
    url.searchParams.set("beta", "true")
  return typeof input === "string" ? url.href : url
}

export { fetchWithRetry } from "./http.ts"

export function buildRequestHeaders(
  input: RequestInfo | URL,
  init: RequestInit,
  accessToken: string,
  modelID = "unknown",
  excludedBetas?: Set<string>,
) {
  const headers = new Headers(
    input instanceof Request ? input.headers : undefined,
  )
  new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  const incoming = (headers.get("anthropic-beta") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)

  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("anthropic-version", "2023-06-01")
  headers.set(
    "anthropic-beta",
    [...new Set([...getModelBetas(modelID, excludedBetas), ...incoming])].join(
      ",",
    ),
  )
  headers.set("anthropic-dangerous-direct-browser-access", "true")
  headers.set("x-app", "cli")
  headers.set("user-agent", getUserAgent())
  headers.set("x-client-request-id", crypto.randomUUID())
  headers.set("x-claude-code-session-id", sessionID)
  const stainless = {
    "x-stainless-arch": process.arch === "arm64" ? "arm64" : process.arch,
    "x-stainless-lang": "js",
    "x-stainless-os":
      process.platform === "darwin" ? "MacOS" : process.platform,
    "x-stainless-package-version": "0.81.0",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    "x-stainless-timeout": "600",
  }
  for (const [key, value] of Object.entries(stainless)) {
    if (!headers.has(key)) headers.set(key, value)
  }
  headers.delete("x-api-key")
  return headers
}

/**
 * `source` names the account the credential behind `accessToken` was imported
 * from, as carried in its metadata. Freshness lookups and 401/429 recovery are
 * scoped to that account, so a request is never re-signed with the token of
 * whichever account happens to be process-wide active. Omit it and the active
 * account is used, which is the single-account case.
 */
const resolveAccount = (source?: string): ClaudeAccount | null =>
  source === undefined ? getActiveAccount() : getAccountBySource(source)

function modelFromBody(body: string): string {
  try {
    return (JSON.parse(body) as { model?: string }).model ?? "unknown"
  } catch {
    return "unknown"
  }
}

/** Prepare the native Anthropic request for Claude Code subscription billing. */
export async function prepareClaudeRequest(
  request: Request,
  accessToken: string,
  source?: string,
  executionSignal?: AbortSignal,
): Promise<Request> {
  if (executionSignal)
    request = new Request(request.clone(), {
      signal: AbortSignal.any([request.signal, executionSignal]),
    })
  throwIfAborted(request.signal)
  const body = await request.clone().text()
  const modelID = modelFromBody(body)
  let account = resolveAccount(source)
  // The sticky account may have been benched by another concurrent request.
  // Step to a healthy one before sending anything rather than spending a 429
  // just to trigger rotation.
  if (getRotationConfig().enabled && account && isCoolingDown(account.source)) {
    const eligible = await acquireAvailableAccount(
      availabilityContext(request.signal),
    )
    throwIfAborted(request.signal)
    if (eligible && !isDeferred(eligible)) {
      log("rotation_preempted_bench", {
        modelID,
        from: account.source,
        to: eligible.account.source,
      })
      account = eligible.account
    }
  }
  const credentials =
    (await getCachedCredentials(account)) ??
    (await getCredentialsWithBackoff({ signal: request.signal }, account))
  const token = credentials?.accessToken ?? accessToken
  if (!token)
    throw new Error(
      "Claude subscription credentials are unavailable. Run /connect in OpenCode 2.",
    )
  throwIfAborted(request.signal)
  const prepared = new Request(buildRequestURL(request), {
    method: request.method,
    headers: buildRequestHeaders(
      request,
      {},
      token,
      modelID,
      getExcludedBetas(modelID),
    ),
    body: transformBody(body),
    signal: request.signal,
  })
  const servingSource = account?.source ?? source
  if (servingSource) preparedSources.set(prepared, servingSource)
  return prepared
}

async function sendRequest(request: Request, send: Fetch): Promise<Response> {
  return fetchWithRetry(
    request.url,
    {
      method: request.method,
      headers: request.headers,
      body: await request.clone().text(),
      signal: request.signal,
    },
    3,
    (input, init) => fetchWithHeaderDeadline(input, init, send),
    false,
  )
}

/** Handle subscription recovery after OpenCode sends the first HTTP request. */
export async function finishClaudeResponse(
  request: Request,
  initial: Response,
  source?: string,
  send: Fetch = fetch,
  executionSignal?: AbortSignal,
): Promise<Response> {
  source = preparedSources.get(request) ?? source
  if (executionSignal)
    request = new Request(request.clone(), {
      signal: AbortSignal.any([request.signal, executionSignal]),
    })
  const modelID = modelFromBody(await request.clone().text())
  const account = resolveAccount(source)
  let token =
    request.headers.get("authorization")?.replace(/^Bearer /i, "") ?? ""
  const sendWithToken = (
    currentToken: string,
    excludedBetas = getExcludedBetas(modelID),
  ) => {
    const incoming = new Headers(request.headers)
    incoming.set(
      "anthropic-beta",
      (incoming.get("anthropic-beta") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value && !excludedBetas.has(value))
        .join(","),
    )
    const clean = new Request(request.clone(), { headers: incoming })
    const headers = buildRequestHeaders(
      clean,
      {},
      currentToken,
      modelID,
      excludedBetas,
    )
    return sendRequest(new Request(clean, { headers }), send)
  }

  let response = initial

  // The account that served the response being processed. Rotation moves it
  // forward through the pool; a source is reconsidered only after its bench
  // expires or is cleared by a sibling process.
  let servingSource =
    resolveAccount(source)?.source ??
    (typeof source === "string" ? source : getActiveAccount()?.source)

  for (let attempt = 0; response.status === 401 && attempt < 2; attempt++) {
    let candidate: ClaudeCredentials | null = reloadCredentialsFromSource(
      account?.source,
    )
    if (!candidate || candidate.accessToken === token)
      candidate = await forceRefreshActiveAccount(undefined, account?.source)
    if (!candidate || candidate.accessToken === token) break
    token = candidate.accessToken
    log("auth_recovery_retry", { modelID, attempt: attempt + 1 })
    response = await sendWithToken(token)
  }

  if (response.status === 429) {
    const rotated = reloadCredentialsFromSource(account?.source)
    if (rotated && rotated.accessToken !== token) {
      token = rotated.accessToken
      log("rate_limit_token_changed", { modelID })
      response = await sendWithToken(token)
    } else if (getActiveRefreshFailureKind(account) === "transient") {
      log("fetch_credentials_transient_exhausted", { modelID })
    }
  }

  // Cross-account rotation: a 429 that survived the same-account resync means
  // this account is rate-limited. Bench it with a cooldown derived from the
  // response and retry on the next eligible account in the pool. When every
  // account is benched or tried, wait out the soonest bench instead of
  // failing — a real chunked sleep, abort-aware, published for quota-watch —
  // then re-evaluate the pool from fresh persisted state. Long-context 429s
  // skip rotation entirely: the 1M-window limit applies to every account
  // equally, and the beta-exclusion loop below is their remedy.
  if (response.status === 429 && servingSource && getRotationConfig().enabled) {
    const rotationConfig = getRotationConfig()
    const waitConfig = getRotationWaitConfig()
    const availability = availabilityContext(request.signal)
    let switches = 0
    while (response.status === 429) {
      throwIfAborted(request.signal)
      let limitBody = ""
      try {
        limitBody = await response.clone().text()
      } catch {
        // An unreadable body is not a reason to skip rotation.
      }
      if (isLongContextError(limitBody)) {
        log("rotation_skipped_long_context", { modelID })
        break
      }
      const { ms, reason } = cooldownFromResponse(
        response.headers,
        limitBody,
        rotationConfig,
      )
      markRateLimited(servingSource, ms, reason)
      // Automatic mode must visit the whole pool. The legacy switch cap only
      // bounds explicit fail-fast mode, as in the ou4 implementation.
      if (
        !waitConfig.enabled &&
        switches >= rotationConfig.maxSwitchesPerRequest
      )
        break
      const rotated = await acquireAvailableAccount(availability)
      if (isDeferred(rotated)) {
        void response.body?.cancel().catch(() => {})
        response = deferredQuotaResponse(availability)
        break
      }
      throwIfAborted(request.signal)
      if (!rotated) break
      void response.body?.cancel().catch(() => {})
      servingSource = rotated.account.source
      token = rotated.credentials.accessToken
      log("rotation_retry", {
        modelID,
        source: servingSource,
        rotation: ++switches,
      })
      response = await sendWithToken(token)
    }
  }

  for (let attempt = 0; attempt < LONG_CONTEXT_BETAS.length; attempt++) {
    if (response.status !== 400 && response.status !== 429) break
    if (!isLongContextError(await response.clone().text())) break
    const beta = getNextBetaToExclude(modelID)
    if (!beta) break
    addExcludedBeta(modelID, beta)
    response = await sendWithToken(token, getExcludedBetas(modelID))
  }

  // A success clears the serving account's bench, so an account whose limit
  // reset earlier than its recorded cooldown stops being skipped as soon as
  // it proves itself.
  if (response.ok && servingSource) noteAccountSucceeded(servingSource)

  if (!response.ok)
    log("fetch_error_response", { status: response.status, modelID })
  return response.status === 401 ? response : transformResponseStream(response)
}

/** Standalone transport used by existing integration checks. */
export function claudeSubscriptionFetch(
  accessToken: string,
  upstream?: Fetch,
  source?: string,
): Fetch {
  const send = upstream ?? fetch
  return async (input, init = {}) => {
    const request = new Request(input, init)
    const prepared = await prepareClaudeRequest(request, accessToken, source)
    const response = await sendRequest(prepared, send)
    return finishClaudeResponse(prepared, response, source, send)
  }
}
