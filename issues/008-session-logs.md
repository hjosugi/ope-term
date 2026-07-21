# Session logs: 明示変数・ローテーション・fzf 風検索ビューア
Labels: priority:P2, area:terminal, enhancement

## 背景

監査と障害調査のためにログが必要だが、秘密値の混入と巨大ファイルの UI freeze を避ける必要がある。

## 受け入れ条件

- [ ] host/user/date/time の固定変数を UI と文書に一覧表示する
- [ ] host 別 enable、保存先、timestamp、rotation を設定できる
- [ ] 100 MB 以上を全読み込みせず検索・表示する
- [ ] fuzzy filter と exact/regex search を切り替えられる
- [ ] password prompt 等の sensitive input を記録しない
