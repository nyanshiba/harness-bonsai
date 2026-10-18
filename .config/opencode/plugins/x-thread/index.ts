// x-thread: webfetch(x.com) を検知し、そのポストが属する作者スレッド全体を組み立てて、
// 生 HTML をモデルに渡さず整形済みの結果へ差し替える。
//
// 手順書 x-thread-all-posts-procedure.md の Step 1〜5 をコードで代行する:
//   Step 1   親方向  : syndication API を in_reply_to_status_id_str で辿る    → 機能1
//   Step 1.5 下方向  : x.com HTML の候補 ID を syndication で検証して本体を延長 → 機能1
//   Step 2/3 子列挙  : 作者の連鎖だけ本体、他者の返信は別表、404/400 は除外表      → 機能2
//   Step 4   note    : x.com HTML の full_text から全文を補完 (t.co 展開含む)    → 機能4
//   引用追跡         : 被引用ポストを新規が無くなるまで辿る                     → 機能3
//   Step 5   検収    : 重複排除・連鎖完全性などの診断はデバッグログにだけ出す
//
// 取得エンジンは webfetch のまま使う (execute.before で format=html を要求し、
// execute.after で結果を差し替える)。失敗しても webfetch は壊さない。

import { appendFileSync } from "node:fs"

const STATUS_URL = /^https?:\/\/(?:www\.|mobile\.|m\.)?(?:x|twitter)\.com\/([^/]+)\/status(?:es)?\/(\d+)/

// 間接 URL (ミラー / oembed) を x.com の正規形へ置き換えるための判定。
// webfetch がミラー越しに失敗したときの差し替えは型として用意されていない
// (execute.after の error 分岐に result がない) ため、before で URL と format を改竄して
// x.com への 1 fetch として実行させる。
const MIRROR_HOST = /^(?:api\.)?(?:fxtwitter|vxtwitter)\.com$/
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
const REST_ID_RE = /\\?"rest_id\\?":\\?"(\d{19})\\?"/g
const CONVERSATION_RE = /conversationthread-(\d{19})/g
const FALLBACK_ID_RE = /\b2\d{18}\b/g

export function statusTarget(url: string): { author: string; startId: string; fetchUrl: string } | null {
  const direct = STATUS_URL.exec(url)
  if (direct) {
    return {
      author: direct[1],
      startId: direct[2],
      fetchUrl: `https://x.com/${direct[1]}/status/${direct[2]}`,
    }
  }
  try {
    const u = new URL(url)
    if (MIRROR_HOST.test(u.hostname)) {
      const m = /^\/([^/]+)\/status(?:es)?\/(\d+)/.exec(u.pathname)
      if (m) return { author: m[1], startId: m[2], fetchUrl: `https://x.com/${m[1]}/status/${m[2]}` }
      return null
    }
    if (u.hostname === "publish.twitter.com") {
      const inner = u.searchParams.get("url")
      const dec = inner ? STATUS_URL.exec(inner) : null
      if (dec) return { author: dec[1], startId: dec[2], fetchUrl: `https://x.com/${dec[1]}/status/${dec[2]}` }
    }
  } catch {}
  return null
}

