# Performance: WebKitGTK を含む描画・IPC 回帰ゲート
Labels: priority:P0, performance, reliability

## 背景

高パフォーマンスと安定性は必須要件だが、`docs/PERFORMANCE.md` の目標はまだ実測されていない。

## 受け入れ条件

- [ ] cold start、input latency p50/p95/p99、memory を計測する harness を作る
- [ ] 100 MB output fixture で throughput と main-thread stall を記録する
- [ ] WebGL / fallback を WebKitGTK、WebView2、WKWebView で比較する
- [ ] CachyOS Wayland 実機結果を artifact として保存する
- [ ] 基準超過を CI または release gate で検出する
