# Route workspaces: 経路・タブ・レイアウトの保存と復元
Labels: priority:P1, area:ui, enhancement

## 背景

毎日の保守で同じ踏み台と接続先を組み直さず、案件や環境単位でワークスペースを再利用したい。

## 受け入れ条件

- [x] 明示 route に名前を付けて保存できる
- [x] Host 情報を複製せず alias の参照だけを保存する
- [x] 起動時に前回のタブとレイアウトを復元できる（タブ順と選択タブまで。pane レイアウトは #5 の実装後に追加する）
- [x] 接続は自動実行せず、復元後にユーザーが開始する
- [x] config 変更で alias が消えた場合に安全な degraded state を表示する

workspace storeはJSON parse / write前に1 MiBで停止し、破損・無効・quota不足のstorageは
terminal操作を止めず現在の起動中だけのstateへdegradeする。