// 19 桁の snowflake ID は Number の安全整数範囲を超えるため、桁数と辞書順で比較する。
export function idCmp(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

const CDN = "https://cdn.syndication.twimg.com/tweet-result"
const MAX_HOPS = 12
const PAGE_ATTEMPTS = 4
const SYND_TIMEOUT_MS = 10_000
const PAGE_TIMEOUT_MS = 20_000
const LOG = "/tmp/opencode/x-thread.log"

type LinkRef = { tco: string; url: string }

type Tweet = {
  id: string
  author: string
  createdAt?: string
  text: string
  isNote: boolean
  fullText?: string
  parent?: string
  quotes: QuoteRef[]
  links: LinkRef[]
}

type QuoteRef = { id: string; author: string; text: string; links: LinkRef[] }

type Thread = {
  startId: string
  posts: Tweet[]
  ancestors: Tweet[]
  replies: Tweet[]
  quoted: Array<QuoteRef & { quoteOf: string }>
  excluded: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function dlog(line: string): void {
  if (process.env.X_THREAD_DEBUG !== "1") return
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

// syndication の呼び出しを直列化して 1 本の keep-alive 接続で回す。
// probe の Promise.all は順番待ちになるだけ (呼び出し側の受け取り方は変わらない)。
let syndTail: Promise<any> = Promise.resolve()

function synd(id: string): Promise<any | null> {
  const run = syndTail.catch(() => {}).then(() => fetchSynd(id))
  syndTail = run
  return run
}

async function fetchSynd(id: string): Promise<any | null> {
  try {
    const res = await fetch(`${CDN}?id=${id}&lang=en&token=0`, {
      signal: AbortSignal.timeout(SYND_TIMEOUT_MS),
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
    })
    if (!res.ok) return { __status: res.status }
    const text = await res.text()
    if (text.length <= 2) return { __status: "empty" }
    const data = JSON.parse(text)
    if (!data || typeof data !== "object" || typeof data.id_str !== "string" || !/^\d+$/.test(data.id_str)) {
      return null
    }
    return data
  } catch {
    return null
  }
}

async function page(id: string, author: string): Promise<string> {
  try {
    const res = await fetch(`https://x.com/${author}/status/${id}`, {
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "accept-language": "en",
      },
      redirect: "follow",
    })
    if (!res.ok) return ""
    const ct = (res.headers.get("content-type") ?? "").toLowerCase()
    if (ct && !ct.includes("html")) return ""
    return await res.text()
  } catch {
    return ""
  }
}

// ツイート本体の ID は \"rest_id\" に、添付 media の ID は \"id_str\" に出る。
// 会話の継続 (返信) は conversationthread-<id> として現れる。
export function candidatesIn(html: string, known: Set<string>, minId: string): string[] {
  const pick = (ms: RegExpMatchArray[]) => ms.map((m) => m[1])
  const primary = [
    ...pick([...html.matchAll(REST_ID_RE)]),
    ...pick([...html.matchAll(CONVERSATION_RE)]),
  ]
  const found = [...new Set(primary)]
  // 親 → 子の順に処理できるよう、古い ID から返す。
  if (found.length) {
    return found.filter((c) => idCmp(c, minId) > 0 && !known.has(c)).sort(idCmp)
  }
  // 予備: 主経路が 1 件も一致しない変種 HTML のときだけ 19 桁を総当たりする。
  // 主経路が一致した後の絞り込み 0 件で走らせると、末端ページで 404 探索が増える。
  return [...new Set(html.match(FALLBACK_ID_RE) ?? [])]
    .filter((c) => idCmp(c, minId) > 0 && !known.has(c))
    .sort(idCmp)
}

// 機能4 (t.co 展開): syndication payload の t.co → 展開先の対応を集める (追加 fetch なし)。
// entities.urls は本文中のリンク、entities.media は media の t.co。
function linksOf(j: any): LinkRef[] {
  const pick = (e: any): LinkRef | null => (e?.url && (e?.expanded_url ?? e?.media_url_https) ? { tco: e.url, url: e.expanded_url ?? e.media_url_https } : null)
  return [...(j?.entities?.urls ?? []), ...(j?.entities?.media ?? [])].map(pick).filter(Boolean) as LinkRef[]
}

export function expandLinks(text: string, links: LinkRef[]): string {
  let out = text
  for (const l of [...links].sort((a, b) => b.tco.length - a.tco.length)) {
    if (out.includes(l.tco)) out = out.split(l.tco).join(l.url)
  }
  return out
}

function toTweet(j: any): Tweet {
  return {
    id: j.id_str,
    author: j.user?.screen_name ?? "?",
    createdAt: j.created_at,
    text: j.text ?? "",
    isNote: "note_tweet" in (j ?? {}),
    parent: j.in_reply_to_status_id_str ?? undefined,
    links: linksOf(j),
    quotes: j?.quoted_tweet?.id_str
      ? [{
          id: String(j.quoted_tweet.id_str),
          author: j.quoted_tweet.user?.screen_name ?? "?",
          text: j.quoted_tweet.text ?? "",
          links: linksOf(j.quoted_tweet),
        }]
      : [],
  }
}

// --- Step 4: note tweet の全文 -------------------------------------------------

// HTML の SSR JSON は 1 段エスケープされている。1 段戻してから JSON 文字列として
// 厳密にデコードする (正規表現と unescape の順序に依存しない)。
const norm = (s: string) => s.replace(/\s+/g, " ").trim()

function jsonStr(raw: string): string | null {
  try {
    const v = JSON.parse(`"${raw}"`)
    return typeof v === "string" ? v : null
  } catch {
    return null
  }
}

function decodeJsonStrings(html: string): string[] {
  const unescaped = html.replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  const out: string[] = []
  const re = /"text":"((?:[^"\\]|\\.)*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(unescaped))) {
    const v = jsonStr(m[1])
    if (v !== null) out.push(v)
  }
  return out
}

