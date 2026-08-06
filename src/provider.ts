import crypto from "node:crypto"
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
  rotateAfterRateLimit,
  type ClaudeAccount,
  type ClaudeCredentials,
} from "./credentials.ts"
import { fetchWithRetry } from "./http.ts"
import { log } from "./logger.ts"
import { getRotationConfig } from "./rotation.ts"
import { getUserAgent } from "./model-config.ts"
import { transformBody, transformResponseStream } from "./transforms.ts"

const sessionID = crypto.randomUUID()

/**
 * Upper bound on cross-account rotations per response. Accounts benched by an
 * earlier rotation in this same response are skipped via `triedSources`, so
 * the pool size is the natural limit; this constant only guards against a
 * pathological re-rate-limit loop.
 */
const MAX_ROTATIONS = 8

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
): Promise<Request> {
  const body = await request.clone().text()
  const modelID = modelFromBody(body)
  const account = resolveAccount(source)
  const credentials =
    (await getCachedCredentials(account)) ??
    (await getCredentialsWithBackoff({}, account))
  const token = credentials?.accessToken ?? accessToken
  if (!token)
    throw new Error(
      "Claude subscription credentials are unavailable. Run /connect in OpenCode 2.",
    )
  return new Request(buildRequestURL(request), {
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
    send,
  )
}

/** Handle subscription recovery after OpenCode sends the first HTTP request. */
export async function finishClaudeResponse(
  request: Request,
  initial: Response,
  source?: string,
  send: Fetch = fetch,
): Promise<Response> {
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
  // forward through the pool; accounts already tried for this response are
  // never revisited.
  let servingSource =
    resolveAccount(source)?.source ??
    (typeof source === "string" ? source : getActiveAccount()?.source)
  const triedSources = new Set<string>()
  if (servingSource) triedSources.add(servingSource)

  for (let attempt = 0; response.status === 401 && attempt < 2; attempt++) {
    let candidate: ClaudeCredentials | null =
      reloadCredentialsFromSource(account)
    if (!candidate || candidate.accessToken === token)
      candidate = await forceRefreshActiveAccount(undefined, account)
    if (!candidate || candidate.accessToken === token) break
    token = candidate.accessToken
    log("auth_recovery_retry", { modelID, attempt: attempt + 1 })
    response = await sendWithToken(token)
  }

  if (response.status === 429) {
    const rotated = reloadCredentialsFromSource(account)
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
  // response and retry on the next eligible account in the pool. Long-context
  // 429s skip rotation — the 1M-window limit applies to every account
  // equally, and the beta-exclusion loop below is their remedy.
  if (response.status === 429 && servingSource && getRotationConfig().enabled) {
    for (
      let rotation = 0;
      rotation < MAX_ROTATIONS && response.status === 429;
      rotation++
    ) {
      const body = await response.clone().text()
      if (isLongContextError(body)) break
      const rotated = await rotateAfterRateLimit({
        limitedSource: servingSource,
        headers: response.headers,
        body,
        triedSources,
      })
      if (!rotated) break
      servingSource = rotated.account.source
      triedSources.add(servingSource)
      token = rotated.credentials.accessToken
      log("rotation_retry", {
        modelID,
        source: servingSource,
        rotation: rotation + 1,
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
