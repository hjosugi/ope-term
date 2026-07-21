# Transports: telnet / serial console の需要検証と安全な境界
Labels: priority:P2, area:protocol, security

## 背景

NW 機器やコンソールサーバ保守では telnet / serial が残る。一方、telnet は平文で SSH の安全要件と同列に扱えない。SSH1 と rlogin は対象外とする。

## 受け入れ条件

- [ ] 実利用機器と必要な telnet option / serial setting を調査する
- [ ] transport interface を定義し SSH session code と分離する
- [ ] 平文接続を常時警告し、macro/credential 保存を既定で無効にする
- [ ] serial の device permission と切断を OS 別に設計する
- [ ] SSH1 / rlogin 非対応を維持する
