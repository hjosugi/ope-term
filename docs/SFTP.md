# SFTP file manager

接続済み terminal で `Ctrl+Shift+F`、または Command Palette の
`SFTP file manager を開く / 閉じる` を実行すると、terminal の右隣に local / remote の
2 ペインファイラーを開きます。

SFTP は最終 hop の認証済み SSH handle に subsystem channel を追加します。新しい TCP 接続や
再認証は行わず、terminal の PTY channel と同じ多段ルートを共有します。

## 操作

1. `LOCAL` で操作を許可する local directory を選びます。
2. local / remote の directory はダブルクリックで移動し、`↑` で親へ、`↻` で再読込します。
3. local file を選んで `UPLOAD →`、または remote file を選んで `← DOWNLOAD` を押します。
4. 同名 file がある場合だけ上書き確認が出ます。転送は queue の先頭から 1 件ずつ実行します。
5. 実行中は byte 数と進捗率を表示します。`CANCEL` は一時 file を削除し、`RETRY` は新しい
   transfer ID で同じ項目を queue に戻します。

現時点では file の upload / download が対象です。directory の再帰転送、rename、削除、作成、
permission 変更は行いません。

## 安全性

- WebView から任意の local path は渡せません。native folder picker が Rust core に不透明な
  token を登録し、以後はその root 配下の相対 path だけを受け付けます。
- `..`、absolute path、NUL、symlink 経由で選択 root の外へ出る操作を Rust 側で拒否します。
- upload 元の local symlink と、既存 symlink への上書きを拒否します。remote symlink の
  download は追加確認後に実体を解決します。
- 転送先へ直接書かず、同じ directory の `.part` file へ stream した後に rename します。
  上書き時は既存 file を一時退避し、rename 失敗時は復元します。確定前の失敗では `.part` を
  削除し、まれに復元自体が失敗した場合は、残した backup path を error に明示します。
- remote entry の permission を一覧に表示します。既存 remote file の上書き時は permission を
  引き継ぎます。
- file 全体を memory に載せず 256 KiB chunk で stream します。

!!! warning "切断と再接続"

    転送中に session を閉じた場合は cancel されます。transport 断後の自動再接続では新しい
    SSH/SFTP session になるため、失敗した項目は接続完了後に `RETRY` してください。途中 byte
    からの resume はまだ対応していません。
