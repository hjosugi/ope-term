# 長時間接続と再接続

ope-term はtransport断だけをexponential backoffで再接続します。remote shellの終了、認証失敗、
host key変更、操作者によるcloseは自動再試行しません。このページは24時間soak testと、再接続後に
tmux / screenへ安全に復帰する方針を定義します。

初回TCP / SSH handshakeと各ProxyJump tunnel openは30秒で停止します。shell到達前のtimeoutは
`failed`として手動再試行にし、接続済みsessionのkeepalive / inactivity timeoutだけを`transport`
として自動再接続します。host-key / auth promptは操作者の確認用に別途5分待ちます。

## 切断理由の区別

切断は `reason`（再試行方針が見る4分類）に加え、`cause` と失敗した `hop` を持ちます。
各hopのrussh接続が終わった理由を最初に記録したhopで判定するため、踏み台のkeepalive timeoutが
その上に積んだ接続先のEOFに上書きされることはありません。

| 状況 | reason | cause | 自動再接続 |
|---|---|---|---|
| keepalive / inactivity / TCP timerの満了（経路が無音になった） | `transport` | `timeout` | する |
| socketの失敗（reset、到達不能、`SSH_MSG_DISCONNECT`なしのEOF、local networkの切替） | `transport` | `network` | する |
| serverが`SSH_MSG_DISCONNECT`を送った（保守停止、管理者による切断） | `remote` | `server_disconnect` | しない |
| remote shellがEOF / closeした（`exit`など） | `remote` | `shell_exit` | しない |
| 再接続中にまだ経路へ届かない（TCP拒否、handshake / tunnel timeout） | `failed` | `network` / `timeout` | backoffを続ける |
| config・ホスト鍵・認証で拒否された | `failed` | なし | しない |

terminalには `応答が途絶えたため切断しました（keepalive timeout）（bastion）` のように原因とhopを
表示します。再接続中に経路がまだ回復していない場合も `failed` で打ち切らず、1→16秒の
backoffを最大5回まで続けます。最初の接続で届かない場合と、認証・ホスト鍵・configの拒否は
自動再試行しません。

OSのnetwork変更通知は購読していません。IP変更やinterface断は既存socketのreset / EOF（`network`）
またはkeepaliveの無応答（`timeout`）として検出します。

## Root権限不要のfault injection

`scripts/fault-proxy.mjs` はlocalhostでTCPを中継し、既定で15分ごとに確立済みsocketへfaultを
入れます。新しい接続は受け続けるため、ope-termのbackoff再接続を実ネットワーク設定やroot権限なしで
検証できます。`--fault-mode` で種類を選びます。

- `drop`: 確立済みsocketを閉じます（`network` causeの再現）。
- `blackhole`: socketを開いたまま双方向のbytesを捨てます。keepalive / inactivity timerだけが
  気付ける無音の経路で、`timeout` causeを再現します。clientが諦めなければ `--blackhole-seconds`
  （既定120秒）後に閉じます。
- `alternate`: faultごとに `drop` と `blackhole` を交互に入れます。

```bash
just reliability-soak ssh.example.com 22 2222 86400 900 \
  artifacts/reliability/cachyos-24h.json
```

テスト専用のSSH configはproxyを向けます。`HostKeyAlias`に本来の接続先を指定し、localhost名で
別のknown_hosts trustを作らないようにします。

```sshconfig
Host ope-term-soak
  HostName 127.0.0.1
  Port 2222
  User operator
  HostKeyAlias ssh.example.com
  IdentityFile ~/.ssh/id_ed25519
```

ope-termで`ope-term-soak`へ接続し、通常の監視用commandを動かしたままにします。proxyは開始・終了、
接続数、upstream接続数、fault event、drop / blackhole数、双方向bytes、予期しないproxy errorだけを
記録し、payload、認証情報、terminal内容は保存しません。

## 無人soak（headless driver）

GUIを操作し続けなくてもsoakを回せるよう、製品と同じSSH core（`ssh::run`）をWebViewなしで動かす
driverを用意しています。UIと同じ再接続方針（transport断は1→16秒のbackoffで最大5回、使い切ったら
操作者の手動再接続を模して60秒後に再開）を適用し、shellへ一定間隔でheartbeat
（`printf 'ope-term-soak-ack-%s\n' <番号>`）を送り、応答の往復時間を測ります。

- heartbeatは切断時に未応答だったものも含めて再送しません。同じ番号の応答が2回届いた場合は
  replayとして数えます。
- unknown / changed host keyは拒否し、password / keyboard-interactive promptはcancelします。
  agentまたはpassphrase無しの鍵と、`known_hosts`に登録済みのhost keyが必要です。
- reportは接続試行数、ready数、自動再接続数と所要時間、`reason:cause`別の切断数、heartbeatの
  送信 / 応答 / 未応答 / replay / 切断で破棄した数、往復時間p50 / p95 / maxだけを保存し、
  terminal内容は保存しません。

