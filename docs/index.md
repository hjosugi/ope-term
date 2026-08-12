# ope-term

運用者と開発者のための、**SSH 経路が見える**デスクトップターミナルです。

`~/.ssh/config` の Host をピースのように並べ、踏み台から接続先までを組み立てます。Host を 1 台だけ置いた場合は `ProxyJump` を自動展開し、明示的に複数台を置いた場合はその順番で `direct-tcpip` トンネルを作ります。

!!! warning "v0.1.1 alpha"

    主要な SSH 認証と strict `known_hosts` 検証に対応していますが、OpenSSH config の全ディレクティブ、再接続、長時間運用の検証は未完了です。日常運用へ投入する前に制約を確認してください。

    `russh` の未修正 RSA 依存を出荷しないため、現在は RSA 秘密鍵認証と RSA のみの host key を無効化しています。Ed25519 / ECDSA を使用してください。

## 設計の前提

| 前提 | 意味 |
|---|---|
| 接続の正本は `~/.ssh/config` | ope-term はホスト情報を複製しません。alias を参照し、接続のたびに config を解決します。 |
| 踏み台を隠さない | hop ごとに connecting / connected / error を表示し、どこで止まったかを追えます。 |
| 便利さのために検証を緩めない | 未知のホスト鍵は SHA256 fingerprint を確認するまで接続せず、変更された鍵は常に拒否します。 |
| 秘密は Rust 側から出さない | 秘密鍵、ソケット、SSH handle は Rust core が保持し、WebView へ渡しません。 |

## いま動くもの

- Tauri 2 + Rust (`russh`) + xterm.js 6
- OpenSSH config の `Host` / `Match` / `Include`、wildcard、negation、主要 token
- HostName / User / Port / IdentityFile / CertificateFile / IdentitiesOnly / ProxyJump / HostKeyAlias
- `ssh-agent`（Unix）、秘密鍵、OpenSSH certificate、password、keyboard-interactive/OTP による SSH2 認証
- 暗号化 OpenSSH 秘密鍵のパスフレーズ入力
- `known_hosts` の厳格なホスト鍵検証（unknown は指紋確認、changed は拒否）
- ProxyJump 自動展開と、任意に組んだ多段ルート
- ルートに名前を付けた保存と、alias だけを参照する再利用
- 起動時のタブ復元（接続は自動で開始しない）と、切断済みタブの再接続
- 切断理由の分類（local / remote / transport / failed）と、transport 断だけを対象にした
  exponential backoff 自動再接続
- 再起動なしの SSH config 再読み込みと、消えた Host の degraded 表示
- 複数セッションのタブ切替、端末リサイズ、切断
- `Ctrl+Shift+P` の fuzzy コマンドパレットと、multi-chord・context・JSON移行に対応するショートカット
- WebGL レンダラと安全なフォールバック
- Tauri IPC Channel を使った端末出力ストリーミング

## どこから読むか

<div class="grid cards" markdown>

- **[起動](GETTING_STARTED.md)**

    前提ツール、Nix / システム環境での開発ビルド、検証コマンド。

- **[使い方](USAGE.md)**

    SSH config、認証、ホスト鍵確認、ルートの組み立てと保存、ショートカット。

- **[アーキテクチャ](ARCHITECTURE.md)**

    Rust core と WebView の境界、接続シーケンス、故障分離。

- **[UI サイズと CSS token](DESIGN_SYSTEM.md)**

    spacing、文字、control、layout の共通 scale と変更ルール。

- **[セキュリティ方針](SECURITY_POLICY.md)**

    対応プロトコル、WebView の権限、秘密情報の扱い、脆弱性報告。

</div>

未実装項目とこれからの作業は [ロードマップ](ROADMAP.md) を参照してください。
