# SSH 認証: password / keyboard-interactive / 暗号化秘密鍵の入力 UI
Labels: priority:P0, area:ssh, security

## 背景

v0.1 は Unix ssh-agent とパスフレーズなし秘密鍵だけを扱う。MFA、踏み台の OTP、暗号化秘密鍵を使う現場では接続できない。

## 方針

- Rust から UI へ認証 prompt を送り、回答は使い捨て IPC で返す
- password、keyboard-interactive の複数 prompt、秘密鍵 passphrase を区別する
- 値を JS state、ログ、エラー、localStorage に残さない
- cancel と timeout を hop 単位で扱う

## 受け入れ条件

- [x] password 認証で接続できる
- [x] 複数問の keyboard-interactive（OTP 含む）に回答できる
- [x] 暗号化 OpenSSH 秘密鍵を開ける
- [x] 入力値が DevTools、ログ、panic payload に出ないことをテストする
- [x] 多段接続のどの hop が要求しているか UI に表示する

暗号化鍵の読込/KDFはTokio connection taskからblocking poolへ分離し、移動したpassphraseも
drop時にzeroizeする。認証中のterminal入力はshellへ持ち越さない。秘密鍵・証明書は通常fileかつ
各1 MiB以下、hostごとの設定候補とssh-agentの認証試行は各64件までに制限する。