```bash
cargo build --locked --release --manifest-path src-tauri/Cargo.toml --example reliability_soak
DURATION=86400 FAULT_EVERY=900 FAULT_MODE=alternate \
  scripts/reliability-soak ope-term-soak ssh.example.com 22
```

`scripts/reliability-soak` はproxyとdriverを同時に起動し、最後の2分間はfaultを止めて
（blackholeの検出にはkeepalive 15秒×4の約1分とbackoffが必要なため）最後のfaultからの回復を待ち、終了後にproxy report・client report・
gate結果を `artifacts/reliability/<UTC時刻>/` に保存します。

24時間後にreportをgateへ通します。

```bash
just reliability-gate artifacts/reliability/cachyos-24h.json
```

gateは24時間以上、10回以上のfault、drop / blackhole後の再接続、全接続のupstream到達、双方向の
実通信、proxy errorなしを要求します。client reportも渡すと（`node scripts/reliability-gate.mjs
proxy.json client.json`）、fault数に見合う自動再接続、retry budgetの枯渇なし、説明できない切断なし、
heartbeat replayなし、切断で破棄した分を除くheartbeat応答率95%以上も要求します。
TCP接続だけを繰り返してpayloadを交換しなかったreportや、途中で停止したreportは調査材料には
使えますが合格にはなりません。

## 定期実行

| 経路 | 頻度 | 内容 |
|---|---|---|
| `.github/workflows/reliability.yml` | 毎週月曜（手動dispatchも可） | Ubuntu runner上のlocal sshdへ30分、60秒ごとの `alternate` faultを入れ、`ci` profile（25分以上、10 fault以上、応答率90%以上）でgateし、reportをartifactに保存 |
| `contrib/systemd/ope-term-reliability-soak.{service,timer}` | 毎週土曜（lab machine） | CachyOS lab machineで外部SSH先へ24時間、15分ごとのfaultを入れ、既定budgetでgate |

GitHub-hosted runnerはjob時間が6時間に制限されるため、24時間soakはlab machineのsystemd user
timerで回します。unitの導入手順はservice file先頭にあります。reportとjournal
（`journalctl --user -u ope-term-reliability-soak`）をrelease判断の証跡として保存してください。
24時間の完走記録はまだありません。

frontendは再接続ごとに新しいconnection IDを発行し、eventとterminal dataの両方で一致するIDだけを
受け入れます。tab close時はbackendの応答を待たずにIDを無効化するため、遅延frameが破棄済みxtermや
次の接続へ混ざりません。terminal inputはshellがreadyになった `connected` 状態でだけbatchへ入れ、
送信timerでもconnection IDと状態を再検証します。接続待ち・認証中・切断時の入力と未送信bufferは
新しいshellへ持ち越しません。256 KiBを超えるpasteはUTF-8文字境界を保ったchunkへ分け、sessionごとの
Promise chainで順序どおり送るため、IPC上限による全量欠落や並べ替わりを避けます。送信待ちの
合計はsessionごとに4 MiBで停止し、遅い接続中の巨大pasteがmemoryを増やし続けることを防ぎます。

## tmux / screenへ復帰するopt-in workflow

再接続は常に新しいshellです。ope-termが切断前の入力を再送したり、任意commandを暗黙実行したりは
しません。session managerへの復帰は次の境界で実装します。

1. routeまたはHostごとに `none`（既定）/ `tmux` / `screen` を操作者が明示選択する。
2. 保存するのはmodeと検証済みsession名だけにし、自由形式shell commandは保存しない。
3. 初回接続では自動attachしない。transport断から再接続してshellがreadyになった場合だけ候補を出す。
4. `tmux attach-session -t -- <name>` または `screen -r -- <name>` のexact argvを確認画面に表示する。
5. 操作者がその都度 `Attach` を押して実行する。自動入力や切断前bufferの再送はしない。
6. attach失敗は通常shellへ戻し、再試行loopや別sessionへのfallbackを行わない。

session名はportableなASCII subsetへ制限し、shell interpolationを使いません。将来backendに実装する場合も
文字列をshellへ渡さず、固定programとargvとして実行します。

## 自動test

`scripts/fault-proxy.test.mjs` はlocalhost echo serverを起動し、forward、強制drop、blackhole、再接続、
bytes集計、errorなしを毎回の`pnpm test`で確認します。`scripts/reliability-gate.test.mjs` は24時間、
fault数、再接続、upstream到達、双方向通信、errorなし、client reportの各条件とCI profileの境界値を
固定します。Rustの`ssh`テストはin-process russh serverとfault relayで、無音の経路が`timeout`、
socket断が`network`、serverの`SSH_MSG_DISCONNECT`が`remote` / `server_disconnect`になることを
実プロトコルで検証します。`reliability`テストはbackoff、heartbeat照合（echoした入力行は一致しない）、
分割frame、引数を検証します。これらは24時間実機testの代替ではなく、harness自体の回帰gateです。
