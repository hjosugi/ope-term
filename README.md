# ope-term

運用者と開発者のための、**SSH 経路が見える**デスクトップターミナルです。

`~/.ssh/config` の Host をピースのように並べ、踏み台から接続先までを組み立てます。Host を 1 台だけ置いた場合は `ProxyJump` を自動展開し、明示的に複数台を置いた場合はその順番で `direct-tcpip` トンネルを作ります。

> [!WARNING]
> 現在は v0.1.0 alpha です。公開鍵/ssh-agent 認証と strict `known_hosts` 検証に対応していますが、パスワード・keyboard-interactive・暗号化秘密鍵の入力 UI は未実装です。日常運用へ投入する前に制約を確認してください。

## いま動くもの

- Tauri 2 + Rust (`russh`) + xterm.js 6
- OpenSSH config の Host / HostName / User / Port / IdentityFile / ProxyJump / wildcard / negation
- `ssh-agent`（Unix）と秘密鍵による SSH2 認証
- `known_hosts` の厳格なホスト鍵検証（unknown / changed は拒否）
- ProxyJump 自動展開と、任意に組んだ多段ルート
- hop ごとの connecting / connected / error 表示
- 複数セッションのタブ切替、端末リサイズ、切断
- `Ctrl+Shift+P` の fuzzy コマンドパレット
- UI で変更できるキーボードショートカット
- WebGL レンダラと安全なフォールバック
- Tauri IPC Channel を使った端末出力ストリーミング

## 起動

前提は Node.js 22 以上、Rust 1.85 以上と、Tauri が各 OS で必要とするシステムパッケージです。Linux の WebKitGTK を含む詳細は [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) を参照してください。

```bash
npm ci
npm run tauri dev
```

フロントエンドと Rust の検証:

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

## SSH config

接続の正本は `~/.ssh/config` です。ope-term 専用にホスト情報を複製しません。

```sshconfig
Host bastion
  HostName bastion.example.com
  User operator
  IdentityFile ~/.ssh/id_ed25519

Host prod-db
  HostName 10.20.0.15
  User admin
  ProxyJump bastion
```

初回接続先は、先に OpenSSH CLI でホスト鍵を確認して `known_hosts` へ登録してください。

```bash
ssh prod-db
```

ope-term は未知のホスト鍵を自動承認しません。鍵が変わった場合も接続を拒否します。

## ルートの組み方

1. 左の Host をクリックするか ROUTE WORKBENCH へドラッグします。
2. 1 ピースなら、その Host の `ProxyJump` を自動展開します。
3. 2 ピース以上なら、ピースを並べた順で明示ルートとして接続します。
4. `CONNECT` または `Ctrl+Enter` で接続します。

明示ルートは `jump-a → jump-b → target` の各区間を SSH `direct-tcpip` で接続します。各 hop は個別に認証されます。

## コマンドとショートカット

| 既定キー | コマンド |
|---|---|
| `Ctrl+Shift+P` | Command Palette |
| `Ctrl+K` | Host 検索 |
| `Ctrl+Enter` | 現在のルートへ接続 |
| `Ctrl+Backspace` | ルートをクリア |
| `Ctrl+N` | 新しいルート |
| `Ctrl+W` | 現在のセッションを閉じる |
| `Ctrl+Tab` | 次のセッション |
| `Ctrl+Shift+K` | Keyboard Shortcuts |

Command Palette で `Keyboard Shortcuts` を開き、キー欄をクリックして新しい組み合わせを入力できます。変更は Tauri WebView のローカルストレージへ保存されます。

## セキュリティ方針

- 対応プロトコルは SSH2 のみです。SSH1 / rlogin は実装しません。
- telnet / serial は運用上の需要を確認し、平文警告や権限制御を設計してから別 transport として検討します。
- WebView は Node.js 権限を持ちません。Tauri capability は `core:default` のみに絞っています。
- リモート出力は Rust から Channel 経由で xterm に渡し、HTML として挿入しません。
- ホスト鍵の初回信頼ダイアログが入るまでは、CLI での事前確認を必須とします。

脆弱性の報告は [SECURITY.md](SECURITY.md) を参照してください。

## 設計とロードマップ

- [アーキテクチャ](docs/ARCHITECTURE.md)
- [性能・安定性のゲート](docs/PERFORMANCE.md)
- 未実装項目は [GitHub Issues](https://github.com/hjosugi/ope-term/issues) で管理

## ライセンス

[MIT](LICENSE)
