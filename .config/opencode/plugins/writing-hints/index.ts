import { Plugin } from "@opencode-ai/plugin"
import { statSync, readFileSync } from "node:fs"

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
// Mechanism note: like tool-hints, this appends text best-effort inside
// try/catch and never breaks tool execution. The hook delivers timing only;
// review quality itself is not enforced.
const MIN_LINES = 100

const REMINDER =
  "Before finalizing this document, load the `cat-writing` and " +
  "`dsh-trim-cot-leakage` skills and apply their checklists."

function targetPath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const filePath = (input as { filePath?: unknown }).filePath
  return typeof filePath === "string" ? filePath : undefined
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
        const path = targetPath((event as { input?: unknown }).input)
        if (!path || !path.endsWith(".md")) return
        const lines = lineCount(path)
        if (lines === undefined || lines <= MIN_LINES) return
        const target = event as { result?: { output?: unknown } }
        if (target.result && typeof target.result.output === "string") {
          if (target.result.output.includes("cat-writing")) return
          target.result.output = `${target.result.output}\n\n${REMINDER}`
        }
      } catch {
        // Best-effort only: never break tool execution from a hint hook.
      }
    })
  },
})
