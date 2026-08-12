# Local terminal: OS ネイティブ shell と環境プロファイル
Labels: priority:P1, area:terminal, enhancement

## 背景

開発者向け terminal として SSH だけでなく、PowerShell、bash、zsh、fish 等のローカル PTY が必要。

## 受け入れ条件

- [x] Windows / Linux / macOS で既定 shell を PTY 起動できる
- [x] shell profile と working directory を選べる
- [x] local と SSH を同じ tab/pane lifecycle で扱う
- [x] shell integration の command boundary を opt-in で取得できる
- [x] child process を終了時に orphan にしない

## 実装メモ

- `portable-pty` で Unix PTY / Windows ConPTY を共通化。Linux と Windows / macOS CI matrix で
  native shell の起動・出力・wait smoke test を実行する。
- IPC は Rust が列挙した profile ID のみを受け、任意 executable / argument は受け付けない。
- working directory は native picker token を再利用。tab / pane / xterm / input / resize / close は
  SSH session と共通 lifecycle。
- OSC 133 handler は opt-in。marker 数だけを表示し、command 内容を保存しない。
- close、command channel 終了、reader / writer thread の起動失敗で child を kill + wait する。