export function noteKey(text: string): string {
  const normalized = norm(text)
  return normalized
    .replace(/\s*https?:\/\/t\.co\/\w+\s*$/i, "")
    .replace(/…\s*$/, "")
    .trim()
    .slice(0, 120)
}

export function noteFullText(html: string, truncated: string): string | null {
  const texts = decodeJsonStrings(html).filter((t) => t.length > truncated.length + 20)
  if (!texts.length) return null
  const key = noteKey(truncated)
  if (!key) return null
  const starts = texts.filter((t) => norm(t).startsWith(key))
  if (!starts.length) return null
  return starts.reduce((a, b) => (b.length > a.length ? b : a))
}

// 機能4 (note 全文の付随処理): note 全文の HTML には entity_set (t.co → 展開先) も埋まっている。
// t.co コードは全体で一意なので、ページ内の対応表をそのまま使ってよい。
export function linksFromHtml(html: string): LinkRef[] {
  const un = html.replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  const out: LinkRef[] = []
  const seen = new Set<string>()
  const re = /"expanded_url":"((?:[^"\\]|\\.)*)"[^{}]{0,240}?"url":"((?:[^"\\]|\\.)*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(un))) {
    const url = jsonStr(m[1])
    const tco = jsonStr(m[2])
    if (url === null || tco === null || !tco.startsWith("https://t.co/")) continue
    if (seen.has(tco)) continue
    seen.add(tco)
    out.push({ tco, url })
  }
  return out
}

// --- Step 1 / 1.5 --------------------------------------------------------------

// 機能2 の採否: 取得できる範囲のリプライを本体と分離する。
// 他者ポストは replies に入れ、作者の自己連鎖だけを posts として採用する。
function adopt(t: Thread, post: Tweet, known: Set<string>): boolean {
  if (post.author === t.posts[0].author) {
    if (post.parent && t.posts.some((p) => p.id === post.parent)) {
      t.posts.push(post)
      known.add(post.id)
      return true
    }
  } else if (post.parent && known.has(post.parent)) {
    t.replies.push(post)
    known.add(post.id)
    return false
  }
  t.excluded++
  known.add(post.id)
  return false
}

async function probe(t: Thread, ids: string[], known: Set<string>): Promise<number> {
  const p0 = Date.now()
  const results = await Promise.all(ids.map((id) => synd(id)))
  let added = 0
  for (let i = 0; i < ids.length; i++) {
    const j = results[i]
    if (!j || j.__status) {
      t.excluded++
      known.add(ids[i])
      continue
    }
    if (adopt(t, toTweet(j), known)) added++
  }
  dlog(`probe: n=${ids.length} ms=${Date.now() - p0}`)
  return added
}

// 機能1 (下方向): root 作者の自己スレッドを末端まで延長する。
// 末端判定は「新規 200+JSON が 0」という成果物基準 (HTML の見た目は判定に使わない)。
async function extendDown(
  t: Thread,
  known: Set<string>,
  loadPage: (id: string, author: string) => Promise<string>,
): Promise<void> {
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const newest = t.posts.reduce((a, b) => (idCmp(a.id, b.id) > 0 ? a : b)).id
    let cands: string[] = []
    for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt++) {
      const html = await loadPage(newest, t.posts[0].author)
      cands = candidatesIn(html, known, newest)
      // 縮退 HTML を疑うのは候補が 0 のときだけ。採否は syndication の結果で決める
      // (hop の新規 200+JSON が 0 なら下の added===0 で終了する)。
      if (cands.length) break
      dlog(`thin page for ${newest} len=${html.length} attempt=${attempt}`)
      await sleep(1500 * (attempt + 1))
    }
    if (!cands.length) return
    const added = await probe(t, cands, known)
    dlog(`hop${hop}: cands=${cands.length} added=${added}`)
    if (!added) return
  }
}

// --- 組み立て ------------------------------------------------------------------

