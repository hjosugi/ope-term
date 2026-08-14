# Release: Linux / Windows / macOS の署名・配布 CI
Labels: priority:P1, area:release, enhancement

## 背景

現時点の CI は test/build のみ。運用ツールとして再現可能な署名済み配布物と更新経路が必要。

## 受け入れ条件

- [x] Linux AppImage/deb/rpm、Windows MSI/NSIS、macOS dmg を生成する
  - 2026-08-15: unsigned dry run
    [#31813389358](https://github.com/hjosugi/ope-term/actions/runs/31813389358) で4 targetの
    bundle、AppImage内GStreamer `appsink` load、flat stagingを実証
- [ ] Windows と macOS の code signing を設定する
- [ ] SBOM、checksum、provenance を release に添付する
  - workflow artifact の basename 衝突検査、Release と一致する flat checksum、attestation の
    local policy test は完了。read-only staging jobとwrite-scoped publish jobも分離済み。2026-08-15の
    dry runでSBOM・checksum stagingまで実証済み。tag限定のattestationとdraft Release添付は未完了
- [ ] Tauri updater の署名検証と rollback 方針を実装する
- [x] tag と Cargo/npm/Tauri version の一致を検証する
