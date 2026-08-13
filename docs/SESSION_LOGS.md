# Session logs

Session log は host / local shell profile ごとに明示的に有効化します。`Ctrl+Shift+G` で現在の
terminal の設定、`Ctrl+Alt+G` で viewer を開きます。既定は無効で、保存先を native folder
picker で選択するまで有効化できません。

## File 名の固定変数

| 変数 | 値 | 例 |
|---|---|---|
| `{host}` | SSH の最終 alias、local terminal は `local` | `prod-db` |
| `{user}` | SSH config の user、または local OS user | `operator` |
| `{date}` | 接続開始時の UTC date | `2026-08-13` |
| `{time}` | 接続開始時の UTC time | `09-15-30Z` |

既定は `{host}-{user}-{date}-{time}.log` です。未定義変数、path separator、NUL、255 bytes 超の
展開結果を Rust 側で拒否し、template は `.log` で終える必要があります。host/user の危険文字は
`_` に置換します。

## 設定と rotation

- enable、file template、UTC timestamp、rotation size（1–1024 MiB）、保持世代（1–20）を
  host / profile ごとに保存します。
- 保存先 token はアプリ終了までの権限です。実 path や token は localStorage に永続化しないため、
  再起動後に記録を続ける場合は directory を選び直します。
- 出力は bounded queue で専用 writer thread へ送り、terminal rendering を file I/O から分離します。
- logger は通常 file だけを開き、symlink / FIFO を拒否します。Unix で新規作成する log は `0600`
  に固定します。
- active file が上限を超えると `.log.1` へ移し、古い世代を順送りして上限世代を削除します。
- timestamp は行頭へ RFC 3339 UTC で付与します。

## Viewer

viewer は選択 directory の `.log` と `.log.N` だけを一覧・検索します。fuzzy は query 文字の順序
一致、exact は substring、regex は Rust `regex` の線形時間 engine を使用します。
directory 一覧は 10,000 entries で停止します。

file は全読み込みせず 64 KiB の reader buffer で先頭から走査します。1行の保持は 4 KiB、結果は
500 件に制限するため、100 MiB 以上でも file size に比例した memory を確保しません。100 MiB の
sparse fixture を最後まで検索する regression test があります。

## 秘密情報の境界

記録するのは PTY / SSH channel の**出力だけ**です。ope-term の SSH password、OTP、秘密鍵
passphrase prompt は専用 IPC で処理され、terminal input と session logger を通らないため記録
されません。通常 terminal input も logger へ渡しません。

!!! warning "remote / child output は秘密を含み得ます"

    remote command が秘密を出力した場合や、PTY が通常入力を echo した場合、その表示 byte は
    log に含まれます。password prompt は通常 echo を無効化しますが、任意 application の挙動までは
    保証できません。必要な host だけを有効化し、保存先の OS permission と保持期間を管理して
    ください。
