# リリース工程

`.github/workflows/release.yml` は Linux、Windows、macOS の bundle を別 runner で生成します。
通常の `workflow_dispatch` は Release を作らず、Actions の workflow artifact だけを残す
dry run です。`v*` tag の push だけが、全 build の成功後に draft Release を作ります。

## 成果物

| runner | target | bundle |
|---|---|---|
| Ubuntu 22.04 | `x86_64-unknown-linux-gnu` | AppImage、deb、rpm |
| Windows | `x86_64-pc-windows-msvc` | MSI、NSIS |
| macOS | `aarch64-apple-darwin` | dmg |
| macOS | `x86_64-apple-darwin` | dmg |

tag build では、これらに次の supply-chain metadata を加えます。

- `ope-term.cdx.json`: Syft で生成した CycloneDX SBOM
- `SHA256SUMS`: Release 内の全 bundle と SBOM の SHA-256
- GitHub artifact attestation: tag、commit、workflow に結び付いた provenance

`gh attestation verify <asset> -R hjosugi/ope-term` と
`sha256sum --check SHA256SUMS` で provenance と内容を別々に検証できます。
SBOM の source version は `package.json` から取得し、`.venv*`、`node_modules`、build output、
生成 docs / knowledge graph は走査対象から除外します。
workflow artifact は OS / bundle ごとの directory から、重複 basename を拒否しながら
`release-upload` へ平坦化します。`SHA256SUMS` は GitHub Release からダウンロードしたファイル名と
そのまま一致します。

## version gate

次の四つは常に一致させます。

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock` の `ope-term` package
- `src-tauri/tauri.conf.json`

ローカルでは次を実行します。tag を渡した場合は、先頭に `v` を付けた version と完全一致する
ことも検査します。tag workflow では `GITHUB_REF_NAME` を自動的に検査します。

```bash
just version-check
just version-check --tag v0.1.1
just release-policy  # icon、bundle matrix、署名 gate、supply-chain step
```

## local bundle smoke

Linux では、CI と同じ bundle 指定を個別に確認できます。

```bash
./scripts/run-cached pnpm tauri build --bundles appimage,deb,rpm -- --locked
```

2026-08-13 に x86_64 Linux で deb / rpm の生成と package 内容を確認済みです。AppImage は
通常の Ubuntu runner ではなく Nix の split-output GLib を使う local shell では、upstream の
`linuxdeploy-plugin-gtk` が `gio-2.0` の実在しない schema path を copy して停止します。application
binary と AppDir の生成までは成功しており、Ubuntu 22.04 Actions runner での実体確認を
acceptance の残作業にします。この環境差を回避するために system library を AppImage へ
手動注入して release artifact とすることはしません。

## code signing secrets

tag build は署名情報が一つでも欠けていれば publish 前に失敗します。鍵や証明書をリポジトリへ
保存してはいけません。

全jobのcheckoutはGit資格情報をworktreeへ残しません。publish jobの`contents: write` tokenは
draft Releaseを作る最後のstepだけに環境変数で渡し、build・SBOM・checksum生成には公開しません。

macOS は次の Actions secrets を使用します。

- `APPLE_CERTIFICATE`: Developer ID Application 証明書の base64
- `APPLE_CERTIFICATE_PASSWORD`: 証明書 export password
- `APPLE_SIGNING_IDENTITY`: keychain の signing identity
- `APPLE_ID`: notarization を行う Apple ID
- `APPLE_PASSWORD`: app-specific password
- `APPLE_TEAM_ID`: Apple Developer Team ID

Windows は次の Actions secrets を使用します。

- `WINDOWS_CERTIFICATE`: PFX 証明書の base64
- `WINDOWS_CERTIFICATE_PASSWORD`: PFX export password

workflow は証明書を runner の CurrentUser certificate store へ一時 import し、取得した
thumbprint を Tauri の一時 config に渡します。timestamp は SHA-256 と DigiCert timestamp
service を使います。将来 Azure Artifact Signing へ移す場合は、固定の証明書情報を追加せず
`bundle.windows.signCommand` と短命 credential を用います。

## リリース手順

1. changelog と issue の対象範囲を確定する。
2. 四つの version を同時に更新し、`cargo check` などで `Cargo.lock` を更新する。
3. `just version-check`、`just check`、`just security`、`just docs` を通す。
4. Actions の Release workflow を `workflow_dispatch` で dry run し、全 OS の bundle を確認する。
5. signing secrets の有効期限とアクセス範囲を確認する。
6. `v<version>` annotated tag を作る。tag の remote push は明示承認を得た担当者だけが行う。
7. 作成された draft Release で署名、起動、checksum、attestation を検証する。
8. draft を公開し、`latest` のリンクとインストール手順を確認する。

同じ tag の asset は置換しません。修正時は必ず version を上げ、新しい tag から再生成します。

## Tauri updater と rollback

Updater は署名鍵の運用者、公開鍵、更新 endpoint が確定するまで有効化しません。導入時は
`createUpdaterArtifacts: true`、Tauri Updater plugin、HTTPS endpoint、リポジトリへ commit する
公開鍵、Actions secret `TAURI_SIGNING_PRIVATE_KEY` を同じ変更で揃えます。秘密鍵を失った場合に
既存 install へ更新を届けられなくなるため、暗号化 backup と鍵 rotation 手順も release 前の
必須条件です。

Updater の署名検証を無効化する例外は設けません。自動 downgrade も行いません。rollback は
問題の変更を revert した、より大きい patch version を新規 release する forward rollback と
します。重大事故では問題の Release を `latest` から外して配信を止め、修正版を公開します。
すでに導入済みの利用者には影響範囲と手動復旧手順を Release notes と security advisory で
明示します。

## 現在の残作業

- GitHub Actions で初回 dry run を行い、全 bundle の実体を確認する
- Apple / Windows の証明書を用意し、tag build で署名と notarization を実証する
- Updater の鍵管理者、endpoint、鍵 backup / rotation を決めて plugin を実装する
- draft Release 上で SBOM、checksum、attestation の検証記録を残す
