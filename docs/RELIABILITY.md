# 長時間接続と再接続

ope-term はtransport断だけをexponential backoffで再接続します。remote shellの終了、認証失敗、
host key変更、操作者によるcloseは自動再試行しません。このページは24時間soak testと、再接続後に
tmux / screenへ安全に復帰する方針を定義します。

## Root権限不要のfault injection

`scripts/fault-proxy.mjs` はlocalhostでTCPを中継し、既定で15分ごとに確立済みsocketを切断します。
新しい接続は受け続けるため、ope-termのbackoff再接続を実ネットワーク設定やroot権限なしで検証できます。

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
接続数、upstream接続数、fault event、drop数、双方向bytes、予期しないproxy errorだけを記録し、
payload、認証情報、terminal内容は保存しません。

24時間後にreportをgateへ通します。

```bash
just reliability-gate artifacts/reliability/cachyos-24h.json
```

gateは24時間以上、10回以上のfault、drop後の再接続、全接続のupstream到達、双方向の実通信、
proxy errorなしを要求します。TCP接続だけを繰り返してpayloadを交換しなかったreportや、途中で停止した
reportは調査材料には使えますが合格にはなりません。実機の定期実行は
CachyOS lab machineのsystemd timerで行い、reportとjournalをrelease artifactへ保存します。

frontendは再接続ごとに新しいconnection IDを発行し、eventとterminal dataの両方で一致するIDだけを
受け入れます。tab close時はbackendの応答を待たずにIDを無効化するため、遅延frameが破棄済みxtermや
次の接続へ混ざりません。terminal inputはshellがreadyになった `connected` 状態でだけbatchへ入れ、
送信timerでもconnection IDと状態を再検証します。接続待ち・認証中・切断時の入力と未送信bufferは
新しいshellへ持ち越しません。

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

`scripts/fault-proxy.test.mjs` はlocalhost echo serverを起動し、forward、強制drop、再接続、bytes集計、
errorなしを毎回の`pnpm test`で確認します。`scripts/reliability-gate.test.mjs` は24時間、fault数、再接続、
upstream到達、双方向通信、errorなしの境界値を固定します。これらは24時間実機testの代替ではなく、
harness自体の回帰gateです。
