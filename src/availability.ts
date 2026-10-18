import {
  refreshAccountsList,
  retryAfterCooldownWait,
  type ClaudeAccount,
  type ClaudeCredentials,
} from "./credentials.ts"
import {
  isSyntheticDeadlineAbort,
  sleepUntilStateChange,
  stateRevision,
  throwIfAborted,
} from "./http.ts"
import { log } from "./logger.ts"
import {
  clearWaitAttempt,
  createWaitAttemptId,
  getRotationStatePath,
  getRotationWaitConfig,
  publishWaitAttempt,
  readRotationState,
} from "./rotation.ts"
import { getTokenStorePath } from "./token-store.ts"

interface AvailabilityContext {
  signal?: AbortSignal | null
  invalid: Set<string>
  cycles: number
  elapsedMs: number
  earliestUntil?: number
  earliestLabel?: string
}

type AvailableAccount = {
  account: ClaudeAccount
  credentials: ClaudeCredentials
}
type Deferred = { deferredToOpenCodeRetry: true }

export function availabilityContext(
  signal?: AbortSignal | null,
): AvailabilityContext {
  return { signal, invalid: new Set(), cycles: 0, elapsedMs: 0 }
}

export function isDeferred(
  value: AvailableAccount | Deferred | null,
): value is Deferred {
  return value !== null && "deferredToOpenCodeRetry" in value
}

export function deferredQuotaResponse(context: AvailabilityContext): Response {
  const seconds = Math.max(
    1,
    Math.ceil(
      ((context.earliestUntil ?? Date.now() + 30_000) - Date.now()) / 1000,
    ),
  )
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "rate_limit_error",
        message: `Claude quota: ${seconds}s until next eligible account${context.earliestLabel ? ` (${context.earliestLabel})` : ""}; OpenCode will retry automatically.`,
      },
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(seconds),
      },
    },
  )
}

/** The sole owner of quota waiting, shared by preflight and 429 recovery.
 * Replanning never re-benches an old response or sends an eligibility probe.
 * The persisted roster and cooldowns, not a historical tried set, decide when
 * an account becomes available again. */
export async function acquireAvailableAccount(
  context: AvailabilityContext,
): Promise<AvailableAccount | Deferred | null> {
  const options = getRotationWaitConfig()
  const id = createWaitAttemptId()
  const paths = [getRotationStatePath(), getTokenStorePath()]
  let startedAt: number | undefined
  try {
    for (;;) {
      throwIfAborted(context.signal)
      const revision = stateRevision(paths)
      const now = Date.now()
      const roster = refreshAccountsList().filter(
        (account) => !context.invalid.has(account.source),
      )
      const state = readRotationState()
      if (
        roster.some(
          (account) => !(state.cooldowns[account.source]?.until > now),
        )
      ) {
        const candidate = await retryAfterCooldownWait({
          triedSources: new Set(),
          invalidSources: context.invalid,
          signal: context.signal,
          now,
        })
        throwIfAborted(context.signal)
        if (candidate) {
          if (startedAt !== undefined)
            log("rotation_wait_wake", {
              source: candidate.account.source,
              cycle: context.cycles,
            })
          return candidate
        }
        continue
      }

      const earliest = roster
        .map((account) => ({ account, entry: state.cooldowns[account.source] }))
        .filter((item) => item.entry?.until > now)
        .sort((a, b) => a.entry.until - b.entry.until)[0]
      context.earliestUntil = earliest?.entry.until
      context.earliestLabel = earliest?.account.label
      if (!earliest || !options.enabled) return null
      if (options.maxCycles > 0 && context.cycles >= options.maxCycles)
        return null
      if (
        options.maxWaitTotalMs > 0 &&
        context.elapsedMs >= options.maxWaitTotalMs
      )
        return null
      startedAt ??= now
      context.cycles++
      const deadline =
        earliest.entry.until +
        options.marginMs +
        Math.floor(Math.random() * options.jitterMs)
      const publish = (at: number) =>
        publishWaitAttempt(
          id,
          {
            cycle: context.cycles,
            startedAt: startedAt!,
            plannedSource: earliest.account.source,
            plannedLabel: earliest.account.label,
            until: deadline,
            waitMs: Math.max(0, deadline - at),
          },
          at,
        )
      publish(now)
      log("rotation_wait_start", {
        cycle: context.cycles,
        earliestSource: earliest.account.source,
        earliestAt: earliest.entry.until,
        waitMs: Math.max(0, deadline - now),
      })

      for (;;) {
        const tickAt = Date.now()
        const remaining = deadline - tickAt
        if (remaining <= 0) break
        const budgetLeft =
          options.maxWaitTotalMs > 0
            ? options.maxWaitTotalMs - context.elapsedMs
            : Infinity
        if (budgetLeft <= 0) return null
        try {
          await sleepUntilStateChange(
            Math.min(remaining, options.progressMs || Infinity, budgetLeft),
            context.signal,
            paths,
            revision,
          )
        } finally {
          context.elapsedMs += Math.max(0, Date.now() - tickAt)
        }
        throwIfAborted(context.signal)
        if (stateRevision(paths) !== revision) break
        if (options.progressMs > 0) publish(Date.now())
      }
    }
  } catch (error) {
    if (isSyntheticDeadlineAbort(context.signal)) {
      log("rotation_wait_outer_timeout", {
        cycle: context.cycles,
        elapsedMs: context.elapsedMs,
      })
      return { deferredToOpenCodeRetry: true }
    }
    if (context.signal?.aborted)
      log("rotation_wait_aborted", {
        cycle: context.cycles,
        elapsedMs: context.elapsedMs,
      })
    throw error
  } finally {
    clearWaitAttempt(id)
  }
}
