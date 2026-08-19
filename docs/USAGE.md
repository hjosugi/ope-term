# 使い方

## SSH config

接続の正本は `~/.ssh/config` です。ope-term 専用にホスト情報を複製しません。

```sshconfig
Host bastion
  HostName bastion.example.com
  User operator
  IdentityFile ~/.ssh/id_ed25519

Host prod-db
  HostName 10.20.0.15
  User admin
  ProxyJump bastion
```

左の SSH CONFIG 一覧には、wildcard を含まない `Host` の alias が並びます。
config を編集したら `Ctrl+Shift+R`（一覧見出しの `↻`）で再読み込みします。
開いているセッションは切断されません。

## ルートの組み方

1. 左の Host をクリックするか ROUTE WORKBENCH へドラッグします。
2. 1 ピースなら、その Host の `ProxyJump` を自動展開します。
3. 2 ピース以上なら、ピースを並べた順で明示ルートとして接続します。
4. `CONNECT` または `Ctrl+Enter` で接続します。

明示ルートは `jump-a → jump-b → target` の各区間を SSH `direct-tcpip` で接続します。
各 hop は個別に認証されます。

## ROUTE MAP

ROUTE WORKBENCH の下の ROUTE MAP は、`~/.ssh/config` が実際にたどる踏み台の並びを
そのまま列にした図です。

- 列は hop の深さです。`直結` は踏み台を経由せずに接続する Host、`1 段目` はもう 1 台
  経由する Host、というように右へ伸びます。踏み台は必ず、それが運ぶ Host の左に来ます。
- カードにカーソルかキーボードフォーカスを当てると、その Host へ至る経路の線と Host
  だけが点灯します。関係のない経路は暗いままなので、どこを通るのかが 1 目で分かります。
- `JUMP` は他の Host がその Host を経由していることを示します。`ProxyJump 参照のみ` は
  `ProxyJump` から参照されているのに Host ブロックが無い alias で、破線で表示します。
- 接続中のセッションが通っている Host には `LIVE` が付きます。
- カードをクリックすると、その Host が ROUTE WORKBENCH へ読み込まれ、`CONNECT` に
  フォーカスが移ります。ワークベンチのルートは常時点灯し続けます。

Host が多い config では先頭 200 件までを描画し、残りは件数だけを図の下に出します。

## ルートの保存と復元

毎日同じ踏み台と接続先を組み直さないために、ルートに名前を付けて保存できます。

- SAVED ROUTES に名前を入力して `ルートを保存`（`Ctrl+K Ctrl+S`）で保存します。
  名前を省略すると接続先の alias を使います。
- 保存するのは `~/.ssh/config` の alias だけです。hostname / user / port / ProxyJump は
  複製せず、接続時に毎回 config を解決します。
- 保存済みルートは `読み込む` で ROUTE WORKBENCH へ戻すか、`接続` で直接つなぎます。
  Command Palette からは `Workspace` として検索できます。
- 終了時のタブ、選択中のタブ、pane の分割方向と比率を記録し、次の起動で復元します。

!!! note "復元しただけでは接続しません"

    踏み台へ通信を出すタイミングは常に操作者が決めます。復元したタブは
    `接続`、`CONNECT`、`Ctrl+Shift+Enter` のいずれかで開始します。

- 切断済みのタブは同じタブのまま `再接続`（`Ctrl+Shift+Enter`）できます。
  scrollback とタブ位置は保持します。
- config から alias が消えた場合は degraded 表示になります。該当ルートとピースを
  赤く示し、接続ボタンを無効にして、消えた Host 名を表示します。
- private modeやquota不足でWebView storageへ保存できない場合も、terminal操作は中断しません。
  UIに警告を表示し、workspaceやshortcutの変更は現在の起動中だけ保持します。

## Terminal pane

topbar の `▥` で右、`⬒` で下へ分割します。picker では、tab に残っている非表示の既存
session、または新しく組み立てる route を選べます。既存 session を選んだ場合は xterm と
SSH 接続を作り直さず、その DOM を pane へ移します。

- pane 内をクリックするか focus command で操作対象を切り替えます。
- divider を pointer で drag するか resize command で比率を変更します。最小比率は 15% です。
- hopbar の `×` または `Pane: 現在の pane を閉じる` は表示だけを閉じます。session と接続は
  tab に残るため、tab を選ぶと現在の pane へ戻せます。
- tab 自体の `×` または `Ctrl+W` は session を終了します。
- 非表示 tab を選ぶと、focus 中の pane の内容だけをその session へ入れ替えます。

分割レイアウトの復元時も接続は自動開始しません。各 pane は前回の route を表示した idle
terminal として戻ります。

## SFTP file manager

接続済み session で `Ctrl+Shift+F` を押すと terminal の右隣に local / remote の 2 ペインを
開きます。native picker で local directory を選び、file を選択して upload / download します。
queue、進捗、cancel、retry と安全上の制約は [SFTP file manager](SFTP.md) を参照してください。

## Local terminal

`Ctrl+Shift+L` で作成画面を開き、OS の既定 shell または検出済み profile と working directory を
選びます。SSH と同じ tab / pane / resize / close lifecycle で動きます。shell integration は
OSC 133 marker の受信だけを opt-in にできます。詳細は [Local terminal](LOCAL_TERMINAL.md) を
参照してください。

## Session logs

`Ctrl+Shift+G` で現在の host / local profile の記録を明示的に有効化し、native picker で保存先、
file template、timestamp、rotation を設定します。`Ctrl+Alt+G` で viewer を開き、fuzzy / exact /
regex を切り替えて逐次検索できます。固定変数と秘密情報の境界は [Session logs](SESSION_LOGS.md)
を参照してください。

