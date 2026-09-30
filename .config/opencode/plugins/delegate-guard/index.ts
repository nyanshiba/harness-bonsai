import { Plugin } from "@opencode-ai/plugin"
import { statSync, readFileSync } from "node:fs"

// Large-read guard: shunt heavy reads to /bulk-read delegation.
//
// Origin: Spotify "shunt" pattern (Portal by Spotify, Sep 2026) — advisory
// rules in instruction files get ignored, so routing is enforced at the
// permission layer instead of requested in prose. Threshold mirrors shunt's
// SHUNT_MIN_LINES (default 350): below it, delegation round-trips cost more
// than they save.
//
// Mechanism: permission "evaluate" hook. Explicit "deny" is final and never
// reaches hooks. Large reads are denied (not asked): ask stalls on rejection,
// while deny lets the agent reroute to bulk-reader by itself. Targeted
// re-reads (offset/limit) are denied as well by design — the file size is
// what matters, not the requested range. Exempted readers below are the only
// ones that may read large files directly.
//
// Limitation: shell-based reads (cat/head/tail) are raw command text and are
// intentionally not parsed. Only the read tool is guarded.
const MIN_LINES = Number(process.env.SHUNT_MIN_LINES ?? 350)

// bulk-reader is the delegation target itself; build-auto runs without
// approvals; explorer and general have no subagent delegation path, so
// blocking them would leave no lawful way to read large files.
const EXEMPT_AGENTS = new Set(["bulk-reader", "build-auto", "explorer", "general"])

function lineCount(path: string): number | undefined {
  try {
    const st = statSync(path)
    if (!st.isFile() || st.size > 4 * 1024 * 1024) return undefined
    const text = readFileSync(path, "utf8")
    let n = 1
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
    return n
  } catch {
    return undefined
  }
}

export default Plugin.define({
  id: "delegate-guard",
  async setup(ctx) {
    await ctx.permission.hook("evaluate", async (event) => {
      if (event.action !== "read") return
      if (event.effect !== "allow") return
      if (event.agent !== undefined && EXEMPT_AGENTS.has(event.agent)) return
      for (const resource of event.resources ?? []) {
        const lines = lineCount(resource)
        if (lines !== undefined && lines > MIN_LINES) {
          event.effect = "deny"
          event.message =
            `大ファイル (${lines}行) の直接読みは不可。bulk-reader subagent に委譲すること。` +
            `対象箇所が明確な場合も同様。grep/glob での所在特定は素通し。`
          return
        }
      }
    })
  },
})
