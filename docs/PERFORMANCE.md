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
- セッションごとの bounded command queue（256）
- xterm WebGL を優先し、context loss 時は標準 renderer へ戻す
- Rust セッション task を terminal ごとに分離
- SSH keepalive 15 s、3 回失敗で切断検出

## 未達・未計測

上表はまだ CI/実機で合否を測定していません。特に Linux の WebKitGTK、Windows の WebView2、macOS の WKWebView は別々に計測します。CachyOS/Wayland を最初の実測対象とし、WebGL と fallback renderer の双方で確認します。

回帰ベンチ、100 MB fixture、24 h soak test、計測結果の保存は performance issue の完了条件です。
