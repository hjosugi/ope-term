# Transports: telnet / serial console の需要検証と安全な境界
Labels: priority:P2, area:protocol, security

## 背景

NW 機器やコンソールサーバ保守では telnet / serial が残る。一方、telnet は平文で SSH の安全要件と同列に扱えない。SSH1 と rlogin は対象外とする。

## 受け入れ条件

- [ ] 実利用機器と必要な telnet option / serial setting を調査する
  - Cisco router / switch の公開実機設定と RFC option の desk research は完了
  - operator 3名・実機 family 2系統の需要確認は未完了
- [x] transport interface を定義し SSH session code と分離する
- [ ] 平文接続を常時警告し、macro/credential 保存を既定で無効にする
  - merge gate は定義済み。telnet 自体が未実装のため UI enforcement test は未着手
- [x] serial の device permission と切断を OS 別に設計する
- [x] SSH1 / rlogin 非対応を維持する

設計、根拠資料、実装前 gate は [Transport boundary](../docs/TRANSPORTS.md) を参照。
