# ope-term

運用者と開発者のための、**SSH 経路が見える**デスクトップターミナルです。

`~/.ssh/config` の Host をピースのように並べ、踏み台から接続先までを組み立てます。Host を 1 台だけ置いた場合は `ProxyJump` を自動展開し、明示的に複数台を置いた場合はその順番で `direct-tcpip` トンネルを作ります。

> [!WARNING]
> 現在は v0.1.0 alpha です。主要なSSH認証と strict `known_hosts` 検証に対応していますが、OpenSSH config の全ディレクティブ、再接続、長時間運用の検証は未完了です。日常運用へ投入する前に制約を確認してください。
>
> `russh` の未修正 RSA 依存を出荷しないため、現在は RSA 秘密鍵認証と RSA のみの
> host key を無効化しています。Ed25519 / ECDSA を使用してください。

## いま動くもの

- Tauri 2 + Rust (`russh`) + xterm.js 6
- OpenSSH config の `Host` / `Match` / `Include`、wildcard、negation、主要 token
- HostName / User / Port / IdentityFile / CertificateFile / IdentitiesOnly / ProxyJump / HostKeyAlias
- `ssh-agent`（Unix）、秘密鍵、OpenSSH certificate、password、keyboard-interactive/OTPによる SSH2 認証
- 暗号化OpenSSH秘密鍵のパスフレーズ入力
- `known_hosts` の厳格なホスト鍵検証（unknown は指紋確認、changed は拒否）
- ProxyJump 自動展開と、任意に組んだ多段ルート
- hop ごとの connecting / connected / error 表示
- 複数セッションのタブ切替、端末リサイズ、切断
- `Ctrl+Shift+P` の fuzzy コマンドパレット
- UI で変更できるキーボードショートカット
- WebGL レンダラと安全なフォールバック
- Tauri IPC Channel を使った端末出力ストリーミング

## 起動

前提は Node.js 22 以上、Rust 1.85 以上と、Tauri が各 OS で必要とするシステムパッケージです。Linux の WebKitGTK を含む詳細は [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) を参照してください。

### Nix（推奨）

Nix 2.4 以降で flake を有効にしている場合、Node/RustとLinuxのTauri依存をまとめて再現できます。

```bash
./scripts/nix-local develop
just bootstrap
just dev
```

`direnv`を使う場合は、リポジトリに含まれる`.envrc`を一度許可します。

```bash
direnv allow
```

flakeはLinux x86_64/aarch64とmacOS Intel/Apple Siliconを評価対象にします。macOSのTauriビルドには、Nix外でXcode Command Line Toolsも必要です。

### システム環境

```bash
./scripts/run-cached pnpm install --frozen-lockfile
./scripts/run-cached pnpm run tauri dev
```

フロントエンドと Rust の検証:

```bash
just check
just security
```

再現可能な Nix package と、sandbox 化したフロントエンドの Bazel build も用意しています。

```bash
./scripts/nix-local build
./scripts/run-bazel test //:check
./scripts/run-bazel build //:frontend
```

Nix storeを含むローカルキャッシュは既定で`/mnt/data/ope-term`へ集約します。キャッシュ
構成と各コマンドの使い分けは [ビルド・開発環境](docs/BUILD.md) を参照してください。

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

初回接続では hostname、port、hop、algorithm、SHA256 fingerprint を確認画面に表示します。管理者や別の安全な経路で fingerprint を照合し、「今回のみ信頼」または「信頼して保存」を選びます。保存先は OpenSSH と共通の `~/.ssh/known_hosts` です。

ope-term は未知のホスト鍵を自動承認しません。保存済みの鍵が変わった場合は接続を拒否し、既存行を UI から上書きしません。

## SSH 認証

各hopはサーバーが提示する方式に従い、ssh-agent/公開鍵、keyboard-interactive、passwordの順で認証します。暗号化された`IdentityFile`にはパスフレーズを要求します。keyboard-interactiveは、passwordとOTPのような複数質問および複数ラウンドに対応します。

認証画面には要求元hopとユーザー名を常時表示します。入力値はlocalStorage、console、エラーへ記録せず、DOM入力欄は送信前に消去し、短命なIPC応答バッファも送信後に消去します。各promptは5分でtimeoutし、キャンセルするとそのhopへの接続を中止します。

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
- 未知のホスト鍵は SHA256 fingerprint を確認するまで接続せず、変更された鍵は常に拒否します。
- password、OTP、秘密鍵passphraseは永続化・ログ出力せず、認証専用の使い捨てIPCでだけ渡します。
- リモートのOSC 8リンクは開かず、window操作とclipboard連携を無効化しています。

脆弱性の報告は [SECURITY.md](SECURITY.md) を参照してください。

## 設計とロードマップ

- [アーキテクチャ](docs/ARCHITECTURE.md)
- [ビルド・開発環境](docs/BUILD.md)
- [性能・安定性のゲート](docs/PERFORMANCE.md)
- [脅威モデル](docs/THREAT_MODEL.md)
- [端末セキュリティレビュー](docs/TERMINAL_SECURITY.md)
- 未実装項目は [GitHub Issues](https://github.com/hjosugi/ope-term/issues) で管理

## ライセンス

[MIT](LICENSE)
