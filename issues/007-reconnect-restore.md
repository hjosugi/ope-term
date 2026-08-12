# Reliability: 切断検知・再接続・24 時間 soak test
Labels: priority:P1, reliability, area:ssh

## 背景

keepalive はあるが、切断後の再接続や screen/tmux への復帰を扱っていない。

## 受け入れ条件

- [x] timeout / remote close / network change を区別する（`local` / `remote` / `transport` / `failed`）
- [x] exponential backoff と手動 retry を実装する（transport 断のみ 1→16 秒で最大 5 回、停止と即時再試行つき）
- [x] 意図しないコマンド再送をしない（切断時に未送信バッファを破棄し、再接続後も再送しない）
- [x] tmux/screen へ再 attach する opt-in workflow を設計する（固定argv、毎回確認、入力再送なし）
- [ ] 24 h soak test とネットワーク断 fault injection を CI 外の定期検証で回す
