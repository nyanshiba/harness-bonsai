---
description: feed/ 内の未処理メモを吟味し採否返信を書く（バックグラウンド実行）
agent: feed-triage
---

$ARGUMENTS（省略時は ./feed）を対象に、inbox 内の未処理メモを吟味し、replies/ に採否返信を書け。処理済みの判定は replies/ 側の同名ファイルの有無で行う。規約の詳細は feed-triage エージェント定義に従う。
