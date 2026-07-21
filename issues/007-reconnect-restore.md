# Reliability: 切断検知・再接続・24 時間 soak test
Labels: priority:P1, reliability, area:ssh

## 背景

keepalive はあるが、切断後の再接続や screen/tmux への復帰を扱っていない。

## 受け入れ条件

- [ ] timeout / remote close / network change を区別する
- [ ] exponential backoff と手動 retry を実装する
- [ ] 意図しないコマンド再送をしない
- [ ] tmux/screen へ再 attach する opt-in workflow を設計する
- [ ] 24 h soak test とネットワーク断 fault injection を CI 外の定期検証で回す
