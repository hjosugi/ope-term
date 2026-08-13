# Release: Linux / Windows / macOS の署名・配布 CI
Labels: priority:P1, area:release, enhancement

## 背景

現時点の CI は test/build のみ。運用ツールとして再現可能な署名済み配布物と更新経路が必要。

## 受け入れ条件

- [ ] Linux AppImage/deb/rpm、Windows MSI/NSIS、macOS dmg を生成する
  - 2026-08-13: x86_64 Linux の deb / rpm は local smoke と内容確認に成功
  - AppImage は Nix split-output GLib と linuxdeploy-plugin-gtk の schema path 非互換を確認。
    Ubuntu Actions、Windows、macOS の workflow artifact 実証は未完了
- [ ] Windows と macOS の code signing を設定する
- [ ] SBOM、checksum、provenance を release に添付する
- [ ] Tauri updater の署名検証と rollback 方針を実装する
- [x] tag と Cargo/npm/Tauri version の一致を検証する
