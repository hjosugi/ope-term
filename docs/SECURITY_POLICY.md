# セキュリティ方針

境界の詳細と残存リスクは [脅威モデル](THREAT_MODEL.md)、端末固有の判断は
[端末セキュリティレビュー](TERMINAL_SECURITY.md)、依存の advisory 判断は
[依存 advisory レビュー](SECURITY_ADVISORIES.md) にあります。

## プロトコル

- 対応プロトコルは SSH2 のみです。SSH1 / rlogin は実装しません。
- telnet / serial は未実装です。需要確認と安全 gate は
  [Transport boundary](TRANSPORTS.md) に固定し、平文警告・credential 非永続化・macro 無効化を
  同時実装できるまで接続入口を追加しません。
- `russh` の未修正 RSA 依存を出荷しないため、RSA 秘密鍵認証と RSA のみの host key を
  無効化しています。

## WebView の権限

- WebView は Node.js 権限を持ちません。Tauri capability は `core:default` のみに絞っています。
- リモート出力は Rust から Channel 経由で xterm に渡し、HTML として挿入しません。
- リモートの OSC 8 リンクは開かず、window 操作と clipboard 連携を無効化しています。
- CSP はローカル資産のみを許可し、`scripts/security-policy.mjs` が CI で逸脱を検出します。
- SFTP の local filesystem 操作は WebView へ一般権限を与えず、native picker で選択した root の
  不透明 token と相対 path を検証する Rust command に限定します。transfer IDはtask生成前に
  検証し、同時transferはSSH sessionごとに8件で停止します。
- Local terminal は任意 executable / argument を IPC で受け付けず、Rust が検出した固定 shell
  profile ID だけを起動します。working directory は native picker token で指定します。
- SSH / local terminal のsession IDはfrontendが生成するcanonical UUIDだけを受理し、Rust registryは
  同時64件で停止します。壊れたUIやWebViewから無制限にtaskを生成できません。
- host-key / auth promptのrequest IDとnative picker tokenもRustが発行するcanonical形式だけを
  受理し、任意長の識別子をregistryやprompt queueへ渡しません。
- Session log は既定無効かつ output-only です。保存・検索先は native picker token に限定し、
  viewer は `.log` と rotation 世代だけを bounded buffer で読みます。

## 秘密情報

- 秘密鍵、known_hosts、ソケット、SSH handle は Rust core だけが扱います。
- password、OTP、秘密鍵 passphrase は永続化・ログ出力せず、認証専用の使い捨て IPC でだけ
  渡します。
- 未知のホスト鍵は SHA256 fingerprint を確認するまで接続せず、変更された鍵は常に拒否します。
- `known_hosts` は通常fileかつ16 MiB以下、証明書・秘密鍵は通常fileかつ各1 MiB以下に制限し、
  `IdentityFile` / `CertificateFile` 候補はhostごとに各64件で停止します。SSH config、trust store、
  証明書・秘密鍵の同期I/Oと暗号化鍵KDFはasync connection taskを占有しないblocking poolで
  実行し、blocking taskへ渡したpassphraseもdrop時にzeroizeします。

## 永続化

- WebView が保存するのはキーボードショートカットと、ルート・タブの alias 参照だけです。
  接続情報も認証情報も複製しません。
- 保存内容は読み込み時に再検証し、件数・hop 数・名前長を上限で丸めます。破損したストレージは
  空のワークスペースに degrade し、起動を妨げません。
- private mode、quota不足、WebView設定でストレージが利用できない場合も起動とterminal操作は
  継続します。変更は現在の起動中だけ保持し、保存できなかったことをUIで通知します。
- 復元したタブは接続を自動で開始しません。

## 報告

脆弱性の報告手順は、リポジトリの
[SECURITY.md](https://github.com/hjosugi/ope-term/blob/main/SECURITY.md) を参照してください。
公開 issue には投稿せず、GitHub の private vulnerability reporting を使ってください。
