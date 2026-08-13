# ビルド・開発環境

## 推奨フロー

Nix shell が Node.js、pnpm、Rust、Tauri の system library、Bazelisk、just、
cargo-nextest、cargo-fuzz、cargo-audit、Syft、sccache、mold（Linux）を揃えます。
Linux では WebKitGTK と同じ Nix closure の Mesa、GBM backend、DRI driver path も設定するため、
NixOS 以外の Wayland host でも host と Nix の EGL library を混在させずに起動できます。

```bash
./scripts/nix-local develop
just bootstrap
just check
just dev
```

`direnv allow` 済みなら同じ環境が自動化されます。`just --list` で利用可能な recipe を
確認してください。

`EGL_BAD_PARAMETER` で起動前に終了する場合は、まず `just dev` を通常 shell から直接実行して
いないか確認し、`./scripts/nix-local develop --command just dev` で同じ問題が再現するかを
切り分けてください。`LD_LIBRARY_PATH` だけを host Mesa へ差し替えると GTK/WebKitGTK と
renderer の ABI が分かれるため、恒久対応にはしません。

## ビルドの役割

| コマンド | 用途 |
|---|---|
| `pnpm run build` | 日常の高速なフロントエンド build |
| `cargo build --locked --manifest-path src-tauri/Cargo.toml` | Cargo.lock 固定の日常 Rust build |
| `./scripts/run-bazel test //:check` | sandbox 内の Vitest と TypeScript 型検査 |
| `./scripts/run-bazel build //:frontend` | hermetic Node toolchain による Vite build |
| `./scripts/nix-local build .#frontend` | Nix 固定依存によるフロントエンド成果物と Vitest / Node policy test |
| `./scripts/nix-local build` | 配布可能な Tauri package |
| `just check` | format、lint、test、通常 build の一括検証 |
| `just version-check` | npm、Cargo、Cargo.lock、Tauri の version 一致を検証 |
| `just security` | Tauri/CSP policy、pnpm、RustSec のセキュリティ監査 |
| `just fuzz-check` | 2つのfuzz targetをstable Rustでコンパイル |
| `just msrv-check` | manifest の Rust MSRV で lockfile 全体をコンパイル |
| `just fuzz-smoke 30` | nightly + ASanでparserとroute expansionを各30秒fuzz |
| `just sbom` | CycloneDX JSONの依存SBOMを生成 |
| `just docs` | MkDocs を strict 生成し、生成 HTML と README の内部 URL / anchor を検証 |
| `just docs-serve` | ドキュメントサイトのローカルプレビュー |
| `just performance-fixture` | 100 MiBのterminal output fixtureをstdoutへstream |
| `just performance-gate <report>` | 実機performance JSONをrelease閾値で検証 |
| `just reliability-soak <upstream>` | root不要のTCP fault proxyで24h soak reportを生成 |
| `just reliability-gate <report>` | 24h、fault、再接続、proxy errorの基準を検証 |

配布 bundle の dry run、code signing secret、tag release の手順は
[リリース工程](RELEASE.md)を参照してください。

Bazel は `.bazelversion` の Bazel を Bazelisk 経由で使用します。生成物は
`bazel-bin/dist`、通常の Vite 生成物は `dist` です。

Nix build の source は、再現性と転送量を保つため `.venv*`、`graphify-out`、`site`、
`dist`、`target` などの生成物を除外します。一方、frontend check が実行する
`scripts/*.test.mjs` と、その入力になる `.github/workflows` は source に含めます。
source filter を変更した場合は `./scripts/nix-local build path:.#frontend --no-link` を使い、
pure evaluation でも Vitest と Node policy test の両方が実行されることを確認してください。

## ドキュメントサイト

`docs/` の Markdown を MkDocs（Material テーマ）で静的サイトへ変換し、`main` への push で
GitHub Pages へ配信します。`mkdocs.yml` の `strict: true` に加え、`docs-policy.mjs` が生成済み
HTML を巡回し、同一 site 内の page / asset / anchor と README の公開 docs URL を検証します。
リンク切れや nav の記述漏れは build 失敗になります。ツールチェーンは `requirements-docs.txt` に固定し、
Nix dev shell にも同じ `mkdocs` / `mkdocs-material` を入れています。Nix を使わない場合は
venv へ導入してください。

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-docs.txt
just docs
```

## `/mnt/data` のキャッシュ

ローカル開発の可変データは既定で `/mnt/data/ope-term` に集約します。

| パス | 内容 |
|---|---|
| `/mnt/data/ope-term/nix-store` | root を切ったローカル Nix store と Nix DB |
| `/mnt/data/ope-term/nix-build` | Nix の build directory |
| `/mnt/data/ope-term/cache` | XDG、Cargo/Rustup、fuzz corpus、sccache、Bazel、Bazelisk、pnpm、npm、Vite |
| `/mnt/data/ope-term/data` | pnpm などのユーザーデータ |
| `/mnt/data/ope-term/state` | XDG state |
| `/mnt/data/ope-term/tmp` | 一時ファイル |

`scripts/cache-env.sh` が保存先を一元管理し、`.envrc`、`just`、Nix/Bazel ラッパー、
Nix dev shell から共用します。個別コマンドは
`./scripts/run-cached <command> ...` でも同じ配置を強制できます。別ディスクへ移す場合は、シェルへ入る前に
`OPE_TERM_DATA_ROOT=/path/to/data` を設定してください。`HOME` は変更しません。
chroot storeの論理パスとhost側PATHを混在させないため、direnvのflake解決は通常storeを
使い、`scripts/nix-local`を呼んだNix build/developだけ専用storeへ切り替えます。

- pnpm は content-addressed store を利用し、lockfile を `pnpm-lock.yaml` に一本化します。
- fuzzのnightly toolchain、生成corpus、crash artifactも同じcache rootへ置きます。
- Bazel の action cache は10 GiBまたは30日を上限として自動 GC します。
- Linux の Rust link は mold を使用します。
- CI は pnpm store、Bazelisk、Bazel repository/action cache、Cargo target を再利用し、
  同一 ref の古い実行をキャンセルします。

キャッシュ状況は `just cache-stats` で確認できます。挙動がおかしい場合は先に
`./scripts/run-bazel clean` や `pnpm install --frozen-lockfile` を試し、共有キャッシュ
全体を削除する前に原因を切り分けてください。

build の回帰は同じ machine、同じ電源設定、clean/dirty 条件を揃えて測ります。

```bash
just benchmark-build
```

この recipe は warmup 後に通常の pnpm build と Bazel incremental build を各5回測定します。
結果を比較する PR では machine、commit、cold/warm 条件も一緒に記録してください。

## 依存更新

1. `package.json` を更新する。
2. `pnpm install` で `pnpm-lock.yaml` を更新する。
3. `just check` と `just bazel` を通す。
4. Nix の `fetchPnpmDeps.hash` が変わった場合、失敗ログの `got:` の値で更新する。
5. `just nix` を通す。

Node、pnpm、Bazel はそれぞれ `flake.nix`、`packageManager`、`.bazelversion` で明示的に
固定しています。更新時は CI とローカルの両方で同じ major が使われることを
確認してください。
Rust の MSRV は `src-tauri/Cargo.toml` の `rust-version` が正本です。依存更新時は
`cargo metadata --locked` で transitive crate の要求 version が MSRV を超えていないことも
確認し、`just msrv-check` を通します。CI / Nix の通常 toolchain は MSRV より新しい固定 versionを
使用し、CI は MSRV でも別途 compile します。
