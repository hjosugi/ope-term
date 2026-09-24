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
  child waitは生成失敗し得る専用threadではなくTokio blocking taskで所有する。
- closeはUnixでshellのprocess groupへSIGHUP、2秒後にSIGKILL、回収は5秒で打ち切る。HUPを
  無視するshellと孫processが残らないことをLinux testで固定。最後にPTY masterを閉じる。
- アプリ終了（`RunEvent::Exit`）で全terminalへcloseを送り、各taskの回収完了を最大4秒待つ。
  接続処理中にtabを閉じた場合は登録完了後にcloseを送り直す。
- OSC 133は`C`→`D`だけをcommandとして数え、失敗数とexit codeを表示する。prompt位置にxterm
  markerを置き、`terminal.previousCommand` / `terminal.nextCommand`で移動できる。
