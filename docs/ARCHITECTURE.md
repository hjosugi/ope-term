# Architecture

ope-term は、秘密鍵・SSH セッション・トンネルを Rust 側に閉じ込め、WebView は端末表示と操作だけを担当します。

```text
~/.ssh/config
      │ parse / resolve (first obtained value wins)
      ▼
Route builder ── explicit route or ProxyJump expansion
      │
      ▼
Rust session task (one task per terminal)
  russh handle ─ direct-tcpip ─ final authenticated handle
      │                         ├─ PTY / shell channel ─ terminal bytes
      │                         └─ SFTP subsystem ─ list / streamed transfer
      │                                      │
      └──────────── typed Tauri IPC ──────────┘
                                             ▼
                              xterm.js + SFTP file manager
```

## 境界

### Rust core

- `ssh_config.rs`: OpenSSH config の読み込み、first-match-wins 解決、ProxyJump 展開、循環検出
- `ssh.rs`: known_hosts 検証、認証、多段トンネル、PTY、入出力、keepalive
- `sftp.rs`: SFTP 一覧、chunk 転送、一時 file と rollback、symlink 検証
- `local_files.rs`: native picker が許可した local root と相対 path の境界検証
- `local_terminal.rs`: Windows ConPTY / Unix PTY、検出 shell profile、child kill + wait
- `session_log.rs`: output-only bounded writer、世代 rotation、bounded streaming search
- `transport.rs`: terminal 共通の input / resize / close と SSH 固有 capability の境界
- `lib.rs`: 最小の Tauri command と transport 共通のセッション registry

各セッションは独立した Tokio task です。端末操作、ホスト鍵応答、認証応答は用途別の bounded `mpsc`、出力とhop状態・確認promptは Tauri IPC Channel で運びます。認証値を通常のterminal input channelへ混ぜず、セッション終了時は待機中の確認もcancelします。大量データ向けでない Tauri event bus は端末出力に使いません。

interactive terminal の input / resize / close は transport 共通 command ですが、host-key、認証、
ProxyJump、SFTP は SSH 専用 capability です。候補 transport と安全境界は
[Transport boundary](TRANSPORTS.md) に記録しています。

### WebView

- `main.ts`: route builder、タブ、xterm lifecycle、コマンドレジストリ
- `route.ts`: 明示ルートと ProxyJump preview の純粋関数
- `workspaces.ts`: 保存ルートと復元タブの正規化・境界値・永続化（alias 参照のみ）
- `keybindings.ts`: ショートカットの正規化と永続化
- `fuzzy.ts`: Host / command / shortcut の共通 fuzzy ranking
- `auth-secrets.ts`: 認証入力欄と短命な応答配列の明示消去
- `sftp-ui.ts`: 2 ペイン一覧と直列 transfer queue、進捗、cancel、retry

WebView はファイルシステム、ソケット、鍵へ直接アクセスできません。SFTP の local 操作は native
folder picker が Rust core に登録した不透明 token と、その root 配下の相対 path だけを使います。
local terminal も program / argument を WebView から受け取らず、Rust が列挙した profile ID と
picker token だけを受け付けます。

タブは接続から独立したUI識別子を持ち、接続ごとの backend session id とは別に管理します。復元したタブと切断済みタブは `idle` / `closed` 状態のまま同じ端末バッファを保持し、操作者が接続を開始したときだけ新しい backend session id を割り当てます。古い接続から遅れて届いた event は id 不一致で破棄します。

セッション終了時は理由を `local` / `remote` / `transport` / `failed` に分けて UI へ渡します。channel の close は `remote`、close なしで channel が終わった場合（keepalive timeout、ネットワーク断、shell 実行中の I/O 失敗）は `transport`、shell へ到達する前の失敗は `failed` です。自動再接続は `transport` だけを対象にし、未送信の入力は切断時に破棄して新しい shell へ再送しません。

## 接続シーケンス

1. UI が route、初期 cols/rows、IPC Channel を `connect_session` に渡す。
2. Rust が 1 ピースの route を ProxyJump 展開する。2 ピース以上なら明示順を使う。
3. 先頭 hop に TCP 接続して `known_hosts` を照合する。未知鍵は UI へ SHA256 fingerprint を提示して応答を待ち、変更鍵は既存行番号を示して拒否する。
4. 「信頼して保存」が選ばれた場合だけ `~/.ssh/known_hosts` へ追記してから認証する。「今回のみ」はファイルを変更しない。
5. 各hopでサーバーのremaining methodsに従い、agent/公開鍵、keyboard-interactive、passwordを試す。暗号化鍵、password、keyboard-interactiveは要求元hop付きのpromptをUIへ送り、5分以内の使い捨て応答を待つ。
6. 次 hop があれば `channel_open_direct_tcpip` を開き、その `ChannelStream` を次の `russh::client::connect_stream` へ渡す。
7. 最終 hop で PTY と shell を要求する。
8. `tokio::select!` で UI command と SSH channel message を処理する。
9. 初回 SFTP 操作時だけ、最終 hop の同じ認証済み handle で subsystem channel を遅延作成する。
10. 終了時は転送を cancel し、最終 hop から逆順に disconnect する。

## 故障分離

現時点ではセッションごとに task と channel を分離しています。1 セッションの通常エラーは他セッションへ波及しません。一方、同一 Rust process 内の panic をプロセス境界で隔離するものではありません。panic isolation、crash recovery、session restore は issue で追跡します。

## OpenSSH 互換範囲

実装済み: `Host`, `Match`, `Include`, `HostName`, `User`, `Port`, `IdentityFile`,
`CertificateFile`, `IdentitiesOnly`, `ProxyJump`, `HostKeyAlias`, token、`*`, `?`, `!`, `Key=Value`。
Include は循環と 32 階層を検査し、全 config 8 MiB / 1024 file、1 glob 1024 match の
budget 内で lexical order に読み込みます。

未実装: `CanonicalizeHostname` と OpenSSH config 全 directive / token の完全互換。互換範囲外は
黙って安全性を弱めず、issue 単位で追加します。
