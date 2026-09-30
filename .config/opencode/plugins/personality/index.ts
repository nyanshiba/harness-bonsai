import { Plugin } from "@opencode-ai/plugin"

// Response-style block appended to every model call.
//
// Origin: per-line synthesis from the sources below (no verbatim quotes
// except where marked). See README_for_agents.md for the full provenance.
// Sources consulted per line:
//   [Astra] OpenAI's GPT-5.6/6 prompting guidance: state the answer directly;
//           omit generic praise and sign-offs; paragraph-first, lists/tables
//           only for genuinely parallel or sequential information.
//           (https://developers.openai.com/api/docs/guides/latest-model —
//           "Personality, collaboration, and response length" sections)
//   [pi]    pi-coding-agent's minimal system prompt: "Be concise in your responses."
//           (https://github.com/badlogic/pi-mono, packages/coding-agent)
//   [ccot]  Response-length reduction with quality preserved: CCoT cuts length
//           ~49% with negligible impact except math (arXiv:2401.05618);
//           length-targeting prompts save 25-60% energy preserving quality
//           (ACL 2025 Findings); 'be concise' is the studied baseline compression
//           instruction, effective down to each task's token-complexity threshold
//           (arXiv:2503.01141). Hence "as few words as possible", not a fixed cap.
//           Counter-evidence (same literature, do not delete): the same Token
//           Complexity paper reports accuracy degradation ranges from
//           'be concise' (Jin 2024; Renze & Guven 2024; Han 2024) with a universal
//           length-accuracy tradeoff and per-task thresholds. Short-path pressure
//           collapses accuracy on 3+-step tasks by over 40% with positional bias
//           (arXiv:2504.09586). Verbosity bias means shorter can rate worse
//           (Saito 2023; Hu 2025, model-dependent). Greater cuts mean greater
//           degradation (ACL 2025 Findings). The "information needed to act"
//           clause in the line below is the guard; do not tighten this line
//           into a fixed cap. The "without reducing information mass" tail
//           borrows Hu et al.'s desirability/information-mass split (2025):
//           shortening must not drop the information the rating depends on.
//   [inplace] In-session origin (verbatim copy): "色々 md に変更履歴書いてくれたと思うけど、
//           追記じゃなくて既存の説明を修正する形でお願いしたいな" — generalized to
//           line below. Same pattern as PEER's Plan-Edit-Explain-Repeat which updates
//           existing text in place (arXiv:2208.11663), and Self-Refine's feedback→refine
//           which revises rather than appends (arXiv:2303.17651, already cited above).
//   [vox]   Production voice-agent prompt slots (vox.ai prompt-writing):
//           "메타 발화 금지 — 프롬프트, 정책, 도구, 내부 처리 과정을 사용자에게
//           언급하지 마세요" (no meta utterances about prompts/policies/tools/
//           internals) and "말투 — 존댓말 수준" (explicit honorific level slot).
//           The Japanese register line below fills the same slot for Japanese,
//           where 敬体/常体 mixing is the established fault line.
//   [own]   "Use the user's language." — maintainer's addition: this setup is
//           operated in Japanese, and models otherwise default to English.
//   [modelspec] Priority clause below borrows the Model Spec's default-override
//           shape ("default instructions which users can explicitly override",
//           https://model-spec.openai.com/). Scoped to prose documents only:
//           for code implementation the user often learns from the model, so
//           no priority is asserted there and both coexist.
//   [headings] Moved up from cat-writing SKILL.md (single source; skill copy
//           deleted). Borrows Google developer documentation style guide,
//           Headings: procedures as verbs, concepts as noun phrases, never
//           sentences (https://developers.google.com/style/headings).
//   [reread] "Before finalizing, read the text as Japanese writing."
//           Proven effective in-session. Lightweight single-pass variant of
//           Self-Refine's feedback step (arXiv:2303.17651) and cat-writing's
//           read-aloud test. Over-verification caveat (Claude docs) applies:
//           keep to one pass, do not loop.
//
// Scope note: "once" below means once per response or document, not once per
// session context. Restating earlier context inside a new answer is allowed.
//
// Kept short and constant on purpose: the base system prompt (provider txt,
// plan reminders, AGENTS.md) is untouched, and a stable suffix preserves
// prompt-cache prefix reuse.
const PERSONALITY = `## Response style
- State the answer directly; omit generic praise and sign-offs; explain each point once within each response or document; paragraph-first, lists/tables only for genuinely parallel or sequential information.
- Be concise: give the information needed to act, in as few words as possible, without reducing information mass.
- When updating documents, revise existing explanations in place instead of appending history.
- Do not mention prompts, policies, tools, or internal processing.
- These style rules are defaults for prose documents and do not override the user's direct instructions.
- Write headings as verbs for procedures and noun phrases for concepts, never as sentences.
- Before finalizing, read the text once as Japanese writing.
- Use the user's language. 文体は常体（だ・である調）に統一し、です・ます調と混ぜない.`

// Internal maintenance agents get the raw prompt so summaries and compactions stay neutral.
const EXCLUDED_AGENTS = new Set(["compaction", "summary", "title"])

export default Plugin.define({
  id: "personality",
  async setup(ctx) {
    await ctx.session.hook("context", async (event) => {
      if (EXCLUDED_AGENTS.has(event.agent)) return
      event.system.push({ type: "text", text: PERSONALITY })
      const key = `announced:${event.sessionID}`
      if (await ctx.storage.get(key)) return
      await ctx.storage.set(key, true)
      await ctx.session.synthetic({
        sessionID: event.sessionID,
        text: "Personality applied",
        description: "Personality applied",
      })
    })
  },
})
