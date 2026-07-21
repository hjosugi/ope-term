# OpenSSH config: Include / Match / HostKeyAlias と token 展開の互換性
Labels: priority:P1, area:ssh, enhancement

## 背景

現在の parser は主要な Host 設定に限定している。大規模運用では Include と Match、証明書、別 host key alias が必要になる。

## 受け入れ条件

- [ ] `Include` の glob、相対 path、循環を扱う
- [ ] `Match host` / `originalhost` / `user` の必要範囲を定義して実装する
- [ ] `%h`, `%n`, `%p`, `%r`, `%d` の token 展開を実装する
- [ ] `HostKeyAlias`, `CertificateFile`, `IdentitiesOnly` を認証層へ渡す
- [ ] `ssh -G <host>` と golden test で比較する
