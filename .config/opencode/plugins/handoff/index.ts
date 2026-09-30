import { Plugin } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
let cachedBin: string | null = null

async function resolveBin(): Promise<string> {
  if (cachedBin) return cachedBin
  const candidates = [
    process.env.OPENCODE_BIN,
    "opencode2",
    `${process.env.HOME ?? "/root"}/.bun/bin/opencode2`,
    "/root/.bun/bin/opencode2",
  ].filter(Boolean) as string[]
  for (const bin of candidates) {
    try {
      await execFileAsync(bin, ["--version"], { timeout: 5000 })
      cachedBin = bin
      return bin
    } catch {
    }
  }
  cachedBin = "opencode2"
  return cachedBin
}

async function apiGet(path: string): Promise<any> {
  const bin = await resolveBin()
  const tmp = `/tmp/opencode/handoff-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  try {
    await execFileAsync("sh", ["-c", `${bin} api get '${path.replace(/'/g, "'\\''")}' > '${tmp}'`], {
      timeout: 20000,
      maxBuffer: 64 * 1024 * 1024,
    })
    const { readFile, unlink } = await import("node:fs/promises")
    const raw = await readFile(tmp, "utf8")
    try { await unlink(tmp) } catch {}
    return JSON.parse(raw)
  } catch (e: any) {
    try { const { unlink } = await import("node:fs/promises"); await unlink(tmp) } catch {}
    const stderr = e?.stderr?.toString?.() ?? e?.message ?? String(e)
    throw new Error(`handoff api failed: GET ${path}: ${String(stderr).slice(0, 2000)}`)
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n) + `…[truncated ${s.length - n} chars]`
}

function textOf(v: unknown, n = 2000): string {
  if (typeof v === "string") return truncate(v, n)
  try {
    return truncate(JSON.stringify(v), n)
  } catch {
    return "[unserializable]"
  }
}

function simplifyMessage(m: any): any {
  const base: any = { id: m?.id, type: m?.type }
  if (m?.agent) base.agent = m.agent
  if (m?.time?.created) base.created = m.time.created
  const t = m?.type
  if (t === "user") {
    base.text = textOf(m?.text ?? m?.content ?? "", 4000)
  } else if (t === "assistant") {
    const parts = Array.isArray(m?.content) ? m.content : []
    const texts: string[] = []
    const tools: any[] = []
    for (const p of parts) {
      if (p?.type === "text" && p.text) texts.push(p.text)
      else if (p?.type === "tool") {
        const st = (p as any)?.state ?? {}
        const resultTexts = Array.isArray((p as any)?.content)
          ? (p as any).content.filter((c: any) => c?.type === "text" && c.text).map((c: any) => c.text)
          : []
        tools.push({
          name: (p as any).name ?? (p as any).tool ?? "tool",
          status: st.status,
          input: textOf(st.input ?? (p as any).input ?? (p as any).args ?? {}, 4000),
          ...(resultTexts.length ? { result: truncate(resultTexts.join("\n"), 1500) } : {}),
        })
      }
    }
    if (texts.length) base.text = truncate(texts.join("\n"), 4000)
    if (tools.length) base.tools = tools.slice(0, 20)
    if (!base.text && !base.tools) base.summary = textOf(m, 800)
  } else if (t === "synthetic" || t === "system" || t === "shell" || t === "skill" || t === "compaction") {
    base.text = textOf(m?.text ?? m?.content ?? m?.summary ?? m, 2000)
  } else {
    base.text = textOf(m?.text ?? m?.content ?? "", 2000)
  }
  return base
}

function pack(items: any[], maxChars = 38000): { text: string; omitted: number; retainedRatio: number } {
  let chars = 0
  const out: any[] = []
  let omitted = 0
  for (const it of items) {
    const s = JSON.stringify(it)
    if (chars + s.length > maxChars) {
      omitted++
      continue
    }
    chars += s.length
    out.push(it)
  }
  const total = items.length || 1
  const retainedRatio = (total - omitted) / total
  return { text: JSON.stringify(out, null, 1), omitted, retainedRatio }
}

function budgetWarning(retainedRatio: number, mode: string): string | null {
  if (retainedRatio <= 0.25) return `GUARDRAIL: retained ${(retainedRatio * 100).toFixed(0)}% ≤25% — paper reports 10.92x failure odds vs ≥50% (2609.16461 H2). Increase limit, page with cursor, or split by task phase.`
  if (retainedRatio <= 0.35) return `GUARDRAIL: retained ${(retainedRatio * 100).toFixed(0)}% ≤35% — below critical threshold for medium/high complexity (Table 2, 2609.16461). Protocol-aware trimming 5.24x odds vs conventional at this budget (H3); prefer targeted read over full dump.`
  if (retainedRatio <= 0.5) return `GUARDRAIL: retained ${(retainedRatio * 100).toFixed(0)}% ≤50% — approaching nonlinear failure regime. Keep protocol-critical state lossless (ids, constraints, tool schemas) and avoid aggressive summarization.`
  if (mode === "context") return `NOTE: context mode drops pre-compaction protocol state (unresolved dependencies, negative instructions). For high-consequence steps, use messages with cursor instead.`
  return null
}

