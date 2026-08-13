# Security hardening: threat model・権限監査・fuzzing
Labels: priority:P0, security, reliability

## 背景

ターミナルは信頼できないリモート出力と認証情報を同時に扱う。公開 release 前に境界を検証する。

## 受け入れ条件

- [x] asset / trust boundary / attacker capability を threat model にする
- [x] Tauri capability と CSP を自動監査する
- [x] ssh_config parser と route expansion を fuzzing する
- [x] terminal escape sequence と clipboard / link handling をレビューする
- [x] dependency audit、SBOM、private vulnerability reporting を release process に組み込む

## 完了

脅威モデル、端末レビュー、Tauri policy監査、2つのcargo-fuzz target、
RustSec/pnpm監査、CycloneDX SBOM、週次security workflowを追加した。
private vulnerability reportingが有効であることも確認済み。
IPC payloadとcanonical ID、session / SFTP registry、SSH config、known_hosts、認証file、
WebView storageの資源上限と失敗時degradeも自動テストで固定した。
known_hosts追記は同一process内で直列化し、symlink差し替えをopen時にも拒否する。
CIの外部Actionはfull commit SHAへ固定し、checkout credential非永続化とrelease write権限分離を
policy testで監査する。
