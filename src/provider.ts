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
  retryAfterCooldownWait,
  rotateAfterRateLimit,
  type ClaudeAccount,
  type ClaudeCredentials,
} from "./credentials.ts"
import { fetchWithRetry, sleepUntilStateChange, stateRevision } from "./http.ts"
import { log } from "./logger.ts"
import {
  clearWaitAttempt,
  createWaitAttemptId,
  earliestCooldown,
  getRotationConfig,
  getRotationStatePath,
  getRotationWaitConfig,
  isCoolingDown,
  publishWaitAttempt,
} from "./rotation.ts"
import { getTokenStorePath } from "./token-store.ts"
import { getUserAgent } from "./model-config.ts"
import { transformBody, transformResponseStream } from "./transforms.ts"

const sessionID = crypto.randomUUID()

/** Files whose change means a sleeping quota wait should re-plan early. */
const availabilityPaths = () => [getRotationStatePath(), getTokenStorePath()]
/** Chunked wait sleep that wakes early when the local pool state changes. */
const availabilitySleep = (
  ms: number,
  signal: AbortSignal | null | undefined,
) => sleepUntilStateChange(ms, signal, availabilityPaths(), stateRevision(availabilityPaths()))

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
  let account = resolveAccount(source)
  // The sticky account may have been benched by another concurrent request.
  // Step to a healthy one before sending anything rather than spending a 429
  // just to trigger rotation.
  if (
    getRotationConfig().enabled &&
    account &&
    isCoolingDown(account.source)
  ) {
    const eligible = await retryAfterCooldownWait({
      triedSources: new Set<string>([account.source]),
    })
    if (eligible) {
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
      reloadCredentialsFromSource(account?.source)
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
    const waitId = createWaitAttemptId()
    const startedAt = Date.now()
    let waitCycles = 0
    let waitedMs = 0

    rotation: for (;;) {
      let outOfCandidates = false

      for (
        let switchCount = 0;
        switchCount < rotationConfig.maxSwitchesPerRequest;
        switchCount++
      ) {
        if (response.status !== 429) break

        // The body both excludes long-context errors and tells an explained
        // usage limit from a bare 429. Cloned, so the response stays readable
        // if it ends up returned.
        let limitBody = ""
        try {
          limitBody = await response.clone().text()
        } catch {
          // An unreadable body is not a reason to skip rotation.
        }
        if (isLongContextError(limitBody)) {
          log("rotation_skipped_long_context", { modelID })
          break rotation
        }
        const limitedSource = servingSource
        if (!limitedSource) break rotation

        const rotated = await rotateAfterRateLimit({
          limitedSource,
          headers: response.headers,
          body: limitBody,
          triedSources,
        })
        if (!rotated) {
          outOfCandidates = true
          break
        }
        servingSource = rotated.account.source
        triedSources.add(servingSource)
        token = rotated.credentials.accessToken
        log("rotation_retry", {
          modelID,
          source: servingSource,
          rotation: switchCount + 1,
        })
        response = await sendWithToken(token)
      }

      if (response.status !== 429) break
      if (!outOfCandidates) break
      // The switch budget ran out with candidates left — a call-count bound,
      // not a depleted pool — or waiting is disabled; either way no
      // self-imposed sleep.
      if (!waitConfig.enabled) break

      // ----- all accounts benched, tried, or broken: the wait -----
      const earliest = earliestCooldown()
      if (!earliest) break // nobody benched: candidates failed credential validation, not quota
      if (waitConfig.maxCycles > 0 && waitCycles >= waitConfig.maxCycles) {
        log("rotation_wait_budget_exceeded", {
          modelID,
          budget: "cycles",
          maxCycles: waitConfig.maxCycles,
          waitedMs,
        })
        break
      }
      let waitMs = Math.max(
        0,
        earliest.until - Date.now() + waitConfig.marginMs,
      )
      waitMs += Math.floor(Math.random() * waitConfig.jitterMs)
      if (
        waitConfig.maxWaitTotalMs > 0 &&
        waitedMs + waitMs > waitConfig.maxWaitTotalMs
      ) {
        log("rotation_wait_budget_exceeded", {
          modelID,
          budget: "total_ms",
          maxWaitTotalMs: waitConfig.maxWaitTotalMs,
          waitedMs,
        })
        break
      }
      waitCycles += 1
      waitedMs += waitMs
      log("rotation_wait_start", {
        modelID,
        cycle: waitCycles,
        earliestSource: earliest.source,
        earliestAt: earliest.until,
        waitMs,
      })

      // Publish the wait so quota-watch shows a live countdown; refreshed at
      // every chunk boundary and deleted on end/abort, so a lingering stale
      // entry only ever means "the holding request died".
      const wakeDeadline = Date.now() + waitMs
      const signal = request.signal ?? undefined
      const publish = (leftMs: number) =>
        publishWaitAttempt(waitId, {
          cycle: waitCycles,
          startedAt,
          plannedSource: earliest.source,
          plannedLabel:
            getAccountBySource(earliest.source)?.label ?? earliest.source,
          until: wakeDeadline,
          waitMs: leftMs,
        })
      publish(waitMs)

      let aborted = false
      try {
        for (;;) {
          const remainingMs = wakeDeadline - Date.now()
          if (remainingMs <= 0) break
          const chunkMs =
            waitConfig.progressMs > 0
              ? Math.min(waitConfig.progressMs, remainingMs)
              : remainingMs
          await availabilitySleep(chunkMs, signal)
          if (signal?.aborted) {
            aborted = true
            break
          }
          if (waitConfig.progressMs <= 0) break
          const leftMs = wakeDeadline - Date.now()
          if (leftMs <= 0) break
          publish(leftMs)
        }
      } finally {
        clearWaitAttempt(waitId)
      }
      if (aborted) {
        // The turn was cancelled mid-wait: surface the limit we were holding
        // rather than firing one more request nobody reads.
        log("rotation_wait_aborted", { modelID, cycle: waitCycles, waitedMs })
        break
      }
      log("rotation_wait_wake", {
        modelID,
        cycle: waitCycles,
        plannedSource: earliest.source,
      })

      // Never assume the planned account is healthy: benches may have been
      // extended or cleared by sibling instances while we slept, so selection
      // starts from fresh persisted state.
      const woke = await retryAfterCooldownWait({
        triedSources,
        signal: request.signal ?? undefined,
      })
      if (!woke) continue // recompute the earliest bench and sleep again
      servingSource = woke.account.source
      triedSources.add(servingSource)
      token = woke.credentials.accessToken
      log("rotation_wake_retry", { modelID, source: servingSource })
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
