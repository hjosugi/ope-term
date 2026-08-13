# Performance and stability gates

「Tauri だから速い」を受け入れ条件にはしません。ope-term は実測値でリリース可否を決めます。

## 目標

| 項目 | alpha 目標 |
|---|---:|
| cold start から入力可能 | 500 ms 未満 |
| キー入力からローカル描画 | p99 16 ms 未満 |
| idle memory（1 session） | 150 MB 未満 |
| session 追加時の増分 | 20 MB 未満 |
| 大量出力 | 100 MB 連続出力で UI 無応答なし |
| 長時間接続 | keepalive 付き 24 h 維持 |
| 故障影響 | 1 session の通信エラーが他 session を切断しない |

## 現在の対策

- 端末データは Tauri event bus でなく IPC Channel を使用
- キー入力は 4 ms 単位でまとめ、IPC call 数を抑制
- resize は 80 ms debounce
- セッションごとの bounded command queue（64）
- xterm WebGL を優先し、context loss 時は標準 renderer へ戻す
- performance harness は計測有効時だけ、WebGL addon は fallback 強制時以外だけ別 chunk から読む
- production build の main chunk を 500 kB 未満に保ち、optional instrumentation / renderer を分離
- Rust セッション task を terminal ごとに分離
- SSH keepalive 15 s、3 回失敗で切断検出

## 計測 harness

計測は明示的に有効化した実機だけで行います。DevTools console で次を実行して再読み込みします。

```js
localStorage.setItem('ope-term.performance.enabled', 'true');
location.reload();
```

有効時は `window.__opeTermPerformance` が次を記録します。

- navigation start から Host 読み込みとtab復元が終わるまでのcold start
- repeatではないkeydownから次のanimation frameまでのlatency
- Long Tasks APIが使えるengineでのmain-thread stall
- Tauri IPC Channelからxtermへ渡した出力bytesと、100 MiB到達までのthroughput
- xtermのWebGL / fallback renderer

通常利用時はlistenerもobserverも作らないため、計測自体が製品のlatencyへ影響しません。

### Renderer を固定する

同じ環境で比較できるよう、測定前に renderer を明示します。`webgl` は初期化に失敗した場合
toastを出して fallback を report に記録するため、誤って WebGL 結果として扱われません。

```js
localStorage.setItem('ope-term.performance.renderer', 'webgl'); // 1回目
location.reload();

localStorage.setItem('ope-term.performance.renderer', 'fallback'); // 2回目
location.reload();
```

### 100 MiB output

接続先でrepositoryを利用できる場合は、terminalから次を実行します。stdoutへ正確に100 MiBを
streamし、ファイル全体をmemoryへ載せません。

```bash
node scripts/performance-fixture.mjs
```

開始直前にDevTools consoleでcounterをresetします。

```js
window.__opeTermPerformance.resetOutput();
```

### Memory とreport

idle時と1 session接続時に、ope-term関連processのRSS合計を同じOS toolで測ります。Linux例:

```bash
ps -C ope-term -o rss= | awk '{ total += $1 } END { print total / 1024 " MiB" }'
```

100回以上の入力、memory採取、100 MiB出力を終えたらJSONを保存します。`renderer` は実測値で
上書きされるため、呼び出し側は `unknown` で構いません。

```js
window.__opeTermPerformance.download(
  {
    operatingSystem: 'CachyOS Wayland',
    webview: 'WebKitGTK 2.x',
    renderer: 'unknown',
    machine: 'CPU / RAM / GPU',
    commit: 'git commit SHA',
    notes: '電源設定、display scale、cold/warm条件'
  },
  { idleMiB: 100, oneSessionMiB: 115 }
);
```

reportは秘密値やterminal内容を含まず、集計値とenvironment metadataだけを保持します。完了後は
flagを消して通常modeへ戻します。

長時間flagを有効にした場合もmemoryを増やし続けないよう、入力latencyは最新10,000 samplesの
固定容量bufferに保持し、Long Taskは最大値だけを記録します。
optional harness chunkを読み込めない場合はtoastを表示し、terminal本体は通常modeで起動を続けます。

```js
localStorage.removeItem('ope-term.performance.enabled');
location.reload();
```

### Release gate

thresholdの正本はrepository rootの`performance-budgets.json`です。reportを検証し、1項目でも
超過または欠落があればnon-zeroで終了します。

```bash
just performance-gate artifacts/performance/cachyos-webkitgtk-webgl.json
```

最低100 input sample、100 MiB以上のoutputを要求します。gateはtimestamp、percentileの順序、
memory差分、output duration / throughputも検証するため、欠落または自己矛盾したreportは計測結果として
受理しません。Long Tasks APIがないWebKitでは警告を出すため、platform profilerの結果をreportと同じ
artifactに添付します。

WebGL と fallback の2 reportを採取したら、environmentが同一でrendererが正しいことを検証し、
比較delta・OS/session metadata・原本JSONを1 directoryへまとめます。

```bash
just performance-bundle \
  artifacts/performance/cachyos-webkitgtk-webgl.json \
  artifacts/performance/cachyos-webkitgtk-fallback.json \
  artifacts/performance/cachyos-wayland

just performance-gate artifacts/performance/cachyos-webkitgtk-webgl.json
just performance-gate artifacts/performance/cachyos-webkitgtk-fallback.json
```

`artifacts/performance/cachyos-wayland/` を CI artifact に upload します。bundle の manifest は
rendererごとの cold start、p99、memory、throughput、stall とdelta、および Wayland session の有無を
保持し、terminal内容や環境変数値は保存しません。

## 未達・未計測

上表はまだ CI/実機で合否を測定していません。特に Linux の WebKitGTK、Windows の WebView2、macOS の WKWebView は別々に計測します。CachyOS/Wayland を最初の実測対象とし、WebGL と fallback renderer の双方で確認します。

WebKitGTK / WebView2 / WKWebView のWebGL・fallback比較、CachyOS/Wayland実測結果のartifact保存、
24 h soak testは未完了です。report schema・100 MiB fixture・renderer固定・比較bundle・release
gateは実装済みです。