async function build(startId: string, startHtml: string): Promise<Thread> {
  const b0 = Date.now()
  const t: Thread = { startId, posts: [], ancestors: [], replies: [], quoted: [], excluded: 0 }
  const known = new Set<string>()
  const pages = new Map<string, string>()
  const loadPage = async (id: string, author: string): Promise<string> => {
    const key = `${author}/${id}`
    const cached = pages.get(key)
    if (cached !== undefined) return cached
    const html = await page(id, author)
    if (html) pages.set(key, html)
    return html
  }

  // 機能1: どの位置からでもツリー全体 — 起点から親方向に辿って root を確定する
  // (続けて root から下方向へ延長する)。
  let cur: string | undefined = startId
  while (cur && !known.has(cur) && t.posts.length < 500) {
    known.add(cur)
    const j = await synd(cur)
    if (!j || j.__status) {
      t.excluded++
      break
    }
    t.posts.push(toTweet(j))
    cur = t.posts[t.posts.length - 1].parent
  }
  if (!t.posts.length) throw new Error("start post unavailable")
  t.posts.sort((a, b) => idCmp(a.id, b.id))
  dlog(`up-walk: start=${startId} posts=${t.posts.length} root=${t.posts[0].id} author=${t.posts[0].author}`)

  // 起点が他者のポストへの返信なら、祖先連鎖に他者のポストが混ざる。
  // 本体は root の作者の自己スレッドに限定し、他者は祖先として分離する。
  const rootAuthor = t.posts[0].author
  t.ancestors = t.posts.filter((p) => p.author !== rootAuthor)
  if (t.ancestors.length) t.posts = t.posts.filter((p) => p.author === rootAuthor)

  // webfetch が返した起点ページを、同じページの再取得に使う (ビルド内だけの再利用)。
  const startPost = t.posts.find((p) => p.id === startId) ?? t.ancestors.find((p) => p.id === startId)
  if (startHtml && startPost) pages.set(`${startPost.author}/${startId}`, startHtml)

  // Step 1.5: 下方向 (機能1 の残り)
  await extendDown(t, known, loadPage)
  dlog(`down-walk: posts=${t.posts.length} replies=${t.replies.length} excluded=${t.excluded}`)

  // 機能2: 取得できる範囲のリプライ — 起点ページに映る返信も拾う
  // (本体の作者連鎖は親探索で既に揃っている)。
  if (startHtml) {
    const extra = candidatesIn(startHtml, known, "0")
    if (extra.length) await probe(t, extra, known)
  }

  // 機能4: 全文取得 — note tweet は x.com HTML から全文を補完し、
  // そのページの entity_set から t.co の展開先も拾う。
  for (const p of t.posts) {
    if (!p.isNote) continue
    const pageHtml = await loadPage(p.id, p.author)
    const full = noteFullText(pageHtml, p.text)
    if (full && full.length > p.text.length) {
      p.fullText = full
      const seen = new Set(p.links.map((l) => l.tco))
      for (const l of linksFromHtml(pageHtml)) if (!seen.has(l.tco)) p.links.push(l)
      dlog(`note completed: ${p.id} ${p.text.length} -> ${full.length} (links=${p.links.length})`)
    }
  }

  t.posts.sort((a, b) => idCmp(a.id, b.id))
  t.replies.sort((a, b) => idCmp(a.id, b.id))

  // 機能3: 引用を掘る — 埋め込み quoted_tweet を起点に、各被引用ポストを
  // syndication で取り直して そこがまた引用しているかを確認する
  // (新規引用が無くなるまで。各 ID は 1 回だけ取り直す)。
  {
    const postIds = new Set(t.posts.map((p) => p.id))
    const info = new Map<string, { q: QuoteRef; quoteOf: string }>()
    for (const p of t.posts) for (const q of p.quotes) info.set(q.id, { q, quoteOf: p.id })
    const order = [...info.keys()]
    const done = new Set<string>()
    for (let i = 0; i < order.length; i++) {
      const id = order[i]
      if (done.has(id)) continue
      done.add(id)
      const j = await synd(id)
      if (j && !j.__status) {
        const e = info.get(id)
        if (e) {
          e.q.author = j.user?.screen_name ?? e.q.author
          e.q.text = j.text ?? e.q.text
          e.q.links = linksOf(j)
        }
        const qt = j.quoted_tweet
        if (qt?.id_str) {
          const nid = String(qt.id_str)
          if (!info.has(nid)) {
            info.set(nid, { q: { id: nid, author: qt.user?.screen_name ?? "?", text: qt.text ?? "", links: linksOf(qt) }, quoteOf: id })
            order.push(nid)
          }
        }
      }
    }
    dlog(`quoted walk: ${info.size} unique, ${done.size} refetched`)
    for (const id of order) {
      if (postIds.has(id)) continue
      if (t.quoted.some((c) => c.id === id)) continue
      const e = info.get(id)
      if (e) t.quoted.push({ ...e.q, quoteOf: e.quoteOf })
    }
  }
  dlog(`build total: ms=${Date.now() - b0}`)
  return t
}

