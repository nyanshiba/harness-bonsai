import { Plugin } from "@opencode/plugin"
import { readFileSync, statSync } from "node:fs"

// Just-in-time writing reminder for long-form documents.
//
// Origin: AGENTS.md held a permanent "load cat-writing and dsh-trim-cot-leakage
// when finishing" line, but a standing instruction never fired in practice.
// Evidence for moving delivery to the event (PolicyGuard, arXiv:2606.29225:
// "prompt-level instruction alone is not enough, an external enforcement
// layer is needed"; AgentSpec, ICSE, arXiv:2503.18666: decision-point hooks
// with measured effect; arXiv:2511.15759: a post-hoc verification layer
// catches ~60% of what slips through):
// deliver the reminder when a document write completes, not on every call.
// Flat cost otherwise: zero.
//
// Delivery: `execute.after` only records the session once a long .md write
// completes; the next model call's `context` hook pushes the reminder into the
// system prompt once, so the model reads it before it finalizes the response
// that follows the write. The hook delivers timing only; review quality itself
// is not enforced.
const MIN_LINES = 100

const REMINDER = `<system-reminder>
Before finalizing this document, load the \`cat-writing\` and \`dsh-trim-cot-leakage\` skills and apply their checklists.
</system-reminder>`

// Auxiliary requests reuse the session hook identity; they must not consume
// the pending reminder before the agent loop reads it.
const EXCLUDED_AGENTS = new Set(["compaction", "summary", "title"])

const pending = new Set<string>()

// The v2 edit/write tools take `path`, and write reports the resolved path as
// `target` in its output. The earlier `filePath` read matched neither, so the
// reminder never armed at all.
function resolvedPath(event: unknown): string | undefined {
  const e = event as { input?: unknown; result?: { output?: unknown } }
  const output = e?.result?.output
  if (typeof output === "object" && output !== null) {
    const target = (output as { target?: unknown }).target
    if (typeof target === "string") return target
  }
  const input = e?.input
  if (typeof input === "object" && input !== null) {
    const i = input as { path?: unknown; filePath?: unknown }
    if (typeof i.path === "string") return i.path
    if (typeof i.filePath === "string") return i.filePath
  }
  return undefined
}

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
  id: "writing-hints",
  async setup(ctx) {
    await ctx.tool.hook("execute.after", (event) => {
      try {
        if (event.tool !== "edit" && event.tool !== "write") return
        if (event.status !== "completed") return
        const path = resolvedPath(event)
        if (!path || !path.endsWith(".md")) return
        const lines = lineCount(path)
        if (lines === undefined || lines <= MIN_LINES) return
        pending.add(event.sessionID)
      } catch {
        // Best-effort only: never break tool execution from a hint hook.
      }
    })

    await ctx.session.hook("context", (event) => {
      try {
        if (EXCLUDED_AGENTS.has(event.agent)) return
        if (!pending.delete(event.sessionID)) return
        event.system.push({ type: "text", text: REMINDER })
      } catch {
        // Best-effort only: never break a model call from a hint hook.
      }
    })
  },
})
