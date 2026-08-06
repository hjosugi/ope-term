# ope-term

運用者と開発者のための、**SSH 経路が見える**デスクトップターミナルです。

`~/.ssh/config` の Host をピースのように並べ、踏み台から接続先までを組み立てます。Host を 1 台だけ置いた場合は `ProxyJump` を自動展開し、明示的に複数台を置いた場合はその順番で `direct-tcpip` トンネルを作ります。

**ドキュメント: <https://hjosugi.github.io/ope-term/>**

> [!WARNING]
> 現在は v0.1.1 alpha です。主要なSSH認証と strict `known_hosts` 検証に対応していますが、OpenSSH config の全ディレクティブ、再接続、長時間運用の検証は未完了です。日常運用へ投入する前に制約を確認してください。
>
> `russh` の未修正 RSA 依存を出荷しないため、現在は RSA 秘密鍵認証と RSA のみの
> host key を無効化しています。Ed25519 / ECDSA を使用してください。

## いま動くもの

- Tauri 2 + Rust (`russh`) + xterm.js 6 の多段 SSH ターミナル
- OpenSSH config の `Host` / `Match` / `Include`、wildcard、negation、主要 token
- ssh-agent、秘密鍵、certificate、password、keyboard-interactive/OTP による SSH2 認証
- `known_hosts` の厳格なホスト鍵検証（unknown は指紋確認、changed は拒否）
- ProxyJump 自動展開と、任意に組んだ多段ルート、hop ごとの状態表示
- ルートの保存と起動時のタブ復元（接続は自動で開始しない）、切断済みタブの再接続
- 切断理由の分類と、transport 断だけを対象にした exponential backoff 自動再接続
- 再起動なしの SSH config 再読み込みと、消えた Host の degraded 表示
- `Ctrl+Shift+P` の fuzzy コマンドパレットと、UI で変更できるキーボードショートカット

## 起動

Node.js 22 以上、Rust 1.85 以上と、Tauri が各 OS で必要とするシステムパッケージが前提です。

```bash
./scripts/nix-local develop   # Nix を使う場合（推奨）
just bootstrap
just dev
```

Nix を使わない場合は、[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) を導入してから次を実行します。

```bash
./scripts/run-cached pnpm install --frozen-lockfile
./scripts/run-cached pnpm run tauri dev
```

検証は `just check` と `just security` です。詳細は
[起動](https://hjosugi.github.io/ope-term/GETTING_STARTED/) を参照してください。

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

ルートの組み立て、保存と復元、認証とホスト鍵確認、ショートカット一覧は
[使い方](https://hjosugi.github.io/ope-term/USAGE/) にまとめています。

## ドキュメント

| ページ | 内容 |
|---|---|
| [はじめに](https://hjosugi.github.io/ope-term/) | 設計の前提と現状 |
| [起動](https://hjosugi.github.io/ope-term/GETTING_STARTED/) | 前提ツール、開発ビルド、検証コマンド |
| [使い方](https://hjosugi.github.io/ope-term/USAGE/) | ルート、保存と復元、認証、ショートカット |
| [アーキテクチャ](https://hjosugi.github.io/ope-term/ARCHITECTURE/) | Rust core と WebView の境界、接続シーケンス |
| [ビルド・開発環境](https://hjosugi.github.io/ope-term/BUILD/) | Nix / Bazel / キャッシュ構成 |
| [セキュリティ方針](https://hjosugi.github.io/ope-term/SECURITY_POLICY/) | プロトコル、権限、秘密情報、永続化 |
| [脅威モデル](https://hjosugi.github.io/ope-term/THREAT_MODEL/) | 資産、境界、統制、残存リスク |
| [ロードマップ](https://hjosugi.github.io/ope-term/ROADMAP/) | 実装済みの基盤とこれからの作業 |

ソースは `docs/` にあり、サイトは `main` への push で GitHub Pages へ配信します。

```bash
just docs-serve   # ローカルプレビュー
just docs         # strict モードで静的生成
```

## 貢献とセキュリティ報告

- 開発の進め方とレビュー基準: [CONTRIBUTING.md](CONTRIBUTING.md)
- 脆弱性の報告: [SECURITY.md](SECURITY.md)
- 未実装項目: [GitHub Issues](https://github.com/hjosugi/ope-term/issues)

## ライセンス

[MIT](LICENSE)
