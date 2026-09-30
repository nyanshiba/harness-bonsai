# harness-bonsai

OpenCode v2 用ハーネス設定集。寝ている間にブレイクスルーが起きて、過去のものとなる可能性は大いにあり、既にカビが生えているかもしれない。だから俺がそうしたように、 Twitter の素晴らしい方々をヲチして、 arXiv や AlphaXiv の AI 研究論文に基づいて盆栽するんだぞ。気まぐれで覗いてしまっただけなら、果報は寝て待て。

ハーネス？何それおいしいの？な方は [ハーネス設計入門](https://speakerdeck.com/kinopeee/hanesu-sekkei-nyuumon-kontekisuto-no-tsugi) と [Chase 本人のハーネス論](https://x.com/hwchase17/status/2042978500567609738) を参照すべし。起床後も必要な知識だからね。

ここでは導入目的・動作環境の構築・反映方法のみを扱う。エージェント向けの実装契約とエビデンスは `README_for_agents.md` を参照。

## 導入目的

全部は入れなくてよい。目的別に 4 群に分けたが、Fowler だけは目的というよりは強制のための手段。  

### 文体矯正

| 何のため | 何を使う |
|---|---|
| チャット回答やドキュメントで おだてるな, 文語調 i-have-adhd, 追記するな, CoT 漏らすな, 俺が管理者だ, 見出しキモい, 常体で統一しろ といった指示は AGENTS.md だと無視されることが多いので、毎ターン hook して教育教育教育。 | `plugins/personality` |
| Anti slop hook。 personality があったら要らんかも。 | `plugins/writing-hints`, `skills/cat-writing`, `dsh-trim-cot-leakage` |
| チャッピー, 大学教授の講評, 陰謀論反転パロディでロールプレイング。こんなのに tokenmaxxing したせいで地球温暖化が進行。 | `skills/chappy-style`, `review-style`, `conspiracy-style` |

### Chase 派 Harness — コンテキスト整備による性能向上

正直、 Chase 的な Harness 、つまり記憶の管理をするつもりがなければモデルプロバイダ謹製ハーネスでリセットを正座待機したり、チャッピーや検索に居るジェミニと喋ればいいと思うよ。

| 何のため | 何を使う |
|---|---|
| [デフォルトのシステムプロンプト](https://github.com/anomalyco/opencode/tree/dev/packages/opencode/src/session/prompt/)の繰り返し表現を削除して、機能を維持したままコスト削減 | `agents/plan`, `build`, `build-auto` |
| ビルトインツールの websearch や webfetch 、ブックマークやタブを蓄積した [nyanshiba/workers/linkding-mcp](https://github.com/nyanshiba/workers/tree/main/linkding-mcp) での裏取り調査。セキュリティやコンテキスト希釈の都合上 subagent にやらせるが、コストは増すかも。 | `AGENTS.md`, `opencode.json` の permissions, `agents/websearch-researcher`, `linkding-researcher`, `commands/grounding`, `skills/linkding-search`, `surveyor` |
| セッションに別のプロジェクト(作業ディレクトリ)の skill やコンテキストを読ませ、触らせる | `plugins/session-move` |
| 別のセッションの文脈・動機を取得して、 Surrogation されまくった手の施しようのない Slop を、文体がキモいだけの修正可能な Slop に。現在のハーネスは電脳でもアミュスフィアでもないので、並列化で言外に意図を読み取ったり、アバターが不意に涙を流してしまうことで家族仲を円滑にすることはないよ。 | `plugins/handoff`, `skills/motive-salvage` |
| 会話のコンテキストを**ユーザーのプロンプト付き**で [Cloudflare Temporary Accounts](https://blog.cloudflare.com/ja-jp/temporary-accounts/) で公開。真意を隠して出力だけ公開するから Slop って言われんだよ。 | `skills/publish-cot` |

### Fowler 派 Harness — 機械的介入による信頼性向上

AGENTS.md に書いたのに○○しやがった(してくれなかった)！を仕組みで解決。

| 何のため | 何を使う |
|---|---|
| 各 agents のガードレール | `opencode.json` の permissions |
| `opencode2 service restart` 実行を阻止 | `plugins/service-guard` |
| Webfetch エラーハンドリング。ハルシネーションで回答せず、セキュリティ担当者(俺)に訊いてポリシー解除を待つ | `plugins/tool-hints` |
| [Spotify shunt](https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90) の事例を参考にしたトークン節約 PoC 。 subagents *-researcher のコーディング版。 | `plugins/delegate-guard`, `agents/bulk-reader`, `commands/bulk-read` |

### HITL から HOOTL へ

| 何のため | 何を使う |
|---|---|
| LLM に全幅の信頼を置き、生身は移動, 仕事, 料理, 風呂などに勤しむ。娯楽しながらや安眠は難しいかも。 Codex でいうところのフルアクセス | `opencode.json の build-auto permissions` |
| 同じディレクトリ・ファイルについて何度も ask される煩わしさを1回にする | `plugins/ask-once` |
| rate-limit 時に固定動作させたいやんごとなき理由があるとか | `plugins/rate-limit-command`, `opencode.json` の plugins.options.command |
| [@am09_21](https://x.com/am09_21/status/2097596822134968603) の 2. を参考に、人間とAIを分離し、外側は人間が査読するだけにして定期実行と採否判定を自動化する。ぶっちゃけそんなネタないし 1. をやるべきだったかも。 | `agents/feed-triage`, `commands/feed-triage`, `cli.json` の loop plugin |

### 具体的なユースケース

- ggrks や Meat Proxy 対応  
プロジェクト `~/plan` で新規セッション -> agents/plan を選択 -> `@chappy-style <くだらない内容> って確か linkding にあったと思うんだ。証拠が乏しかったら websearch で grounding してね。` -> plugins/personality が自動で適用される -> GPT-4o みたいなノリで回答 -> agents/build に切り替え -> `@publish-cot` -> `https://repo.random.workers[.]dev/report` で公開 -> 結果を相手に Meat Proxy し、諦めてやる気を出してもらう
- 永遠の思春期対応  
(このツイートやばいな。とはいえ俺の主張も一辺倒ではあるんだよなぁ) -> `https://x[.]com/user/status/XXXXX ○○なのかリサーチして結論付けよ。` -> subagents websearch-researcher が呼ばれる -> 回答が俺より辛辣だったので、 AI の責任で `@publish-cot` してネットのおもちゃに

もっと有益な用途があったはずだが、何だっけ……。

## 構成

> [!IMPORTANT]
> 盆栽を始める前に、先に動作環境の構築とサービスの起動確認まで済ませること。

- `~/`
  - [`.agents/skills/`](https://github.com/nyanshiba/skills) — OpenCode 以外でも使える skills のグローバル設定。再起動不要で反映。 `opencode.json` の permissions (`~/.agents/skills/**` と `~/*/.agents/skills/**` の allow) で全 agents に参照を許可。
  - `.config/opencode/` — グローバル設定
    - `AGENTS.md` — 以下ファイル監視で即時反映。
    - `agents/` — エージェントモード固有の system prompt だけ Markdown に。ユーザーが選ぶ primary エージェントなのか subagent 専用か、 permissions などは `opencode.json` で一元管理。
    - `commands/` — 
    - `opencode.json` — plugins の適用 (絶対パスなので環境に合わせて), agents, providers, permissions, mcp 設定。特に providers はクラウド LLM 乞食必見。
      ```sh
      # 反映
      opencode2 reload
      ```
    - `cli.json` — CLI プラグイン (`@prevalentware/opencode-loop-plugin`)。`/loop` を提供
    - `plugins/` — OpenCode 固有のサーバープラグイン。サーバー側で動くため TUI・Web・API の全クライアントから有効になる (`@opencode/plugin/tui` の CLI プラグインとは別物で、ここには置かない)。動作には、各ディレクトリで依存関係のインストール `bun install` が必須 (`npm install` でもよい)。
      ```sh
      export PATH="$HOME/.bun/bin:$PATH"
      for d in ~/.config/opencode/plugins/*/; do (cd "$d" && bun install); done
      ```

      故障時の切り分けは以下である。
      - `active` にならない → `~/.local/share/opencode/log/opencode.log` で `failed to load plugin` を検索。`cause` に理由が出る
      - チャット送信後に止まる → 同ログで `Failed to drain Session` を検索。`Schema validation failed` ならフックの注入形状不良、課金系ならプロバイダー側の問題でプラグイン無関係
      - 1件ずつ外して再起動→疎通確認で特定する
    - `service.json` — [出先で OpenCode を使う](#動作環境の構築)
  - `health/opencode.json` — 医学文献を漁る用の MCP が色々。
  - `llama/opencode.json` — ローカルLLM llama.cpp への OpenAI 互換 provider 定義。`websearch` は許可制。接続先は利用者側の endpoint に書き換える
  - `playwright/opencode.json` — headless Chromium による全文取得用。`--isolated`・`--headless`
- `/etc/` — 主に IPv6 環境向けのネットワーク調整。反映:
    ```sh
    sysctl --system
    systemctl restart systemd-networkd
    ```
  - `sysctl.d/rfc8981.conf` — TEMP_VALID_LIFETIME 短縮と TCP パフォーマンスチューニング
  - `systemd/network/eth0.network.d/rfc7217.conf` RFC 7217 によるセキュリティ

### リポジトリの取得

既定ブランチが `opencode2` のため `-b` を明示する。

```sh
git clone -b opencode2 https://github.com/nyanshiba/harness-bonsai.git ~/harness-bonsai
git clone https://github.com/nyanshiba/skills.git ~/skills
```

## 動作確認環境

- Fedora 44 以降の root シェル (確認済みは Container Image、`systemd` 259、`dnf5`)。`systemd-networkd` が `eth0.network` を管理している
- 外向き HTTPS が可能である (GitHub・bun シェルスクリプト・npm レジストリに到達できる)
- `bun` 1.4.2、`git` 2.55.0、`opencode` v2.0.20 (別ホストの v2.0.14 でも同一構成で動作)
- リポジトリ `opencode2` ブランチ、コミット `d43eb7c`
- `skills` リポジトリ `main` ブランチ、コミット `228a8bf`

## 動作環境の構築

### 基礎パッケージ

```sh
dnf install -y git unzip rsync
```

`curl` と `xz` は Fedora Container Image に同梱されている。欠ける場合は `dnf install -y curl xz` を追加する。

### bun

```sh
curl -fsSL https://bun.com/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun --version
```

`bun.com` が公式ドメインである (`bun.sh` は旧別名。Windows のみ `bun.sh/install.ps1` 表記が残るためそちらを使う)。

`~/.bash_profile` に PATH が追加されるため、次回ログイン以降は `export` 不要である。

### opencode

```sh
export PATH="$HOME/.bun/bin:$PATH"
bun install -g --trust @opencode/cli
opencode --version
```

`opencode` と `opencode2` は同一バイナリへのリンクである。どちらで起動してもよい。

### サービスの起動と確認

```sh
export PATH="$HOME/.bun/bin:$PATH"
opencode2 service start
opencode service status
cat ~/.config/opencode/service.json
```

初回起動時に `service.json` が自動生成される。
```json
{
  "password": "opencode",
  "hostname": "0.0.0.0"
}

```
出先からアクセスするために、同一ホストで `cloudflared tunnel` (`tunnel run`、`--url` を含む) を動かす場合は、既定の localhost のままでよい。  
Connector モードや [Workers VPC via Mesh](https://github.com/nyanshiba/workers/tree/main/opencode) で使う場合は `0.0.0.0` で LISTEN する必要がある。

## 付録 移植メモ

他ハーネスへの持ち運び用の分類である。共通規格から移す順序で使う。

- 共通規格 (Markdown指示文・SKILL・MCP定義として移植可能) — `AGENTS.md`、`agents/build`, `build-auto`, `feed-triage`、`commands/grounding`、`skills` 全部
- opencode 固有 (`@opencode-ai/plugin` の hook・permission・API形状に依存) — `opencode.json` 本体、`plugins` 全部
- 両義 (本文は共通・配線が固有) — `opencode.json` 内 MCP 定義、`agents/plan`, `bulk-reader`, `websearch-researcher`, `linkding-researcher`、`commands/bulk-read`, `feed-triage`