## 切断と再接続

セッションが終わった理由を 4 つに分けて表示し、再接続の扱いを変えます。

| 理由 | 例 | 自動再接続 |
|---|---|---|
| `local` | タブを閉じた、`Ctrl+W` | しない |
| `remote` | `exit` した、リモート側で kill された | しない |
| `transport` | keepalive timeout、ネットワーク切替、接続断 | **する** |
| `failed` | config・ホスト鍵・認証で shell に到達しなかった | しない |

`transport` の場合だけ、1 秒 → 2 秒 → 4 秒 → 8 秒 → 16 秒（上限 30 秒）の
exponential backoff で最大 5 回まで自動再接続します。hopbar に残り秒数と試行回数を出し、
`今すぐ` で即時再試行、`自動再接続を停止` で打ち切れます。接続に成功すると試行回数は
リセットされます。

拒否された認証や変更されたホスト鍵は、再試行しても結果が変わらないうえ、アカウント
ロックや警告の連発につながるため自動再接続しません。手動の `再接続`
（`Ctrl+Shift+Enter`）はどの理由でも使えます。

!!! warning "入力は再送しません"

    切断時に未送信の入力は破棄します。再接続は新しい shell を開くため、書きかけの
    コマンドが新しいプロンプトへ流れ込むことはありません。tmux / screen への
    再 attach は [長時間接続と再接続](RELIABILITY.md) のopt-in境界に従います。

## ホスト鍵の確認

初回接続では hostname、port、hop、algorithm、SHA256 fingerprint を確認画面に表示します。
管理者や別の安全な経路で fingerprint を照合し、「今回のみ信頼」または「信頼して保存」を
選びます。保存先は OpenSSH と共通の `~/.ssh/known_hosts` です。
安全で予測可能な追記のため、保存先は16 MiB以下の通常fileに限定し、symlinkは拒否します。

ope-term は未知のホスト鍵を自動承認しません。保存済みの鍵が変わった場合は接続を拒否し、
既存行を UI から上書きしません。変更が正当だと確認できた場合のみ、OpenSSH の
`ssh-keygen -R` などで既存鍵を手動削除して再接続してください。

## SSH 認証

各 hop はサーバーが提示する方式に従い、ssh-agent / 公開鍵、keyboard-interactive、
password の順で認証します。暗号化された `IdentityFile` にはパスフレーズを要求します。
keyboard-interactive は、password と OTP のような複数質問および複数ラウンドに対応します。

認証画面には要求元 hop とユーザー名を常時表示します。入力値は localStorage、console、
エラーへ記録せず、DOM 入力欄は送信前に消去し、短命な IPC 応答バッファも送信後に消去します。
各 prompt は 5 分で timeout し、キャンセルするとその hop への接続を中止します。

## コマンドとショートカット

| 既定キー | コマンド |
|---|---|
| `Ctrl+Shift+P` | Command Palette |
| `Ctrl+K` | Host 検索 |
| `Ctrl+Enter` | 現在のルート、または選択中タブへ接続 |
| `Ctrl+Backspace` | ルートをクリア |
| `Ctrl+N` | 新しいルート |
| `Ctrl+K Ctrl+S` | 現在のルートを保存 |
| `Ctrl+Shift+R` | SSH config を再読み込み |
| `Ctrl+W` | 現在のセッションを閉じる |
| `Ctrl+Tab` | 次のセッション |
| `Ctrl+Shift+Enter` | 現在のセッションへ接続 / 再接続 |
| `Ctrl+Shift+F` | SFTP file manager を開く / 閉じる |
| `Ctrl+Shift+L` | 新しい local terminal を開く |
| `Ctrl+Shift+G` | 現在の host / profile の session log を設定 |
| `Ctrl+Alt+G` | Session log viewer |
| `Ctrl+K Ctrl+ArrowRight` | 右に分割 |
| `Ctrl+K Ctrl+ArrowDown` | 下に分割 |
| `Ctrl+Alt+Arrow` | 指定方向の pane へ focus |
| `Ctrl+K Ctrl+X` | 現在の pane を閉じる（session は残す） |
| `Ctrl+K Ctrl+Shift+Arrow` | 現在の pane を広げる / 狭める |
| `Ctrl+K Ctrl+K` | Keyboard Shortcuts |

Command Palette で `Keyboard Shortcuts` を開き、キー欄をクリックして新しい組み合わせを
入力できます。multi-chord は続けて入力し、最後の入力から1.2秒後に確定します。最大4 chord
まで設定できます。変更は Tauri WebView のローカルストレージへ保存されます。

macOS では既定の `Ctrl` を `Cmd` として表示・実行し、Linux / Windows では `Ctrl` を使います。
別OSで保存したJSONを読み込むと primary modifier を現在のOSへ移行します。旧v1設定は、
macOSで初めて開いたときに既定値だけをCmdへ移し、明示的なCtrl customizationは保持します。

各commandには `terminalFocus`、`routeFocus`、`paletteOpen`、`shortcutEditorOpen` の context keyを
組み合わせた `when` 条件があります。同じkey sequenceでも同時に成立しないcontextなら共存でき、
同時に成立する割り当てはeditorで赤い競合警告を表示します。

footerの `JSON を保存` / `JSON を読込` でversion付き設定を持ち運べます。読込は64 KiBに制限し、
未知commandを無視して不足項目を現在OSの既定値で補います。