// --- 描画 ----------------------------------------------------------------------

function render(t: Thread, startId: string): string {
  const head = `[x-thread] @${t.posts[0].author} / ${t.posts.length} posts / root=${t.posts[0].id} / start=${startId}`
  const lines: string[] = [head]
  t.posts.forEach((p, i) => {
    lines.push("", `${i + 1}. ${p.id} · ${p.createdAt ?? "?"}`, expandLinks(p.fullText ?? p.text, p.links))
  })
  if (t.quoted.length) {
    lines.push("", `[x-thread] quoted by the thread (${t.quoted.length}):`)
    for (const q of t.quoted) {
      lines.push(`- ${q.id} · @${q.author} · quoted by ${q.quoteOf}`, `  ${expandLinks(q.text, q.links).replace(/\n/g, " ")}`)
    }
  }
  if (t.ancestors.length) {
    lines.push("", `[x-thread] start path between the start post and the root, by other authors (${t.ancestors.length}):`)
    for (const p of t.ancestors) {
      lines.push(`- ${p.id} · @${p.author} · ${p.createdAt ?? "?"} → ${p.parent ?? "-"}`, `  ${expandLinks(p.text, p.links).replace(/\n/g, " ")}`)
    }
  }
  if (t.replies.length) {
    lines.push("", `[x-thread] replies by others (${t.replies.length}):`)
    for (const p of t.replies) {
      lines.push(`- ${p.id} · @${p.author} · ${p.createdAt ?? "?"} → ${p.parent}`, `  ${expandLinks(p.text, p.links).replace(/\n/g, " ")}`)
    }
  }
  return lines.join("\n")
}

// --- プラグイン ----------------------------------------------------------------

export default {
  id: "x-thread",
  async setup(ctx: any) {
    // 起点ページは生 HTML で受け取る (差し替えるのでモデルには渡らない)。
    // ミラー / oembed URL は x.com の正規形に書き換えて実行させる。
    await ctx.tool.hook("execute.before", (event: any) => {
      try {
        if (event.tool !== "webfetch") return
        const target = statusTarget(String(event.input?.url ?? ""))
        if (!target) return
        if (target.fetchUrl !== event.input.url) {
          dlog(`canonicalize ${event.input.url} -> ${target.fetchUrl}`)
        }
        event.input = { ...event.input, url: target.fetchUrl, format: "html" }
      } catch {}
    })

    await ctx.tool.hook("execute.after", async (event: any) => {
      try {
        if (event.tool !== "webfetch" || event.status !== "completed") return
        const m = STATUS_URL.exec(String(event.input?.url ?? ""))
        if (!m) return
        const author = m[1]
        const startId = m[2]
        const r = event.result ?? {}
        const out = r.output ?? {}
        let html = typeof out.output === "string" && /html/i.test(String(out.contentType ?? "")) ? out.output : ""
        if (!html) html = await page(startId, author)

        const t = await build(startId, html)
        const chainOk = t.posts.every((p, i) => i === 0 || t.posts.some((q) => q.id === p.parent))
        const digest = render(t, startId)
        const tco = (digest.match(/https:\/\/t\.co\/\w+/g) ?? []).length
        dlog(
          `render: chain=${chainOk ? "ok" : "broken"} dupes=${t.posts.length - new Set(t.posts.map((p) => p.id)).size}`
            + ` t.co=${tco} start-included=${[...t.posts, ...t.ancestors, ...t.replies].some((p) => p.id === startId)}`
            + ` excluded=${t.excluded} notes=${t.posts.filter((p) => p.fullText).length} quoted=${t.quoted.length} replies=${t.replies.length}`,
        )
        event.result = { ...r, content: [{ type: "text", text: digest }] }
        if (process.env.X_THREAD_DEBUG === "1") {
          try {
            appendFileSync(
              process.env.X_THREAD_RENDER ?? "/tmp/opencode/x-thread-render.txt",
              `\n########## start=${startId} ##########\n${digest}\n`,
            )
          } catch {}
        }
      } catch (e) {
        // best-effort: webfetch 自体は壊さない。生 HTML をモデルへ流さない。
        try {
          const r = event.result ?? {}
          if (r?.output?.output) {
            event.result = { ...r, content: [{ type: "text", text: `[x-thread] failed to build thread: ${String(e).slice(0, 120)}` }] }
          }
        } catch {}
      }
    })
  },
}
