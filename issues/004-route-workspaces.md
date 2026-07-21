# Route workspaces: 経路・タブ・レイアウトの保存と復元
Labels: priority:P1, area:ui, enhancement

## 背景

毎日の保守で同じ踏み台と接続先を組み直さず、案件や環境単位でワークスペースを再利用したい。

## 受け入れ条件

- [ ] 明示 route に名前を付けて保存できる
- [ ] Host 情報を複製せず alias の参照だけを保存する
- [ ] 起動時に前回のタブとレイアウトを復元できる
- [ ] 接続は自動実行せず、復元後にユーザーが開始する
- [ ] config 変更で alias が消えた場合に安全な degraded state を表示する
