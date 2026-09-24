# Terminal panes: zellij 風の分割・移動・リサイズ
Labels: priority:P1, area:terminal, area:ui

## 背景

複数サーバーを比較・監視する運用ではタブだけでなく同時表示が必要。

## 受け入れ条件

- [x] 左右/上下分割、close、focus 移動をキーボードと pointer で行える
- [x] 分割時に新規 route または既存 session を選べる
- [x] xterm instance を再接続せず別 pane へ移せる
- [x] divider の drag と keyboard resize に対応する
- [x] 全コマンドを Command Palette と Keyboard Shortcuts に公開する

## 実装メモ

- 単独paneのleafもstageいっぱいに広げ、分割前の1 paneが0高にならないようにする。
- `pane.move*`（`Ctrl+Shift+Alt+Arrow`）で表示中sessionを隣のpaneと入れ替える。session viewを
  re-parentするだけなのでxtermとSSH接続は維持される。
- dividerは`role="separator"`と`aria-value*`を持ち、focus中の矢印キー / Home / Endで比率を変える。
- layout再描画でxtermやdividerがDOMから外れてもfocusを同じdividerまたはactive terminalへ戻す。
- cancelしたlocal terminal dialogやprofile取得失敗で、保留中の分割要求を残さない。
