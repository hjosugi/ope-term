# Terminal security review

Review date: 2026-07-30. Scope: xterm.js 6, the Tauri WebView integration in
`src/main.ts`, and remote terminal output received over the SSH IPC channel.

## Escape sequences

xterm.js parses remote bytes as terminal data. ope-term does not implement a
second escape parser and never writes output into an HTML API. xterm's window
manipulation/report options are explicitly empty, so remote title, resize,
position, maximize, minimize, and window-state operations remain disabled.
Proposed xterm APIs and transparent rendering are also disabled.

Terminal escapes can still change terminal-local presentation (cursor, colors,
alternate screen, and text). This is required for interactive terminal
applications and creates an unavoidable visual-spoofing risk. Security prompts
therefore live outside the terminal canvas and always identify their SSH hop.

## Links

OSC 8 links are accepted only for HTTP(S), rendered by xterm, and connected to a
no-op activation handler. Clicking remote output cannot navigate the WebView or
open an external application. Plain URL detection is not installed.

Future link opening must validate the parsed scheme and host, display the full
destination in trusted application chrome, require a user gesture, and use a
narrow Tauri capability. It must not enable non-HTTP protocols.

## Clipboard

ope-term installs no browser or Tauri clipboard integration. Remote OSC 52 data
therefore has no path to the system clipboard. xterm's normal DOM copy/paste
events remain user-initiated: selected text may be copied and explicitly pasted
text is sent as terminal input. Bracketed-paste mode remains enabled when the
remote application requests it, which lets terminal programs distinguish a paste
from typing.

Adding automatic copy, paste, selection export, or OSC 52 support requires a
separate threat-model update and explicit capability review.

## Automated regression checks

`pnpm run security:policy` fails if frontend source introduces HTML injection,
browser clipboard, window opening, Tauri shell/clipboard plugins, broader
capabilities, remote CSP sources, or removes the explicit xterm restrictions.
