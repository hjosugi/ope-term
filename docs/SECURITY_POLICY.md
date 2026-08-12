# セキュリティ方針

境界の詳細と残存リスクは [脅威モデル](THREAT_MODEL.md)、端末固有の判断は
[端末セキュリティレビュー](TERMINAL_SECURITY.md)、依存の advisory 判断は
[依存 advisory レビュー](SECURITY_ADVISORIES.md) にあります。

## プロトコル

- 対応プロトコルは SSH2 のみです。SSH1 / rlogin は実装しません。
- telnet / serial は運用上の需要を確認し、平文警告や権限制御を設計してから
  別 transport として検討します。
- `russh` の未修正 RSA 依存を出荷しないため、RSA 秘密鍵認証と RSA のみの host key を
  無効化しています。

## WebView の権限

- WebView は Node.js 権限を持ちません。Tauri capability は `core:default` のみに絞っています。
- リモート出力は Rust から Channel 経由で xterm に渡し、HTML として挿入しません。
- リモートの OSC 8 リンクは開かず、window 操作と clipboard 連携を無効化しています。
- CSP はローカル資産のみを許可し、`scripts/security-policy.mjs` が CI で逸脱を検出します。
- SFTP の local filesystem 操作は WebView へ一般権限を与えず、native picker で選択した root の
  不透明 token と相対 path を検証する Rust command に限定します。

## 秘密情報

- 秘密鍵、known_hosts、ソケット、SSH handle は Rust core だけが扱います。
- password、OTP、秘密鍵 passphrase は永続化・ログ出力せず、認証専用の使い捨て IPC でだけ
  渡します。
- 未知のホスト鍵は SHA256 fingerprint を確認するまで接続せず、変更された鍵は常に拒否します。

## 永続化

- WebView が保存するのはキーボードショートカットと、ルート・タブの alias 参照だけです。
  接続情報も認証情報も複製しません。
- 保存内容は読み込み時に再検証し、件数・hop 数・名前長を上限で丸めます。破損したストレージは
  空のワークスペースに degrade し、起動を妨げません。
- 復元したタブは接続を自動で開始しません。

## 報告

脆弱性の報告手順は、リポジトリの
[SECURITY.md](https://github.com/hjosugi/ope-term/blob/main/SECURITY.md) を参照してください。
公開 issue には投稿せず、GitHub の private vulnerability reporting を使ってください。
