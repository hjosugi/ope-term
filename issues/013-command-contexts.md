# Command system: chord・when 条件・競合表示・設定 export
Labels: priority:P2, area:ui, enhancement

## 背景

v0.1 は Command Palette と単一 chord のカスタマイズに対応した。VS Code のように pane/terminal/route の文脈で有効キーを切り替えたい。

## 受け入れ条件

- [x] `Ctrl+K Ctrl+S` のような multi-chord を扱う（最大4 chord、1.2秒 timeout）
- [x] terminalFocus / routeFocus / paletteOpen 等の context key を定義する
- [x] shortcut 競合を editor 上で警告する（同時に成立しない context は競合扱いしない）
- [x] JSON で export/import できる（version付き、64 KiB上限、未知commandは無視）
- [x] OS 既定の Ctrl/Cmd 差を表示・移行する（macOSはCmd、Linux/WindowsはCtrl）
