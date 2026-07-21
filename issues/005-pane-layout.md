# Terminal panes: zellij 風の分割・移動・リサイズ
Labels: priority:P1, area:terminal, area:ui

## 背景

複数サーバーを比較・監視する運用ではタブだけでなく同時表示が必要。

## 受け入れ条件

- [ ] 左右/上下分割、close、focus 移動をキーボードと pointer で行える
- [ ] 分割時に新規 route または既存 session を選べる
- [ ] xterm instance を再接続せず別 pane へ移せる
- [ ] divider の drag と keyboard resize に対応する
- [ ] 全コマンドを Command Palette と Keyboard Shortcuts に公開する
