# SFTP: 多段 SSH セッションを共有する 2 ペインファイラー
Labels: priority:P1, area:files, area:ssh, enhancement

## 背景

サーバーメンテナンスでは WinSCP 相当の安全なファイル転送が必要。既存の多段接続と認証を再利用したい。

## 受け入れ条件

- [ ] 既存 session 上で SFTP subsystem を開き、再認証しない
- [ ] local / remote の一覧、移動、upload、download ができる
- [ ] queue、進捗、cancel、失敗時 retry を表示する
- [ ] symlink、permission、上書き、path traversal を安全に扱う
- [ ] terminal の隣の pane として開ける
