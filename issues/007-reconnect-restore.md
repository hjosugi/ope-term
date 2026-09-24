# Reliability: 切断検知・再接続・24 時間 soak test
Labels: priority:P1, reliability, area:ssh

## 背景

keepalive はあるが、切断後の再接続や screen/tmux への復帰を扱っていない。

## 受け入れ条件

- [x] timeout / remote close / network change を区別する（`local` / `remote` / `transport` / `failed`）
  - 初回TCP / SSH handshakeと各tunnel openは30秒で`failed`、接続後のkeepalive timeoutは`transport`
- [x] exponential backoff と手動 retry を実装する（transport 断のみ 1→16 秒で最大 5 回、停止と即時再試行つき）
- [x] 意図しないコマンド再送をしない（切断時に未送信バッファを破棄し、再接続後も再送しない）
  - event / terminal dataをconnection IDで世代分離し、tab close時に即時無効化する
  - inputは256 KiB chunk、sessionごとの未送信合計は4 MiB、backend queueは64件で停止する
- [x] tmux/screen へ再 attach する opt-in workflow を設計する（固定argv、毎回確認、入力再送なし）
- [ ] 24 h soak test とネットワーク断 fault injection を CI 外の定期検証で回す
  - 無人soak driver（`--example reliability_soak`、製品と同じ`ssh::run`とUI同等の再接続方針、
    heartbeatでreplay検出）、fault proxyの`drop` / `blackhole` / `alternate`、client report gate、
    `scripts/reliability-soak`を実装済み
  - 週次のscheduled workflow（30分・CI profile）とlab machine用systemd user timer（24時間）を用意。
    24時間の完走記録（lab machineへのtimer導入と実行）は未完了

## 切断理由

`transport`は`cause`で`timeout`（keepalive / inactivity / TCP timer）と`network`（reset・EOF・
network変更）を区別し、失敗したhopを表示する。serverの`SSH_MSG_DISCONNECT`は`remote` /
`server_disconnect`として自動再接続しない。再接続中に経路がまだ回復していない`failed`
（`network` / `timeout`）はbackoffを継続する。
