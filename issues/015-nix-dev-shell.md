# Development: Nix flake と direnv で Tauri 環境を再現する
Labels: priority:P1, area:release, enhancement

## 背景

TauriのLinux開発にはWebKitGTK 4.1、GTK、libsoup、OpenSSL、Rust、Nodeが必要で、ディストリビューション差が大きい。CachyOS/NixOS/CIで同じツール群を使える入口が必要。

## 実装方針

- `flake.nix` / `flake.lock` を開発環境の正本にする
- 4 system を評価できる `nixos-26.05` に固定する（unstable は Intel macOS 対応を終了済み）
- macOS 固有の Xcode Command Line Tools は OS 側の前提として明記する

## 受け入れ条件

- [x] Node 24、Rust、Cargo、Clippy、rustfmt、rust-analyzerをflakeでpinする
- [x] LinuxのWebKitGTK 4.1/GTK/libsoup/appindicatorをdev shellへ含める
- [x] x86_64/aarch64 LinuxとIntel/Apple Silicon macOSを評価する
- [x] `/mnt/data` storeを使う`./scripts/nix-local develop`と`direnv allow`の手順を文書化する
- [x] CIで`nix flake check --all-systems`を実行する
