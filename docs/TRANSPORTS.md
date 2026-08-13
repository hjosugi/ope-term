# Transport boundary: SSH / local / telnet / serial

ope-term が現在接続できるのは SSH2 と local PTY だけです。telnet と serial console は
候補であり、まだ UI・IPC・backend の接続入口を持ちません。SSH1 と rlogin は今後も
対象外です。このページは、候補を実装する前に満たす互換性・安全性・OS lifecycle の
境界を固定する設計記録です。

## 現在のコード境界

Rust core の `transport.rs` は interactive terminal に共通する操作だけを公開します。

| 共通操作 | 意味 |
|---|---|
| `Input` | 利用者が現在の terminal へ明示的に送った bytes |
| `Resize` | 表示中の terminal の cols / rows |
| `close` | pending I/O を解除し、backend を停止して resource を回収 |

`TerminalControl` は SSH と local PTY を同じ session registry で管理し、共通操作を各 backend
の bounded channel へ変換します。一方、host-key verification、authentication、ProxyJump、
SFTP は `SessionControl` に残します。これらを将来の telnet / serial implementation に
見せたり、存在しない安全性を UI で示したりしてはいけません。

新 transport は次の順序で追加します。

1. 共通の data / input / resize / close / close-reason contract に adapter を追加する。
2. transport 固有の option と lifecycle は専用 module に閉じ込める。
3. UI は capability を見て操作を表示し、SSH 専用操作を transport 名の条件分岐で推測しない。
4. reconnect、log、macro、credential の各 policy を個別に opt-in しない限り無効のままにする。

## 実機設定から得た最小要件

Cisco の router / switch console の公開手順では、代表的な既定値は 9600 baud、8 data bits、
parity none、1 stop bit、flow control none です。一方、同社製品でも変更可能な baud rate は
2400 から 115200 まであり、構成変更後は 9600 では接続できない場合があります。したがって
`9600 8-N-1 none` は初期値にはできても固定値にはできません。

serial profile が保持できる設定は次に限定します。

| 設定 | 初期値 | 初回候補 | 備考 |
|---|---:|---|---|
| baud | 9600 | 1200 / 2400 / 4800 / 9600 / 19200 / 38400 / 57600 / 115200 | OS が拒否した値は使用しない |
| data bits | 8 | 5 / 6 / 7 / 8 | device の資料を優先 |
| parity | none | none / even / odd | mark / space は需要確認後 |
| stop bits | 1 | 1 / 2 | 1.5 は初回対象外 |
| flow control | none | none / XON-XOFF / RTS-CTS | device が非対応なら強制しない |
| line ending | CR | CR / LF / CRLF / raw | 送信時だけ変換し、受信 bytes は変えない |
| terminal type | VT100 | VT100 / xterm | device 固有値は bounded ASCII input |
| break | 手動のみ | duration を固定候補から選択 | paste や macro から送らない |

対象 use case は、network appliance の初期設定・障害復旧、USB serial adapter を介した
console、隔離された管理 network に残る legacy telnet CLI です。一般的な Internet host、
ファイル転送、TN3270、modem control は初回対象にしません。

根拠:

