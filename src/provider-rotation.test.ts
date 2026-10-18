import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { afterEach, beforeEach, describe, it } from "node:test"
import { initAccounts, refreshAccountsList } from "./credentials.ts"
import {
  claudeSubscriptionFetch,
  finishClaudeResponse,
  prepareClaudeRequest,
} from "./provider.ts"
import {
  clearCooldown,
  isCoolingDown,
  markRateLimited,
  readRotationState,
  readWaitAttempts,
} from "./rotation.ts"
import { addTokens, tokenIdFor } from "./token-store.ts"

const tokens = ["A", "B", "C", "D", "E"].map(
  (letter) => `sk-ant-oat01-${letter.repeat(24)}`,
)
const source = (index: number) => `token:${tokenIdFor(tokens[index])}`
const request = (signal?: AbortSignal) =>
  new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }),
    signal,
  })
const limited = (retryAfter = "1") =>
  new Response('{"error":{"type":"rate_limit_error"}}', {
    status: 429,
    headers: { "retry-after": retryAfter },
  })

async function until(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "condition did not become true in time")
    await sleep(5)
  }
}

describe("OpenCode 2 rotation and quota-continuation transport", () => {
  let savedEnv: NodeJS.ProcessEnv
  let root: string
  let realFetch: typeof fetch

  beforeEach(() => {
    savedEnv = { ...process.env }
    root = mkdtempSync(join(tmpdir(), "claude-provider-rotation-"))
    for (const key of Object.keys(process.env))
      if (
        key.startsWith("OPENCODE_CLAUDE_AUTH_") ||
        key === "CLAUDE_CODE_OAUTH_TOKEN"
      )
        delete process.env[key]
    Object.assign(process.env, {
      HOME: root,
      CLAUDE_CONFIG_DIR: join(root, ".claude"),
      CLAUDE_AUTH_DEBUG: "0",
      OPENCODE_CLAUDE_AUTH_TOKENS_FILE: join(root, "tokens.json"),
      OPENCODE_CLAUDE_AUTH_ROTATION_FILE: join(root, "rotation.json"),
      OPENCODE_CLAUDE_AUTH_WAIT_DIR: join(root, "waits"),
      OPENCODE_CLAUDE_AUTH_ROTATE_MAX_COOLDOWN_MS: "80",
      OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MARGIN_MS: "1",
      OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_JITTER_MS: "1",
      OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_PROGRESS_MS: "10",
      OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MAX_CYCLES: "4",
      OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS: "1",
    })
    initAccounts([])
    realFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error("test must not make a real network or OAuth request")
    }) as typeof fetch
  })

  afterEach(() => {
    initAccounts([])
    globalThis.fetch = realFetch
    for (const key of Object.keys(process.env))
      if (!(key in savedEnv)) delete process.env[key]
    Object.assign(process.env, savedEnv)
    rmSync(root, { recursive: true, force: true })
  })

  function pool(count: number) {
    addTokens(tokens.slice(0, count), "Fixture")
    initAccounts(refreshAccountsList())
  }

  it("rotates A -> B -> C once each and resends the identical body", async () => {
    pool(3)
    process.env.OPENCODE_CLAUDE_AUTH_ROTATE_MAX_COOLDOWN_MS = "5000"
    const auth: string[] = []
    const bodies: string[] = []
    const response = await claudeSubscriptionFetch(
      tokens[0],
      async (_input, init) => {
        auth.push(new Headers(init?.headers).get("authorization")!)
        bodies.push(String(init?.body))
        return auth.length < 3 ? limited() : new Response("ok")
      },
      source(0),
    )(request())
    assert.equal(response.status, 200)
    assert.deepEqual(
      auth,
      tokens.slice(0, 3).map((t) => `Bearer ${t}`),
    )
    assert.equal(new Set(bodies).size, 1)
    assert.equal(isCoolingDown(source(0)), true)
    assert.equal(isCoolingDown(source(1)), true)
    assert.equal(isCoolingDown(source(2)), false)
  })

  it("routes short/zero Retry-After 429s directly to rotation, not same-account retries", async () => {
    pool(3)
    const auth: string[] = []
    const response = await claudeSubscriptionFetch(
      tokens[0],
      async (_input, init) => {
        auth.push(new Headers(init?.headers).get("authorization")!)
        return auth.length < 3 ? limited("0") : new Response("ok")
      },
      source(0),
    )(request())
    assert.equal(response.status, 200)
    assert.deepEqual(
      auth,
      tokens.slice(0, 3).map((t) => `Bearer ${t}`),
    )
  })

  it("keeps the original account benched after a preemptive switch succeeds", async () => {
    pool(2)
    markRateLimited(source(0), 5_000, "retry-after")
    let auth = ""
    await claudeSubscriptionFetch(
      tokens[0],
      async (_input, init) => {
        auth = new Headers(init?.headers).get("authorization")!
        return new Response("ok")
      },
      source(0),
    )(request())
    assert.equal(auth, `Bearer ${tokens[1]}`)
    assert.equal(
      isCoolingDown(source(0)),
      true,
      "B's success must not clear A's bench",
    )
  })

  it("attributes a preempted request's 429 to the account actually sent", async () => {
    pool(3)
    process.env.OPENCODE_CLAUDE_AUTH_ROTATE_MAX_COOLDOWN_MS = "5000"
    markRateLimited(source(0), 5_000, "retry-after")
    const auth: string[] = []
    const response = await claudeSubscriptionFetch(
      tokens[0],
      async (_input, init) => {
        auth.push(new Headers(init?.headers).get("authorization")!)
        return auth.length === 1 ? limited() : new Response("ok")
      },
      source(0),
    )(request())
    assert.equal(response.status, 200)
    assert.deepEqual(
      auth,
      [tokens[1], tokens[2]].map((t) => `Bearer ${t}`),
    )
    assert.equal(isCoolingDown(source(0)), true)
    assert.equal(isCoolingDown(source(1)), true)
  })

  it("waits out a single-account cooldown and retries it rather than re-benching a stale 429", async () => {
    pool(1)
    let calls = 0
    const response = await claudeSubscriptionFetch(
      tokens[0],
      async () => (++calls === 1 ? limited() : new Response("recovered")),
      source(0),
    )(request())
    assert.equal(response.status, 200)
    assert.equal(calls, 2)
    assert.equal(await response.text(), "recovered")
    assert.deepEqual(readWaitAttempts(), [])
    assert.equal(isCoolingDown(source(0)), false)
  })

  it("waits before the first network request when every account is already benched", async () => {
    pool(1)
    markRateLimited(source(0), 80, "retry-after")
    let sentWhileBenched = false
    const response = await claudeSubscriptionFetch(
      tokens[0],
      async () => {
        sentWhileBenched = isCoolingDown(source(0))
        return new Response("ok")
      },
      source(0),
    )(request())
    assert.equal(response.status, 200)
    assert.equal(sentWhileBenched, false)
  })

  for (const progress of ["10", "0"]) {
    it(`wakes immediately when a sibling clears the bench (progress=${progress})`, async () => {
      pool(1)
      process.env.OPENCODE_CLAUDE_AUTH_ROTATE_MAX_COOLDOWN_MS = "5000"
      process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_PROGRESS_MS = progress
      const controller = new AbortController()
      const timer = setTimeout(
        () => controller.abort(new Error("wake test timed out")),
        700,
      )
      const prepared = await prepareClaudeRequest(
        request(controller.signal),
        tokens[0],
        source(0),
      )
      const pending = finishClaudeResponse(
        prepared,
        limited("5"),
        source(0),
        async () => new Response("ok"),
      )
      // Attach immediately: cancellation must never produce an unhandled rejection.
      const settled = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      try {
        await until(() => readWaitAttempts().length === 1)
        clearCooldown(source(0))
        const result = await settled
        assert.ok(
          "value" in result,
          String("error" in result ? result.error : ""),
        )
        assert.equal(result.value.status, 200)
        assert.deepEqual(readWaitAttempts(), [])
      } finally {
        clearTimeout(timer)
        controller.abort()
        await settled
      }
    })
  }

  it("discovers a new pasted token while already waiting, without a restart", async () => {
    pool(1)
    process.env.OPENCODE_CLAUDE_AUTH_ROTATE_MAX_COOLDOWN_MS = "5000"
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error("new-token wake timed out")),
      700,
    )
    const auth: string[] = []
    const prepared = await prepareClaudeRequest(
      request(controller.signal),
      tokens[0],
      source(0),
    )
    const pending = finishClaudeResponse(
      prepared,
      limited("5"),
      source(0),
      async (_input, init) => {
        auth.push(new Headers(init?.headers).get("authorization")!)
        return new Response("ok")
      },
    )
    const settled = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    try {
      await until(() => readWaitAttempts().length === 1)
      addTokens([tokens[1]], "New account")
      const result = await settled
      assert.ok(
        "value" in result,
        String("error" in result ? result.error : ""),
      )
      assert.equal(result.value.status, 200)
      assert.deepEqual(auth, [`Bearer ${tokens[1]}`])
    } finally {
      clearTimeout(timer)
      controller.abort()
      await settled
    }
  })

  it("keeps concurrent countdowns independent and cleans each on cancellation", async () => {
    pool(1)
    process.env.OPENCODE_CLAUDE_AUTH_ROTATE_MAX_COOLDOWN_MS = "5000"
    const controllers = [new AbortController(), new AbortController()]
    const prepared = await Promise.all(
      controllers.map((c) =>
        prepareClaudeRequest(request(c.signal), tokens[0], source(0)),
      ),
    )
    const settled = prepared.map((req) =>
      finishClaudeResponse(req, limited("5"), source(0)).then(
        () => "returned",
        () => "aborted",
      ),
    )
    try {
      await until(() => readWaitAttempts().length === 2)
      controllers[0].abort()
      assert.equal(await settled[0], "aborted")
      assert.equal(readWaitAttempts().length, 1)
      controllers[1].abort()
      assert.equal(await settled[1], "aborted")
      assert.deepEqual(readWaitAttempts(), [])
    } finally {
      controllers.forEach((c) => c.abort())
      await Promise.all(settled)
    }
  })

  it("turns a host header deadline during a wait into an accurate deferred 429", async () => {
    pool(1)
    process.env.OPENCODE_CLAUDE_AUTH_ROTATE_MAX_COOLDOWN_MS = "5000"
    const controller = new AbortController()
    const prepared = await prepareClaudeRequest(
      request(controller.signal),
      tokens[0],
      source(0),
    )
    const pending = finishClaudeResponse(prepared, limited("600"), source(0))
    const settled = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    try {
      await until(() => readWaitAttempts().length === 1)
      controller.abort(new DOMException("HeaderTimeout", "HeaderTimeoutError"))
      const result = await settled
      assert.ok(
        "value" in result,
        String("error" in result ? result.error : ""),
      )
      assert.equal(result.value.status, 429)
      assert.ok(Number(result.value.headers.get("retry-after")) <= 5)
      assert.match(await result.value.text(), /retry automatically/i)
      assert.deepEqual(readWaitAttempts(), [])
    } finally {
      controller.abort()
      await settled
    }
  })

  it("uses the wait budget as a bounded real wait, without sending probes", async () => {
    pool(1)
    process.env.OPENCODE_CLAUDE_AUTH_ROTATE_MAX_COOLDOWN_MS = "5000"
    process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MAX_MS = "60"
    const prepared = await prepareClaudeRequest(request(), tokens[0], source(0))
    let calls = 0
    const started = performance.now()
    const response = await finishClaudeResponse(
      prepared,
      limited("5"),
      source(0),
      async () => {
        calls++
        return new Response("must not probe")
      },
    )
    assert.equal(response.status, 429)
    assert.equal(calls, 0)
    assert.ok(
      performance.now() - started >= 40,
      "the wait budget must not fail immediately",
    )
    assert.ok(performance.now() - started < 600)
    assert.deepEqual(readWaitAttempts(), [])
  })

  it("automatic continuation visits the entire pool, not only the legacy switch cap", async () => {
    pool(5)
    process.env.OPENCODE_CLAUDE_AUTH_ROTATE_MAX_SWITCHES = "1"
    let calls = 0
    const response = await claudeSubscriptionFetch(
      tokens[0],
      async () => (++calls < 5 ? limited() : new Response("ok")),
      source(0),
    )(request())
    assert.equal(response.status, 200)
    assert.equal(calls, 5)
  })

  it("fail-fast mode honors the switch cap and records the last failed account", async () => {
    pool(3)
    process.env.OPENCODE_CLAUDE_AUTH_ROTATE_MAX_COOLDOWN_MS = "5000"
    process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT = "0"
    process.env.OPENCODE_CLAUDE_AUTH_ROTATE_MAX_SWITCHES = "1"
    let calls = 0
    const response = await claudeSubscriptionFetch(
      tokens[0],
      async () => {
        calls++
        return limited()
      },
      source(0),
    )(request())
    assert.equal(response.status, 429)
    assert.equal(calls, 2)
    assert.equal(isCoolingDown(source(0)), true)
    assert.equal(isCoolingDown(source(1)), true)
    assert.deepEqual(readWaitAttempts(), [])
  })

  it("rotation opt-out neither switches accounts nor writes cooldowns", async () => {
    pool(2)
    process.env.OPENCODE_CLAUDE_AUTH_ROTATE = "0"
    let calls = 0
    const response = await claudeSubscriptionFetch(
      tokens[0],
      async () => {
        calls++
        return limited()
      },
      source(0),
    )(request())
    assert.equal(response.status, 429)
    assert.equal(calls, 1)
    assert.deepEqual(readRotationState().cooldowns, {})
  })

  it("keeps long-context 429 recovery on the same account without benching it", async () => {
    pool(2)
    const auth: string[] = []
    const response = await claudeSubscriptionFetch(
      tokens[0],
      async (_input, init) => {
        auth.push(new Headers(init?.headers).get("authorization")!)
        return auth.length === 1
          ? new Response("long context beta is not yet available", {
              status: 429,
            })
          : new Response("ok")
      },
      source(0),
    )(request())
    assert.equal(response.status, 200)
    assert.deepEqual(auth, [`Bearer ${tokens[0]}`, `Bearer ${tokens[0]}`])
    assert.deepEqual(readRotationState().cooldowns, {})
  })

  it("persists only fixture account sources, never bearer tokens, in quota state", async () => {
    pool(2)
    let calls = 0
    await claudeSubscriptionFetch(
      tokens[0],
      async () => (++calls === 1 ? limited() : new Response("ok")),
      source(0),
    )(request())
    assert.doesNotMatch(
      readFileSync(join(root, "rotation.json"), "utf8"),
      /sk-ant-/,
    )
  })
})
