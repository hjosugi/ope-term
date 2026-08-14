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
| Terminal panes | 左右・上下分割、focus移動、pointer/keyboard resize、layout復元 |
| SFTP file manager | 認証済み多段 session の共有、local / remote 一覧、直列 queue、進捗、cancel、retry、安全な一時 file 置換 |
| Local terminal | Windows / Linux / macOS native PTY、shell profile、working directory、OSC 133 opt-in、child reap |
| Session logs | host/profile別明示 enable、固定変数、timestamp、rotation、100 MiB 超 streaming viewer |
| Command system | multi-chord、context key、競合警告、JSON import/export、Ctrl/Cmd 移行 |
| セキュリティ基盤 | 脅威モデル、CSP と capability の自動監査、fuzzing、SBOM、脆弱性・license・source audit |
| 開発環境 | Nix flake と direnv、Bazel build、`/mnt/data` へのキャッシュ集約 |
| 性能ゲート | cold start / latency / memory / 100 MiB output harness、WebGL/fallback artifact bundle、version付きbudget判定 |
| リリース基盤 | multi-OS bundle workflow、version/icon/signing/supply-chain policy、全OS unsigned dry run |
| Transport 境界 | SSH/local共通input/resize/close、telnet optionとserial OS lifecycleの実装前gate |

## これからの作業

| 優先度 | Issue | 内容 |
|---|---|---|
| P0 | [#10 Performance](https://github.com/hjosugi/ope-term/issues/10) | harnessとbudget gateは実装済み。残りはWebKitGTK / WebView2 / WKWebViewとCachyOS Wayland実機artifact |
| P1 | [#7 Reliability](https://github.com/hjosugi/ope-term/issues/7) | 切断分類、backoff、tmux/screen opt-in設計は完了。残りは外部SSH先を使う24時間soakの完走記録 |
| P1 | [#11 Release](https://github.com/hjosugi/ope-term/issues/11) | 全OS dry runは完了。残りはWindows/macOS署名、tag attestation・Release添付、updater鍵運用 |
| P2 | [#12 Transports](https://github.com/hjosugi/ope-term/issues/12) | 境界とdesk researchは完了。残りはoperator/実機需要確認と、採用時のtelnet平文UI enforcement |

未完了欄は、実機・24時間・署名鍵・利用者ヒアリングなどリポジトリ外の証跡が揃うまで
完了扱いにしません。ローカルの準備状況は各リンク先issueと対応する`issues/*.md`に記録します。

## 進め方

- 1 PR は 1 つの受け入れ条件のまとまりにします。
- OpenSSH config の挙動を変える場合は parser unit test を追加します。
- 新しい capability / plugin を足す場合は、用途と [脅威モデル](THREAT_MODEL.md) の更新を
  PR に明記します。

詳細は
[CONTRIBUTING.md](https://github.com/hjosugi/ope-term/blob/main/CONTRIBUTING.md)
を参照してください。
