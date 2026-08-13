# SFTP: 多段 SSH セッションを共有する 2 ペインファイラー
Labels: priority:P1, area:files, area:ssh, enhancement

## 背景

サーバーメンテナンスでは WinSCP 相当の安全なファイル転送が必要。既存の多段接続と認証を再利用したい。

## 受け入れ条件

- [x] 既存 session 上で SFTP subsystem を開き、再認証しない
- [x] local / remote の一覧、移動、upload、download ができる
- [x] queue、進捗、cancel、失敗時 retry を表示する
- [x] symlink、permission、上書き、path traversal を安全に扱う
- [x] terminal の隣の pane として開ける

## 実装メモ

- 最終 hop の認証済み `russh` handle に SFTP subsystem channel を遅延作成し、PTY と共有する。
- local root は native folder picker で選び、Rust 内の token と相対 path で scope を強制する。
- transfer は 256 KiB chunk、UIは同一 session 内で直列 queue。Rust coreもtask生成前にIDを検証し、
  同時transferをsessionごとに8件で拒否する。同じlocal / remote fileの並行利用も拒否する。
  upload元を実際にopenして通常fileと確認してから、一時 file + rename と backup rollback を使う。
- queue itemをconnection IDへ固定し、再接続後の暗黙転送を拒否。directory一覧は世代番号で
  古い応答を破棄する。
- UI queueは100件、完了履歴は20件に制限し、長時間sessionでもDOMとmemoryをboundedに保つ。
- remote一覧は`READDIR` response単位で処理し、10,000件または4 KiB超のentry名でhandleを閉じる。
- 一覧channel開始は30秒timeout、`READDIR` taskはterminal loopから分離し、同時一覧を4件に制限する。
- local / remote一覧の名前sortはallocation-freeのASCII case-fold比較を共有する。
- `just check`（frontend / Rust tests、clippy、production build）と`pnpm run security:policy`、
  `just docs` を通過。
