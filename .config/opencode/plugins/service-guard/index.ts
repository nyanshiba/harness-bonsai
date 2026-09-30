import { Plugin } from "@opencode-ai/plugin"

// Hard block for `opencode2 service restart` issued from inside a session.
//
// Restarting the shared background service drops the current session's
// connection, so it must never run via the shell tool. Unlike "ask", "deny"
// cannot be overridden with one click, which is exactly what this needs.
//
// Denial is not a dead end: the message below orders the agent to switch to
// the question tool ("再起動を実行した" / "キャンセル") and wait. The user
// restarts in a separate terminal and reports back by selecting an option.
// Shell retries stay denied, so the loop always terminates at the user's
// explicit choice.
//
// Scope: `opencode2 service restart` only. Other subcommands (status etc.)
// are harmless and pass through untouched. An explicit "deny" in config is
// final and never reaches this hook.
const RESTART_PATTERN = /\bopencode2(\.exe)?\s+service\s+restart\b/

const DENY_MESSAGE = `Executing the \`opencode2 service restart\` shell command is prohibited.
    Instead, use the \`question\` tool to present the options "Restart performed" and "Cancel," and wait for the user to perform the restart.
    Proceed with the task only if "Restart performed" is selected.`

export default Plugin.define({
  id: "service-guard",
  async setup(ctx) {
    await ctx.permission.hook("evaluate", async (event) => {
      if (event.action !== "shell") return
      if (event.effect === "deny") return
      const resources = event.resources ?? []
      if (!resources.some((r) => RESTART_PATTERN.test(r))) return
      event.effect = "deny"
      event.message = DENY_MESSAGE
    })
  },
})
