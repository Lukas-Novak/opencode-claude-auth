import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import {
  clearCooldown,
  markRateLimited,
  readRotationState,
} from "./rotation.ts"

const now = 1_800_000_000_000

describe("ou4 cooldown-policy parity", () => {
  let root: string
  let env: NodeJS.ProcessEnv
  beforeEach(() => {
    env = { ...process.env }
    root = mkdtempSync(join(tmpdir(), "rotation-policy-parity-"))
    process.env.OPENCODE_CLAUDE_AUTH_ROTATION_FILE = join(root, "rotation.json")
    process.env.OPENCODE_CLAUDE_AUTH_ROTATE_MAX_COOLDOWN_MS = "21600000"
  })
  afterEach(() => {
    for (const key of Object.keys(process.env))
      if (!(key in env)) delete process.env[key]
    Object.assign(process.env, env)
    rmSync(root, { recursive: true, force: true })
  })

  for (const reason of ["unspecified-429", "usage-limit-body"]) {
    it(`escalates repeated ${reason} cooldowns instead of retrying on a fixed metronome`, () => {
      assert.equal(
        markRateLimited("A", 60_000, reason, now, () => 1),
        now + 60_000,
      )
      assert.equal(
        markRateLimited("A", 60_000, reason, now + 1, () => 1),
        now + 1 + 120_000,
      )
      assert.equal(
        markRateLimited("A", 60_000, reason, now + 2, () => 1),
        now + 2 + 240_000,
      )
      assert.equal(readRotationState().cooldowns.A.unspecifiedCount, 3)
    })
  }

  it("caps escalation at the configured maximum", () => {
    process.env.OPENCODE_CLAUDE_AUTH_ROTATE_MAX_COOLDOWN_MS = "90000"
    markRateLimited("A", 60_000, "unspecified-429", now)
    assert.equal(
      markRateLimited("A", 60_000, "unspecified-429", now + 1, () => 1),
      now + 1 + 90_000,
    )
  })

  it("resets escalation after an authoritative reset or a successful request", () => {
    markRateLimited("A", 60_000, "unspecified-429", now)
    markRateLimited("A", 3_600_000, "retry-after", now + 1)
    assert.equal(readRotationState().cooldowns.A.unspecifiedCount, undefined)
    markRateLimited("A", 60_000, "unspecified-429", now + 3_700_000)
    assert.equal(readRotationState().cooldowns.A.unspecifiedCount, 1)
    clearCooldown("A")
    markRateLimited("A", 60_000, "unspecified-429", now + 3_800_000)
    assert.equal(readRotationState().cooldowns.A.unspecifiedCount, 1)
  })

  it("never shortens an existing authoritative bench", () => {
    markRateLimited("A", 3_600_000, "retry-after", now)
    assert.equal(
      markRateLimited("A", 60_000, "unspecified-429", now + 1),
      now + 3_600_000,
    )
    assert.equal(readRotationState().cooldowns.A.reason, "retry-after")
  })
})
