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

export/importとlocalStorageの読込・保存はJSON parse / write前に64 KiBで停止する。

## 追加実装

- Linux / Windows でterminalにfocusがある間は素の`Ctrl+<key>`をshellへ渡す。terminal用command
  の既定値を`Ctrl+Shift+W`と`Ctrl+Shift+K`始まりのchordへ移し、旧既定値のままの保存値は移行する。
  macOSの次のsessionは`Cmd+Tab`を避けて`Ctrl+Tab`。
- `paletteOpen`をpalette表示中の修飾キー付きshortcut評価で実際に使い、`Ctrl+Shift+P`でtoggleする。
- editorは競合に加えprefix（1.2秒待ち）、修飾キー無し、OS / shell予約キーを警告し、recorderは
  修飾キー無しの最初のchordを拒否する。importは不正キー数と競合数を通知する。
- exportはnative保存dialogとRust側のversion付きJSON検証で書き出す（WebViewの`<a download>`に依存しない）。
- Ctrl/Cmdの移行は両方向で再正規化し、既定値のままの割り当ては移行先OSの既定値にする。Windowsは`Win`表示。
