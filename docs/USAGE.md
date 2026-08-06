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

## ルートの保存と復元

毎日同じ踏み台と接続先を組み直さないために、ルートに名前を付けて保存できます。

- SAVED ROUTES に名前を入力して `ルートを保存`（`Ctrl+Shift+S`）で保存します。
  名前を省略すると接続先の alias を使います。
- 保存するのは `~/.ssh/config` の alias だけです。hostname / user / port / ProxyJump は
  複製せず、接続時に毎回 config を解決します。
- 保存済みルートは `読み込む` で ROUTE WORKBENCH へ戻すか、`接続` で直接つなぎます。
  Command Palette からは `Workspace` として検索できます。
- 終了時のタブと選択中のタブを記録し、次の起動でタブだけを復元します。

!!! note "復元しただけでは接続しません"

    踏み台へ通信を出すタイミングは常に操作者が決めます。復元したタブは
    `接続`、`CONNECT`、`Ctrl+Shift+Enter` のいずれかで開始します。

- 切断済みのタブは同じタブのまま `再接続`（`Ctrl+Shift+Enter`）できます。
  scrollback とタブ位置は保持します。
- config から alias が消えた場合は degraded 表示になります。該当ルートとピースを
  赤く示し、接続ボタンを無効にして、消えた Host 名を表示します。

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
    再 attach は [ロードマップ](ROADMAP.md) の Reliability issue で扱います。

## ホスト鍵の確認

初回接続では hostname、port、hop、algorithm、SHA256 fingerprint を確認画面に表示します。
管理者や別の安全な経路で fingerprint を照合し、「今回のみ信頼」または「信頼して保存」を
選びます。保存先は OpenSSH と共通の `~/.ssh/known_hosts` です。

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
| `Ctrl+Shift+S` | 現在のルートを保存 |
| `Ctrl+Shift+R` | SSH config を再読み込み |
| `Ctrl+W` | 現在のセッションを閉じる |
| `Ctrl+Tab` | 次のセッション |
| `Ctrl+Shift+Enter` | 現在のセッションへ接続 / 再接続 |
| `Ctrl+Shift+K` | Keyboard Shortcuts |

Command Palette で `Keyboard Shortcuts` を開き、キー欄をクリックして新しい組み合わせを
入力できます。変更は Tauri WebView のローカルストレージへ保存されます。

multi-chord や文脈依存のキー割り当ては [ロードマップ](ROADMAP.md) の Command system issue
で扱います。
