import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"

const script = fileURLToPath(new URL("./quota-watch.mjs", import.meta.url))

describe("quota-watch", () => {
  it("shows concurrent waits, stale requests, and no token material", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-quota-watch-"))
    const data = join(root, "data", "opencode")
    const waits = join(data, "claude-auth-waits")
    mkdirSync(waits, { recursive: true })
    const now = Date.now()
    writeFileSync(
      join(data, "claude-auth-rotation.json"),
      JSON.stringify({
        version: 1,
        cooldowns: { "token:abcd1234": { until: now + 100_000 } },
      }),
    )
    writeFileSync(
      join(data, "claude-auth-tokens.json"),
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: "abcd1234",
            label: "Account A",
            token: "sk-ant-oat01-FAKESECRETNEVERPRINT",
          },
        ],
      }),
    )
    writeFileSync(join(data, "claude-account-source.txt"), "token:abcd1234")
    for (const [id, updatedAt] of [
      ["1-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", now],
      ["2-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", now - 600_000],
    ] as const) {
      writeFileSync(
        join(waits, `${id}.json`),
        JSON.stringify({
          version: 1,
          active: {
            plannedSource: "token:abcd1234",
            plannedLabel: "Account A",
            updatedAt,
            until: now + 100_000,
            cycle: 1,
          },
        }),
      )
    }
    const result = execFileSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, XDG_DATA_HOME: join(root, "data") },
    })
    assert.match(result, /2 in-flight quota waits/)
    assert.match(result, /STALE/)
    assert.match(result, /Account A/)
    assert.doesNotMatch(result, /FAKESECRETNEVERPRINT/)
  })
})
