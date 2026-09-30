import { Plugin } from "@opencode-ai/plugin"

// Soft step guard for interactive sessions.
//
// Origin: per-agent `steps` cannot be used here — on the final step OpenCode
// sends tool_choice "none", which some providers (e.g. Console) reject
// outright. Instead of touching tool_choice, this counts model dispatches
// per user turn and appends a wrap-up instruction once the count passes a
// threshold. Text-only, so it works on every provider. It does not stop the
// loop; it tells the model to land the plane. Hard stops remain the user's
// interrupt button. Threshold via STEP_GUARD_MAX_CALLS (default 100).
const MAX_CALLS = Number(process.env.STEP_GUARD_MAX_CALLS ?? 100)
const MAX_SESSIONS = 100

const WRAP_UP = `You have used many model calls this turn. Wrap up soon: finish the current unit of work, summarize the state, and stop. Do not start new lines of investigation.`

const turns = new Map<string, { users: number; calls: number; warned: boolean }>()

function userMessages(messages: unknown): number | undefined {
  if (!Array.isArray(messages)) return undefined
  let n = 0
  for (const m of messages) {
    if (typeof m === "object" && m !== null && (m as { role?: unknown }).role === "user") n++
  }
  return n
}

export default Plugin.define({
  id: "step-guard",
  async setup(ctx) {
    await ctx.session.hook("context", (event) => {
      try {
        const users = userMessages((event as { messages?: unknown }).messages)
        if (users === undefined) return
        let st = turns.get(event.sessionID)
        if (!st || st.users !== users) {
          if (!st && turns.size >= MAX_SESSIONS) {
            const oldest = turns.keys().next()
            if (!oldest.done) turns.delete(oldest.value)
          }
          turns.set(event.sessionID, { users, calls: 1, warned: false })
          return
        }
        st.calls += 1
        if (st.calls > MAX_CALLS && !st.warned) {
          st.warned = true
          event.system.push({ type: "text", text: WRAP_UP })
        }
      } catch {
        // Best-effort only: never break model dispatch.
      }
    })
  },
})
