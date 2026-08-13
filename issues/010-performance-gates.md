# Performance: WebKitGTK を含む描画・IPC 回帰ゲート
Labels: priority:P0, performance, reliability

## 背景

高パフォーマンスと安定性は必須要件だが、`docs/PERFORMANCE.md` の目標はまだ実測されていない。

## 受け入れ条件

- [x] cold start、input latency p50/p95/p99、memory を計測する harness を作る
- [x] 100 MB output fixture で throughput と main-thread stall を記録する
- [ ] WebGL / fallback を WebKitGTK、WebView2、WKWebView で比較する
- [ ] CachyOS Wayland 実機結果を artifact として保存する
- [x] 基準超過を release gate で検出する（version付きJSONを `just performance-gate` で判定）

## 計測準備

- `ope-term.performance.renderer` で WebGL / fallback を明示固定し、実際に選ばれた renderer を
  report に記録する。WebGL 強制失敗は toast と fallback report になる。
- `just performance-bundle <webgl.json> <fallback.json> <output>` が同一 environment / commit と
  renderer を検証し、metric delta・Wayland session metadata・原本を artifact directory にまとめる。
- performance harness と WebGL addon を optional chunk へ分離し、production main chunk の
  500 kB 警告を解消。fallback 強制時は WebGL addon を読み込まない。
- input latencyは最新10,000 samplesに制限し、Long Taskは最大値だけを保持して、長時間の
  profilingでもharness自身がmemoryを増やし続けないようにする。
- 残る2条件は WebKitGTK / WebView2 / WKWebView 実機測定と CachyOS Wayland での採取そのもの。
  未計測値は作らず、実機 report を保存してから check する。
