# Session logs: 明示変数・ローテーション・fzf 風検索ビューア
Labels: priority:P2, area:terminal, enhancement

## 背景

監査と障害調査のためにログが必要だが、秘密値の混入と巨大ファイルの UI freeze を避ける必要がある。

## 受け入れ条件

- [x] host/user/date/time の固定変数を UI と文書に一覧表示する
- [x] host 別 enable、保存先、timestamp、rotation を設定できる
- [x] 100 MB 以上を全読み込みせず検索・表示する
- [x] fuzzy filter と exact/regex search を切り替えられる
- [x] password prompt 等の sensitive input を記録しない

## 実装メモ

- host / local profile ごとの policy だけを localStorage に保存し、directory token は永続化しない。
- terminal output だけを bounded queue から専用 writer thread へ送り、input と認証 IPC は渡さない。
- writerのI/O停止はterminal / toastへ一度通知し、loggerだけを切り離してsession本体は継続する。
- 1–1024 MiB、1–20 世代の rotation。file template は固定4変数と `.log` suffix に制限する。
- viewer は `.log` / `.log.N` のみ、64 KiB reader / 4 KiB line / 500 results の上限で逐次走査。
- 100 MiB sparse fixture の末尾 exact search、巨大1行、fuzzy、regex、rotation を Rust test で検証。
