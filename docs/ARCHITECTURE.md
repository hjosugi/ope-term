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
  russh handle ─ direct-tcpip ─ russh handle ─ session channel
      │                                      │
      │ hop state                            │ terminal bytes
      └──────────── Tauri IPC Channel ───────┘
                                             ▼
                                 xterm.js + WebGL fallback
```

## 境界

### Rust core

- `ssh_config.rs`: OpenSSH config の読み込み、first-match-wins 解決、ProxyJump 展開、循環検出
- `ssh.rs`: known_hosts 検証、認証、多段トンネル、PTY、入出力、keepalive
- `lib.rs`: 最小の Tauri command とセッション registry

各セッションは独立した Tokio task です。入力・リサイズ・終了とホスト鍵への応答は用途別の bounded `mpsc`、出力と hop 状態・ホスト鍵確認は Tauri IPC Channel で運びます。大量データ向けでない Tauri event bus は端末出力に使いません。

### WebView

- `main.ts`: route builder、タブ、xterm lifecycle、コマンドレジストリ
- `route.ts`: 明示ルートと ProxyJump preview の純粋関数
- `keybindings.ts`: ショートカットの正規化と永続化
- `fuzzy.ts`: Host / command / shortcut の共通 fuzzy ranking

WebView はファイルシステム、ソケット、鍵へ直接アクセスできません。

## 接続シーケンス

1. UI が route、初期 cols/rows、IPC Channel を `connect_session` に渡す。
2. Rust が 1 ピースの route を ProxyJump 展開する。2 ピース以上なら明示順を使う。
3. 先頭 hop に TCP 接続して `known_hosts` を照合する。未知鍵は UI へ SHA256 fingerprint を提示して応答を待ち、変更鍵は既存行番号を示して拒否する。
4. 「信頼して保存」が選ばれた場合だけ `~/.ssh/known_hosts` へ追記してから認証する。「今回のみ」はファイルを変更しない。
5. 次 hop があれば `channel_open_direct_tcpip` を開き、その `ChannelStream` を次の `russh::client::connect_stream` へ渡す。
6. 最終 hop で PTY と shell を要求する。
7. `tokio::select!` で UI command と SSH channel message を処理する。
8. 終了時は最終 hop から逆順に disconnect する。

## 故障分離

現時点ではセッションごとに task と channel を分離しています。1 セッションの通常エラーは他セッションへ波及しません。一方、同一 Rust process 内の panic をプロセス境界で隔離するものではありません。panic isolation、crash recovery、session restore は issue で追跡します。

## OpenSSH 互換範囲

実装済み: `Host`, `HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump`, `*`, `?`, `!`, `Key=Value`。

未実装: `Include`, `Match`, `CanonicalizeHostname`, `HostKeyAlias`, `CertificateFile`, token expansion の完全互換。互換範囲外は黙って安全性を弱めず、issue 単位で追加します。
