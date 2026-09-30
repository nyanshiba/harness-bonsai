import { Plugin } from "@opencode-ai/plugin"

// Scoped failure guidance for the webfetch tool.
//
// Origin: moved out of ~/.config/opencode/AGENTS.md. A global instruction
// line costs tokens on every model call even though it is only relevant when
// a WebFetch call actually fails, so it belongs on the failure event itself.
// Flat cost otherwise: zero.
//
// Mechanism note: the documented `execute.after` contract only guarantees
// `event.error.message` as readable on failures, so the hint is appended to
// the error text best-effort inside try/catch. The error text is fed back to
// the model as the tool result, which preserves the original AGENTS.md
// behavior deterministically.
const FAILURE_PATTERN = /Transport error|Request timed out/i

const HINT =
  "If this WebFetch failure message contains \"Transport error\" or \"Request timed out,\" " +
  "notify the user. Recommend \"1. Retry\" and \"2. Websearch\" as options."

export default Plugin.define({
  id: "tool-hints",
  async setup(ctx) {
    await ctx.tool.hook("execute.after", (event) => {
      if (event.tool !== "webfetch") return
      if (event.status !== "error") return
      const message = event.error?.message ?? ""
      if (!FAILURE_PATTERN.test(message)) return
      if (message.includes(HINT)) return
      try {
        const target = event as { error?: { message?: unknown } }
        if (target.error && typeof target.error.message === "string") {
          target.error.message = `${target.error.message}\n\n${HINT}`
        }
      } catch {
        // Best-effort only: never break tool execution from a hint hook.
      }
    })
  },
})