- [Cisco: terminal emulator settings](https://www.cisco.com/c/en/us/support/docs/storage-networking/management/217970-troubleshoot-and-apply-correct-terminal.html)
- [Cisco Connected Grid Router console ports](https://www.cisco.com/c/en/us/td/docs/routers/access/2000/CGR2010/hardware/installation/guide/CGR2010_HIG/Preinstall.html)

### 需要検証の exit criteria

desk research だけでは「実装する価値がある」ことは確定しません。implementation issue を
切る前に、少なくとも次を匿名化して issue へ記録します。

- 3 人以上の operator と、2 系統以上の実機 family
- transport、接続頻度、緊急時か定常作業か、現在の代替 tool
- 必須 option / serial setting と、接続できない場合の業務影響
- credential・paste・session log・自動再接続を禁止すべき運用規則
- maintainer が試せる hardware、loopback、または再現可能な protocol fixture

exit criteria を満たすまでは、telnet / serial は roadmap 上の候補のままです。

## Telnet の protocol contract

telnet は raw TCP terminal ではありません。data stream 中の `IAC` command、option negotiation、
subnegotiation、NVT の CR/LF 規則を incremental state machine で処理する必要があります。
chunk 境界が command 境界と一致する前提を置かず、data 中の `IAC IAC` も復元します。

初回 implementation が扱う option は次に絞ります。

| Option | code | 方針 |
|---|---:|---|
| BINARY | 0 | 両方向を独立に交渉し、拒否時は NVT 規則へ戻す |
| ECHO | 1 | server echo の状態を UI input policy に反映する |
| SUPPRESS-GO-AHEAD | 3 | character-at-a-time terminal 用に交渉する |
| TERMINAL-TYPE | 24 | bounded allowlist の値だけ返す |
| NAWS | 31 | resize 後に bounded 16-bit cols / rows を送る |

未知 option は必ず `WONT` / `DONT` で拒否し、negotiation loop を抑止します。`AYT`、`IP`、
`BREAK` などの command は通常 input と分けて明示操作にします。TN3270 / EOR、STARTTLS、
authentication option は初回対象外です。互換 fixture は IAC を全 byte offset で分割し、
重複交渉、malformed subnegotiation、最大長、NAWS resize を含めます。

根拠:

- [RFC 854: Telnet Protocol Specification](https://www.rfc-editor.org/rfc/rfc854.html)
- [RFC 1123 section 3.3: Telnet requirements](https://www.rfc-editor.org/rfc/rfc1123.html#section-3.3)
- [RFC 856: Binary Transmission](https://www.rfc-editor.org/rfc/rfc856.html)
- [RFC 857: Echo](https://www.rfc-editor.org/rfc/rfc857.html)
- [RFC 858: Suppress Go Ahead](https://www.rfc-editor.org/rfc/rfc858.html)
- [RFC 1091: Terminal Type](https://www.rfc-editor.org/rfc/rfc1091.html)
- [RFC 1073: Negotiate About Window Size](https://www.rfc-editor.org/rfc/rfc1073.html)

## 平文 transport の safety gate

telnet を追加する変更は、以下を同じ pull request で満たさない限り merge しません。

- route editor、接続確認、tab header、接続中 status に消せない `PLAINTEXT` 表示を出す。
- 接続ごとに exact `host:port` と「暗号化も host authentication もない」ことを確認する。
- Internet 公開 address か private address かを安全性の根拠にしない。
- password / OTP / username を profile、workspace、履歴、log に保存しない。
- command macro、startup command、broadcast input、paste automation を使用不能にする。
- session log と自動再接続を既定無効にする。初回 release では有効化 UI も提供しない。
- SSH の鍵 icon、known-hosts 表示、認証済み表示を再利用しない。

serial も、device へ認証文字列や破壊的 command を誤送信しないよう、macro、broadcast input、
startup command、credential 保存、自動再接続を初回 release では無効にします。session log は
明示 opt-in と保存先確認を SSH と同じ条件にします。

## Serial device と OS lifecycle

device path は frontend から任意文字列で渡しません。Rust が OS API で列挙した device に
短命 token を割り当て、connect 時に再列挙して同一 device か確認します。表示には path に加え、
取得できる場合だけ vendor / product / serial number を使います。

### Linux

- `/dev/ttyUSB*`、`/dev/ttyACM*` など、列挙 API が返した character device だけを候補にする。
- access denied 時は現在の owner / group を表示する。`chmod`、`sudo`、group 追加、udev rule
  作成を application が実行しない。
- open 後に `TIOCEXCL` を要求し、既に使用中なら明示的に失敗する。
- unplug、`EIO`、`ENODEV` は `transport` close として worker を停止し、handle を閉じる。

根拠: [Linux USB serial documentation](https://docs.kernel.org/usb/usb-serial.html)、
[Linux `TIOCEXCL`](https://man7.org/linux/man-pages/man2/tiocgexcl.2const.html)

### macOS

- IOKit の serial service から BSD device path を列挙し、UI が組み立てた path を開かない。
- access denied、driver 未導入、device 消失を別の診断にする。権限設定や driver install は
  application が代行しない。
- connect 前の `termios` を保持し、close 時に best effort で復元して file descriptor を閉じる。

根拠: [Apple IOKit serial sample](https://developer.apple.com/documentation/iokit/communicating_with_a_modem_on_a_serial_port)、
[Apple IOKit serial family](https://developer.apple.com/library/archive/documentation/DeviceDrivers/Conceptual/IOKitFundamentals/Families_Ref/Families_Ref.html)

### Windows

- OS 列挙結果から `COM` device を選び、backend だけが正規の device name に変換する。
- `CreateFile` は share mode 0、`OPEN_EXISTING` で exclusive open する。使用中なら奪わない。
- `GetCommState` で DCB を取得して明示設定し、timeout と overlapped I/O cancel を設計に含める。
- parity / framing / overrun と unplug を区別して event にし、close では pending I/O を解除して
  handle と worker thread を必ず回収する。

根拠: [Microsoft: communications resource handles](https://learn.microsoft.com/en-us/windows/win32/devio/communications-resource-handles)、
[DCB settings](https://learn.microsoft.com/en-us/windows/win32/devio/modification-of-communications-resource-settings)、
[communications errors](https://learn.microsoft.com/en-us/windows/win32/devio/communications-errors)

## 非対応を維持するもの

- SSH1: SSH2 backend と downgrade negotiation を共有しない。別 protocol selector も追加しない。
- rlogin / rsh / rexec: authentication と confidentiality の境界を満たせないため追加しない。
- 「raw TCP」を telnet の代替として提供しない。
- telnet を SSH tunnel 内へ入れても、end-to-end の暗号化・host authentication 済みとは表示しない。

この範囲を変える場合は、先に threat model と security policy を更新し、protocol parser の
fixture / fuzz target、UI の警告テスト、credential 非永続化テストを追加します。
