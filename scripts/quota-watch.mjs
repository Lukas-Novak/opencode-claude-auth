#!/usr/bin/env node
// Read-only quota countdown. Never reads or prints OAuth token values.
import { readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const dataDir = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
  "opencode",
)
const rotationPath =
  process.env.OPENCODE_CLAUDE_AUTH_ROTATION_FILE ??
  join(dataDir, "claude-auth-rotation.json")
const tokenPath =
  process.env.OPENCODE_CLAUDE_AUTH_TOKENS_FILE ??
  join(dataDir, "claude-auth-tokens.json")
const waitDir =
  process.env.OPENCODE_CLAUDE_AUTH_WAIT_DIR ??
  join(dirname(rotationPath), "claude-auth-waits")
const activePath = join(dataDir, "claude-account-source.txt")
const rawProgress = Number(
  process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_PROGRESS_MS,
)
const progressMs =
  Number.isFinite(rawProgress) && rawProgress > 0 ? rawProgress : 60_000
const staleMs = Math.max(90_000, 2 * progressMs + 30_000)

function read(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return fallback
  }
}

function countdown(ms) {
  if (ms <= 0) return "eligible now"
  const seconds = Math.ceil(ms / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
}

function waits() {
  try {
    return readdirSync(waitDir)
      .filter((name) => /^[0-9a-f-]+\.json$/.test(name))
      .flatMap((name) => {
        const state = read(join(waitDir, name), null)
        return state?.version === 1 &&
          Number.isFinite(state?.active?.updatedAt) &&
          Number.isFinite(state?.active?.until)
          ? [state.active]
          : []
      })
  } catch {
    return []
  }
}

function display() {
  const now = Date.now()
  const tokens = read(tokenPath, { accounts: [] }).accounts ?? []
  const labels = new Map(
    tokens.map((entry) => [
      `token:${entry.id}`,
      entry.label ?? `token:${entry.id}`,
    ]),
  )
  const cooldowns = read(rotationPath, { cooldowns: {} }).cooldowns ?? {}
  let active = null
  try {
    active = readFileSync(activePath, "utf8").trim()
  } catch {
    /* no active source */
  }
  const sources = new Set([...labels.keys(), ...Object.keys(cooldowns)])
  if (active) sources.add(active)
  const lines = [
    `Claude quota · ${new Date(now).toLocaleString()} · * = persisted preference (running sessions may differ)`,
  ]
  if (sources.size === 0)
    lines.push("No Claude accounts found in this state directory.")
  for (const source of sources) {
    const end = cooldowns[source]?.until ?? 0
    lines.push(
      `${source === active ? "*" : " "} ${labels.get(source) ?? source}: ${countdown(end - now)}`,
    )
  }
  const pending = waits()
  if (pending.length === 0) {
    lines.push(
      "No published wait. Older running servers may wait without reporting it; benches alone do not schedule a retry.",
    )
  } else {
    lines.push(
      `${pending.length} in-flight quota wait${pending.length === 1 ? "" : "s"}:`,
    )
    for (const item of pending.sort((a, b) => a.until - b.until)) {
      const stale = now - item.updatedAt > staleMs
      lines.push(
        `  ${item.plannedLabel ?? item.plannedSource}: ${stale ? "STALE (request may have ended)" : countdown(item.until - now)} · cycle ${item.cycle}`,
      )
    }
  }
  return lines.join("\n")
}

if (process.argv.includes("--watch")) {
  const paint = () => {
    if (process.stdout.isTTY) process.stdout.write("\x1b[H\x1b[J")
    process.stdout.write(display() + "\n")
  }
  paint()
  setInterval(paint, 1000)
} else {
  process.stdout.write(display() + "\n")
}