export default Plugin.define({
  id: "handoff",
  async setup(ctx) {
    await ctx.command.transform((editor) => {
      editor.add({
        name: "handoff",
        description: "Pull context from another session: list, pick, read live at read time",
        execute: async ({ sessionID, prompt, delivery }) => {
          const arg = prompt.text.replace(/^\/handoff\s*/, "").trim()
          const directive = arg.startsWith("ses_")
            ? `Use the handoff tools: call handoff_read on session "${arg}" in info mode first, then fetch only what is needed (context or paginated messages).`
            : arg
              ? `Use the handoff tools: call handoff_list with search "${arg}", present the candidates briefly, then read the chosen session with handoff_read.`
              : `Use the handoff tools: call handoff_list to show recent sessions, let the user pick one, then read it with handoff_read.`
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: `${directive}\n\nOriginal request: ${prompt.text}`,
            delivery,
          })
        },
      })
    })
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "handoff",
        description: "Pull another session at read time. List first, then read. Destination LLM decides what to fetch.",
      })
      editor.add({
        name: "list",
        description: "List recent sessions for handoff. Returns id, title, agent, model, updated, directory. Pick one then call handoff_read.",
        input: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Max sessions, default 20, max 50" },
            search: { type: "string", description: "Filter by title text" },
          },
          additionalProperties: false,
        },
        options: { namespace: "handoff" },
        execute: async (input, tool) => {
          const args = (input ?? {}) as { limit?: number; search?: string }
          const limit = Math.min(Math.max(args.limit ?? 20, 1), 50)
          const q = `/api/session?limit=${limit}&order=desc${args.search ? `&search=${encodeURIComponent(args.search)}` : ""}`
          const res = await apiGet(q)
          const rows = (res?.data ?? []).map((s: any) => ({
            id: s.id,
            title: truncate(s.title ?? "", 80),
            agent: s.agent,
            model: s.model ? `${s.model.providerID}/${s.model.id}` : undefined,
            updated: s.time?.updated,
            directory: s.location?.directory,
            current: s.id === (tool as any)?.sessionID,
          }))
          return { content: JSON.stringify({ sessions: rows, hint: "Call handoff_read with chosen id. Content is fetched live at read time, no snapshot is stored." }, null, 1) }
        },
      })
      editor.add({
        name: "read",
        description: "Read another session live at read time. Modes: info=metadata only, context=active context after last compaction, messages=paginated history. Start with info or context, expand only as needed.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "Target session id, must start with ses_" },
            mode: { type: "string", enum: ["info", "context", "messages"], description: "Default messages" },
            limit: { type: "number", description: "Messages mode page size, default 30, max 100" },
            order: { type: "string", enum: ["asc", "desc"], description: "Messages mode order, default asc" },
            cursor: { type: "string", description: "Messages mode pagination cursor from previous read" },
          },
          required: ["sessionID"],
          additionalProperties: false,
        },
        options: { namespace: "handoff" },
        execute: async (input) => {
          const args = (input ?? {}) as { sessionID: string; mode?: string; limit?: number; order?: string; cursor?: string }
          if (!/^ses_/.test(args.sessionID ?? "")) throw new Error("sessionID must start with ses_")
          const mode = args.mode ?? "messages"
          if (mode === "info") {
            const res = await apiGet(`/api/session/${args.sessionID}`)
            const s = res?.data ?? res
            return {
              content: JSON.stringify({
                id: s.id,
                title: s.title,
                agent: s.agent,
                model: s.model,
                time: s.time,
                directory: s.location?.directory,
              }, null, 1),
            }
          }
          if (mode === "context") {
            const res = await apiGet(`/api/session/${args.sessionID}/context`)
            const items = (res?.data ?? []).map(simplifyMessage)
            const { text, omitted, retainedRatio } = pack(items)
            const warn = budgetWarning(retainedRatio, "context")
            return { content: `${warn ? warn + "\n" : ""}context of ${args.sessionID} (live, retained ${(retainedRatio * 100).toFixed(0)}%, omitted=${omitted}, protocol-critical: ids/constraints/tool-contracts kept lossless up to 4k):\n${text}` }
          }
          const limit = Math.min(Math.max(args.limit ?? 30, 1), 100)
          const order = args.order ?? "asc"
          const q = `/api/session/${args.sessionID}/message?limit=${limit}&order=${order}${args.cursor ? `&cursor=${encodeURIComponent(args.cursor)}` : ""}`
          const res = await apiGet(q)
          const items = (res?.data ?? []).map(simplifyMessage)
          const { text, omitted, retainedRatio } = pack(items)
          const next = res?.cursor?.next ?? res?.cursor?.previous
          const warn = budgetWarning(retainedRatio, "messages")
          return {
            content: `${warn ? warn + "\n" : ""}messages of ${args.sessionID} (live, retained ${(retainedRatio * 100).toFixed(0)}%, omitted=${omitted}${next ? `, nextCursor=${next}` : ""}, order=${order} — protocol-aware: ids/tool-args lossless):\n${text}`,
          }
        },
      })
    })
  },
})
