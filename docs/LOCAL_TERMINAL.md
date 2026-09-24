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
が出力する OSC 133 marker（`A` prompt 開始、`B` command 入力開始、`C` 実行開始、`D[;exit]`
終了）を xterm parser で受け取ります。既定では無効です。

- `C` の後の `D` だけを 1 command と数え、hopbar に command 数、非 0 終了の件数、実行中
  または直前の exit code を表示します。空 prompt で `D` を出す shell でも水増ししません。
- `A` の位置に xterm marker を置き（最大 1,000 件、scrollback から消えた marker は破棄）、
  `Ctrl+ArrowUp` / `Ctrl+ArrowDown`（macOS は `Cmd`）または Command Palette の
  `前の command へ移動` / `次の command へ移動` で prompt 間を移動できます。
- 未知の `133;` sub-command は表示せずに捨てます。exit code は 10 桁以内の整数だけを受け付けます。
- ope-term は shell の設定 file を変更せず、command text と cwd を保存しません。

有効時は child environment に `OPE_TERM_SHELL_INTEGRATION=1` を設定します。既存の shell 設定が
この変数を見て OSC 133 を出す構成にできます。例（bash / zsh / fish）:

```bash
# ~/.bashrc
if [[ -n "$OPE_TERM_SHELL_INTEGRATION" ]]; then
  PS0='\[\e]133;C\a\]'
  PROMPT_COMMAND='printf "\e]133;D;%s\a" "$?"'"${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
  PS1='\[\e]133;A\a\]'"$PS1"'\[\e]133;B\a\]'
fi
```

```zsh
# ~/.zshrc
if [[ -n "$OPE_TERM_SHELL_INTEGRATION" ]]; then
  preexec() { print -n '\e]133;C\a' }
  precmd() { print -n "\e]133;D;$?\a\e]133;A\a" }
  PS1="$PS1"$'%{\e]133;B\a%}'
fi
```

```fish
# ~/.config/fish/config.fish
if set -q OPE_TERM_SHELL_INTEGRATION
    function __ope_term_preexec --on-event fish_preexec; printf '\e]133;C\a'; end
    function __ope_term_postexec --on-event fish_postexec; printf '\e]133;D;%s\a' $status; end
    function __ope_term_prompt --on-event fish_prompt; printf '\e]133;A\a'; end
end
```

marker は child process が自由に出力できるため、セキュリティ境界や監査記録には使わないで
ください。

## Process lifecycle

各 session は PTY master、reader / writer thread、child wait blocking taskを所有します。tab を閉じると
terminal window を閉じたときと同じ順で shell を終了させます。

1. Unix では shell の process group（portable-pty は shell を `setsid` で起動するため pid = group
   id）へ `SIGHUP` を送り、foreground job も一緒に hang up させます。Windows は shell を終了します。
2. 2 秒以内に終わらなければ process group へ `SIGKILL` を送ります。`trap '' HUP` した shell や
   job も残りません。
3. 回収は最大 5 秒で打ち切り、close 要求が永久に止まることはありません。最後に PTY master を
   閉じます。Windows では pseudoconsole を閉じることで接続中の console client も終了します。

command channel が失われた場合、入力 / resize が失敗した場合も同じ close path に入ります。起動途中で
reader / writer thread を作れなかった場合も child を kill + wait します。`nohup` / `setsid` /
`disown` で利用者が明示的に切り離した job は対象外です。

アプリ終了時（最後の window を閉じたとき）は、開いている local / SSH terminal すべてへ close を
送り、各 session task が child を回収して registry から外れるまで最大 4 秒待ってから終了します。
接続処理中に tab を閉じた場合も、backend の登録完了後に close を送り直すため、tab の無い shell は
残りません。

native PTY smoke test は Linux の通常 CI と Windows / macOS matrix で shell の起動、出力、終了
回収を検証します。Linux では `SIGHUP` を無視する shell と孫 process が close 後に残らないこと、
アプリ終了処理がすべての terminal task の完了を待つことも test で固定しています。
