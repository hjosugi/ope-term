# OpenSSH config: Include / Match / HostKeyAlias と token 展開の互換性
Labels: priority:P1, area:ssh, enhancement

## 背景

現在の parser は主要な Host 設定に限定している。大規模運用では Include と Match、証明書、別 host key alias が必要になる。

## 受け入れ条件

- [x] `Include` の glob、相対 path、循環を扱う
- [x] `Match host` / `originalhost` / `user` の必要範囲を定義して実装する
- [x] `%h`, `%n`, `%p`, `%r`, `%d` の token 展開を実装する
- [x] `HostKeyAlias`, `CertificateFile`, `IdentitiesOnly` を認証層へ渡す
- [x] `ssh -G <host>` と golden test で比較する

## 実装メモ

Includeは全体8 MiB / 1024 file / 100,000 directive、1 directive 64 KiB、深さ32、
globごと1024 matchで停止する。
解決後の`IdentityFile` / `CertificateFile`はhostごとに各64件を上限とする。
UIへ列挙する具体Hostはprofile解決前に2,048件で停止する。
