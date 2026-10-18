import { Plugin } from "@opencode/plugin"

// Scoped failure guidance for the webfetch tool.
//
// Origin: moved out of ~/.config/opencode/AGENTS.md. A global instruction
// line costs tokens on every model call even though it is only relevant when
// a WebFetch call actually fails, so it belongs on the failure event itself.
// Flat cost otherwise: zero.
//
// Delivery: `execute.after` fires on the failure, but the text the model
// receives is rendered from the nested cause, not from `event.error.message`
// (verified in-env: rewriting the wrapper message "Unable to fetch <url>" left
// the model-facing text unchanged). The hook therefore only marks the session
// pending; the next model call's `context` hook pushes the reminder into the
// system prompt once, in the same request that carries the failing result.
const FAILURE_PATTERN =
  /Transport error|TransportError|Request timed out|timed out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed/i

const HINT = `<system-reminder>
A WebFetch call just failed with a transport error or a timeout. Notify the user. Recommend "1. Retry" and "2. Websearch" as options.
</system-reminder>`

// Auxiliary requests reuse the session hook identity; they must not consume
// the pending reminder before the agent loop reads it.
const EXCLUDED_AGENTS = new Set(["compaction", "summary", "title"])

const pending = new Set<string>()

// The wrapper message ("Unable to fetch <url>") is the same for every WebFetch
// failure, so the transport/timeout class has to come from the nested cause.
// Effect's HttpClientError.message delegates to its reason, which renders as
// "Transport error (GET <url>)" (or "Transport: <description> (GET <url>)",
// hence the extra patterns); the reason tag stays readable in the JSON form.
function failureText(error: unknown): string {
  const e = error as { message?: unknown; error?: unknown } | undefined
  const cause = e?.error as { message?: unknown } | undefined
  const parts: string[] = []
  for (const value of [e?.message, cause?.message]) {
    if (typeof value === "string") parts.push(value)
  }
  if (cause !== undefined) {
    parts.push(String(cause))
    try {
      parts.push(JSON.stringify(cause))
    } catch {}
  }
  return parts.join("\n")
}

export default Plugin.define({
  id: "tool-hints",
  async setup(ctx) {
    await ctx.tool.hook("execute.after", (event) => {
      try {
        if (event.tool !== "webfetch") return
        if (event.status !== "error") return
        if (!FAILURE_PATTERN.test(failureText(event.error))) return
        pending.add(event.sessionID)
      } catch {
        // Best-effort only: never break tool execution from a hint hook.
      }
    })

    await ctx.session.hook("context", (event) => {
      try {
        if (EXCLUDED_AGENTS.has(event.agent)) return
        if (!pending.delete(event.sessionID)) return
        event.system.push({ type: "text", text: HINT })
      } catch {
        // Best-effort only: never break a model call from a hint hook.
      }
    })
  },
})
