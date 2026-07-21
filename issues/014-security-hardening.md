# Security hardening: threat model・権限監査・fuzzing
Labels: priority:P0, security, reliability

## 背景

ターミナルは信頼できないリモート出力と認証情報を同時に扱う。公開 release 前に境界を検証する。

## 受け入れ条件

- [ ] asset / trust boundary / attacker capability を threat model にする
- [ ] Tauri capability と CSP を自動監査する
- [ ] ssh_config parser と route expansion を fuzzing する
- [ ] terminal escape sequence と clipboard / link handling をレビューする
- [ ] dependency audit、SBOM、private vulnerability reporting を release process に組み込む
