# Host key: 初回信頼と鍵変更を安全に扱う確認 UI
Labels: priority:P0, area:ssh, security

## 背景

現在は unknown host key を拒否し、CLI での事前登録を要求している。安全だが初回導入が分かりにくい。

## 方針

- unknown と changed を明確に分ける
- SHA256 fingerprint、algorithm、hostname、port、hop を表示する
- unknown だけに「今回のみ」「known_hosts へ保存」を提供する
- changed は既定で拒否し、既存行番号と対処手順を示す

## 受け入れ条件

- [x] fingerprint を別経路で確認できる情報量がある
- [x] 保存時は `known_hosts` の権限と改行を壊さない
- [x] changed key をワンクリックで上書きできない
- [x] hashed known_hosts と非標準 port をテストする
