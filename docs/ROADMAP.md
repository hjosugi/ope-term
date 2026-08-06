# ロードマップ

正本は [GitHub Issues](https://github.com/hjosugi/ope-term/issues) です。
このページは現在地を把握するための要約で、issue の下書きは
リポジトリの `issues/` に置いています。

## 実装済みの基盤

| 項目 | 内容 |
|---|---|
| OpenSSH config 互換 | `Host` / `Match` / `Include`、wildcard、negation、主要 token、`HostKeyAlias`、`CertificateFile` |
| ホスト鍵の信頼 | 未知鍵の SHA256 fingerprint 確認、変更鍵の拒否、`known_hosts` への追記 |
| 対話認証 | ssh-agent / 公開鍵 / certificate / password / keyboard-interactive / 鍵 passphrase |
| ルートワークスペース | 名前付きルートの保存、起動時のタブ復元、切断済みタブの再接続、degraded 表示 |
| セキュリティ基盤 | 脅威モデル、CSP と capability の自動監査、fuzzing、SBOM、依存 audit |
| 開発環境 | Nix flake と direnv、Bazel build、`/mnt/data` へのキャッシュ集約 |

## これからの作業

| 優先度 | Issue | 内容 |
|---|---|---|
| P0 | [#10 Performance](https://github.com/hjosugi/ope-term/issues/10) | cold start、input latency、100 MB output の throughput を計測し、回帰をゲートで検出する |
| P1 | [#5 Terminal panes](https://github.com/hjosugi/ope-term/issues/5) | zellij 風の分割・移動・リサイズ |
| P1 | [#6 SFTP](https://github.com/hjosugi/ope-term/issues/6) | 多段 SSH セッションを共有する 2 ペインファイラー |
| P1 | [#7 Reliability](https://github.com/hjosugi/ope-term/issues/7) | 切断分類と backoff 再接続は実装済み。残りは tmux/screen 再 attach と 24 時間 soak test |
| P1 | [#9 Local terminal](https://github.com/hjosugi/ope-term/issues/9) | OS ネイティブ shell と環境プロファイル |
| P1 | [#11 Release](https://github.com/hjosugi/ope-term/issues/11) | Linux / Windows / macOS の署名・配布 CI |
| P2 | [#8 Session logs](https://github.com/hjosugi/ope-term/issues/8) | 明示変数、ローテーション、fzf 風検索ビューア |
| P2 | [#12 Transports](https://github.com/hjosugi/ope-term/issues/12) | telnet / serial console の需要検証と安全な境界 |
| P2 | [#13 Command system](https://github.com/hjosugi/ope-term/issues/13) | multi-chord、context key、競合表示、設定 export |

## 進め方

- 1 PR は 1 つの受け入れ条件のまとまりにします。
- OpenSSH config の挙動を変える場合は parser unit test を追加します。
- 新しい capability / plugin を足す場合は、用途と [脅威モデル](THREAT_MODEL.md) の更新を
  PR に明記します。

詳細は
[CONTRIBUTING.md](https://github.com/hjosugi/ope-term/blob/main/CONTRIBUTING.md)
を参照してください。
