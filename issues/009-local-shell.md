# Local terminal: OS ネイティブ shell と環境プロファイル
Labels: priority:P1, area:terminal, enhancement

## 背景

開発者向け terminal として SSH だけでなく、PowerShell、bash、zsh、fish 等のローカル PTY が必要。

## 受け入れ条件

- [ ] Windows / Linux / macOS で既定 shell を PTY 起動できる
- [ ] shell profile と working directory を選べる
- [ ] local と SSH を同じ tab/pane lifecycle で扱う
- [ ] shell integration の command boundary を opt-in で取得できる
- [ ] child process を終了時に orphan にしない
