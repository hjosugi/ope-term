# Local terminal

`Ctrl+Shift+L`、または Command Palette の `新しい local terminal を開く` から、OS の native
PTY で local shell を起動できます。terminal pane の picker から `local terminal を開く` を
選べば、SSH terminal の右または下にも配置できます。

## Profile と working directory

- `Default shell` は Unix の absolute `SHELL`（不正な場合は `/bin/sh`）、Windows の
  `COMSPEC`（不在時は `cmd.exe`）です。
- Linux / macOS は実在する bash / zsh / fish、Windows は PowerShell / Command Prompt を
  固定 profile として提示します。
- WebView から program や argument を渡す API はありません。選べるのは Rust 側で検出した
  profile ID だけです。
- working directory は native folder picker で選択します。directory の実 path は Rust core
  が token に対応付け、local session の起動時にだけ解決します。

local terminal も xterm、tab、左右・上下 pane、focus、resize、close、scrollback を SSH と共有
します。shell が `exit` すると tab は closed になり、`Ctrl+Shift+Enter` で同じ profile を
再起動できます。local shell にはネットワーク断の概念がないため自動再接続はしません。

## Shell integration（opt-in）

作成画面で `OSC 133 command boundary を取得する` を有効にすると、shell や prompt integration
が出力する OSC 133 marker を xterm parser で受け取り、hopbar に検出数を表示します。既定では
無効です。ope-term は shell の設定 file を変更せず、command text、cwd、exit status を marker
から保存しません。

有効時は child environment に `OPE_TERM_SHELL_INTEGRATION=1` を設定します。既存の shell 設定が
この変数を見て OSC 133 を出す構成にできます。marker は child process が自由に出力できるため、
セキュリティ境界や監査記録には使わないでください。

## Process lifecycle

各 session は PTY master、reader、writer、child wait handle を所有します。tab を閉じると child
killer を呼び、終了を wait してから session を完了します。command channel が失われた場合も
同じ close path に入り、child を orphan にしません。起動途中で reader / writer thread を作れ
なかった場合も child を kill + wait します。

native PTY smoke test は Linux の通常 CI と Windows / macOS matrix で shell の起動、出力、終了
回収を検証します。

