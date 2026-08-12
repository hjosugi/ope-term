# Release: Linux / Windows / macOS の署名・配布 CI
Labels: priority:P1, area:release, enhancement

## 背景

現時点の CI は test/build のみ。運用ツールとして再現可能な署名済み配布物と更新経路が必要。

## 受け入れ条件

- [ ] Linux AppImage/deb/rpm、Windows MSI/NSIS、macOS dmg を生成する
- [ ] Windows と macOS の code signing を設定する
- [ ] SBOM、checksum、provenance を release に添付する
- [ ] Tauri updater の署名検証と rollback 方針を実装する
- [x] tag と Cargo/npm/Tauri version の一致を検証する
