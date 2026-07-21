# Command system: chord・when 条件・競合表示・設定 export
Labels: priority:P2, area:ui, enhancement

## 背景

v0.1 は Command Palette と単一 chord のカスタマイズに対応した。VS Code のように pane/terminal/route の文脈で有効キーを切り替えたい。

## 受け入れ条件

- [ ] `Ctrl+K Ctrl+S` のような multi-chord を扱う
- [ ] terminalFocus / routeFocus / paletteOpen 等の context key を定義する
- [ ] shortcut 競合を editor 上で警告する
- [ ] JSON または TOML で export/import できる
- [ ] OS 既定の Ctrl/Cmd 差を表示・移行する
