# 起動

現在は開発ビルドからの起動のみです。署名済みインストーラの配布は
[ロードマップ](ROADMAP.md) の Release issue で扱います。

## 前提

- Node.js 22.12 以上
- Rust 1.88 以上
- Tauri が各 OS で必要とするシステムパッケージ

Linux の WebKitGTK を含む詳細は
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) を参照してください。

## Nix（推奨）

Nix 2.4 以降で flake を有効にしている場合、Node / Rust と Linux の Tauri 依存を
まとめて再現できます。

```bash
./scripts/nix-local develop
just bootstrap
just dev
```

`direnv` を使う場合は、リポジトリに含まれる `.envrc` を一度許可します。

```bash
direnv allow
```

flake は Linux x86_64 / aarch64 と macOS Intel / Apple Silicon を評価対象にします。
macOS の Tauri ビルドには、Nix 外で Xcode Command Line Tools も必要です。

## システム環境

```bash
./scripts/run-cached pnpm install --frozen-lockfile
./scripts/run-cached pnpm run tauri dev
```

## 検証

変更を出す前に、フロントエンドと Rust の検証を通してください。

```bash
just check      # format、lint、test、通常 build
just security   # Tauri/CSP、pnpm/RustSec、Cargo license/source policy
```

再現可能な Nix package と、sandbox 化したフロントエンドの Bazel build も用意しています。

```bash
./scripts/nix-local build
./scripts/run-bazel test //:check
./scripts/run-bazel build //:frontend
```

## キャッシュ

Nix store を含むローカルキャッシュは既定で `/mnt/data/ope-term` へ集約します。
キャッシュ構成と各コマンドの使い分けは
[ビルド・開発環境](BUILD.md) を参照してください。

## ドキュメントサイト

このサイト自体も同じリポジトリから生成します。

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-docs.txt
just docs-serve   # http://127.0.0.1:8000 でプレビュー
just docs         # strict モードで site/ へ静的生成
```

Nix dev shell には `mkdocs` と `mkdocs-material` が入っているため、shell 内では
`just docs` をそのまま実行できます。
