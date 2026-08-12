# UI サイズと CSS token

ope-term のデスクトップ UI は高密度な運用画面です。コンポーネントごとに近似した
`px` 値を増やさず、`src/style.css` の `:root` にある token を共有してサイズ感を揃えます。

## Spacing

余白は 4 px を基準にした `--space-1` から `--space-10` を使います。

| token | 値 | 主な用途 |
|---|---:|---|
| `--space-1` | 4 px | icon 内側、密な補助操作 |
| `--space-2` | 8 px | 小さい gap、compact control |
| `--space-3` | 12 px | 標準の input / card padding |
| `--space-4` | 16 px | section 内の間隔 |
| `--space-5` | 20 px | card と dialog の小さい余白 |
| `--space-6` | 24 px | dialog gutter |
| `--space-7` 以上 | 32 px 以上 | section 間隔と大きい余白 |

既存 token の中間値が必要に見える場合は、まず隣接要素の token を揃えて解決できないか
確認します。route piece の接続線など意味のある固有ジオメトリだけは `rem` を局所指定します。

## Typography

補助ラベルから本文までを `--font-2xs`、`--font-xs`、`--font-sm`、`--font-md`、
`--font-lg` の5段階に限定します。dialog 見出しは `--font-title`、画面の主見出しは
responsive な `clamp()` を使います。

shortcut、hostname、status などの機械的な情報には `--mono` を使います。説明文や
見出しは system UI font のままにし、外部 font を読み込みません。

## Controls と chrome

| token | 役割 |
|---|---|
| `--control-sm` / `--control-md` / `--control-lg` | button、input、list row の高さ |
| `--chrome-top` | tab bar と同列の操作 |
| `--chrome-status` | status bar と小さい table header |
| `--chrome-hop` | terminal の hop bar |
| `--dialog-footer` | dialog footer の最小高さ |
| `--dialog-gutter` | dialog の左右 padding |

同じ行に並ぶ control は同じ高さ token を使います。border は `--border-width`、focus ring は
`--focus-ring-width` に統一し、状態色は既存の semantic color token を参照します。

## Layout

sidebar 幅は `--rail-width` と `--rail-width-compact`、workbench の余白は
`--content-block-padding` と `--content-inline-padding` が管理します。responsive breakpoint
では列数や方向だけを切り替え、同じ spacing token を継続して使います。

## 変更時の確認

1. 新しい裸の `px` 値を追加していないか確認する。
2. `pnpm run build` で CSS の構文と production bundle を検証する。
3. 通常幅と 850 px 以下で、workbench、shortcut editor、host-key dialog、auth dialog を確認する。
4. keyboard focus、長い hostname、degraded route、再接続中の表示が欠けないことを確認する。

```bash
rg -n --pcre2 '(?<![\\w-])\\d+(?:\\.\\d+)?px' src/style.css
pnpm run build
```

検索結果として残してよい裸の `px` は token の定義と media query の breakpoint だけです。
