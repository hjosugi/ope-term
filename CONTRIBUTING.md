# Contributing

ope-term は alpha です。まず issue で利用場面、対象 OS、期待する SSH config と受け入れ条件を共有してください。

## Development

推奨の開発shell:

```bash
./scripts/nix-local develop
```

Nixを使わない場合は[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)を先に導入してください。どちらの場合も検証コマンドは同じです。

```bash
just bootstrap
just check
just security
just fuzz-check
```

個別の再現可能性を確認する場合:

```bash
./scripts/run-bazel test //:check
./scripts/run-bazel build //:frontend
./scripts/nix-local flake check
./scripts/nix-local build
```

詳細は [ビルド・開発環境](docs/BUILD.md) を参照してください。
初回は`just fuzz-bootstrap`でnightly Rustも`/mnt/data/ope-term`側へ導入します。
release候補では`just fuzz-smoke 300`を実行し、
`just sbom`でCycloneDX SBOMも生成します。セキュリティ境界と残存リスクは
[脅威モデル](docs/THREAT_MODEL.md) と
[依存advisoryレビュー](docs/SECURITY_ADVISORIES.md) に記録します。

変更は次の境界を守ってください。

- 秘密鍵、known_hosts、ソケット、SSH handle は Rust core だけが扱う。
- terminal data を HTML として DOM に挿入しない。
- 高頻度の terminal data に Tauri event bus を使わない。
- OpenSSH config の挙動変更には parser unit test を追加する。
- ショートカット追加は command registry と Keyboard Shortcuts UI の両方へ出す。
- 新しい capability / plugin は用途と threat model を PR に明記する。

## Pull requests

1 PR は 1 つの受け入れ条件のまとまりにします。UI 変更にはスクリーンショット、性能変更には変更前後の測定値、SSH 変更には再現用 config（秘密情報を除去）を添えてください。
