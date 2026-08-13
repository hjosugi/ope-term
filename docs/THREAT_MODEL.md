# Threat model

This model covers the v0.1 desktop client, its Tauri WebView, Rust core, local
OpenSSH files, and remote SSH peers. Revisit it whenever a capability, Tauri
plugin, transport, authentication method, or persistence mechanism is added.

## Assets

| Asset | Required property |
|---|---|
| SSH private keys, agent handles, passwords, passphrases, OTPs | Never exposed to remote output, logs, persistent WebView storage, or unrelated sessions |
| `known_hosts` and host-key decisions | Integrity; changed keys are rejected and unknown keys require an explicit fingerprint decision |
| `~/.ssh/config`, included files, route definitions | Local confidentiality and faithful parsing without code execution |
| Terminal input and output | Session isolation, bounded resource use, and no interpretation as HTML or privileged UI commands |
| Local filesystem and process authority | Unavailable to the WebView except through allowlisted Tauri commands; SFTP paths remain scoped to a native-picker token |
| Saved route workspaces and restored tabs in WebView storage | Alias references only; never secrets or resolved endpoints, and never an automatic connection |
| Release artifacts and dependency graph | Reproducibility, vulnerability review, and an attached machine-readable SBOM |

## Trust boundaries

```text
untrusted SSH server/output
        │ encrypted SSH2 stream
        ▼
Rust SSH core ── reads ── local ssh_config / keys / known_hosts / agent
        │ typed Tauri IPC channels and commands
        ▼
Tauri WebView ── renders bytes in xterm.js ── local user
        │
        └── bundled local assets only (enforced by CSP)
```

- The remote peer and every byte of terminal output are untrusted, including a
  previously trusted host after account compromise.
- The Rust core is privileged. It owns sockets, secrets, host-key checks, config
  expansion, and session handles.
- The WebView is less trusted. It receives display data and short-lived
  authentication responses, but has no shell, clipboard, arbitrary filesystem,
  or remote-content capability. The development CSP permits only Vite's
  loopback WebSocket on port 1420; production does not.
- Local OpenSSH files are user-controlled input. Includes, tokens, wildcard
  matching, and ProxyJump graphs must not cause recursion, path traversal outside
  explicit include semantics, panics, or unbounded expansion.
- GitHub Actions and release tooling are a supply-chain boundary. Workflows use
  read-only repository permissions unless a future release job explicitly needs
  more.

## Attacker capabilities

The model assumes an attacker may:

- control an SSH server, its authentication prompts, terminal bytes, OSC
  sequences, hyperlink targets, timing, disconnects, and output volume;
- modify network traffic but not break the negotiated SSH cryptography;
- provide a malicious or unusually large local SSH config to the parser;
- trick a user into connecting to a look-alike alias or accepting a new key;
- submit a dependency or build input that later becomes known to be vulnerable.

The model does not treat a fully compromised local OS or user account as
containable. Such an attacker can read the same keys and memory as ope-term.

## Controls and residual risks

| Threat | Control | Residual risk |
|---|---|---|
| Man-in-the-middle | Strict `known_hosts`; changed keys rejected; unknown fingerprints require user action | Users can still approve a malicious unknown key |
| Secret theft by remote output | Secrets stay in Rust/short-lived IPC; no logging or persistence; WebView has no shell/clipboard plugin | A compromised WebView during an active prompt could observe typed input |
| XSS or privileged navigation | Local-only CSP, frozen prototype, Tauri asset CSP rewriting, text-only DOM construction, minimal capability | WebKit/xterm/Tauri vulnerabilities remain dependency risks |
| Malicious terminal escapes | xterm window controls disabled; OSC 8 activation blocked; no OSC 52 clipboard integration; input IPC is capped at 1 MiB; scrollback is capped at 20,000 lines | Visual spoofing and high-rate output can still consume CPU and transient buffers |
| Parser/route denial of service | Include depth/cycle checks; 8 MiB, 1024-file, and per-glob match budgets; non-recursive polynomial-time wildcard matching; unit/property tests; continuous fuzzing | A config within those budgets can still create substantial parser and UI work |
| Vulnerable dependencies | `pnpm audit`, RustSec audit, weekly CI, CycloneDX SBOM, private reporting | Linux WebKitGTK/GTK stack inherits platform advisories and patch cadence |
| Tampered or corrupt workspace storage | Stored entries are alias references only, re-validated and bounded on load, resolved through `~/.ssh/config` at connect time; a corrupt store degrades to an empty workspace instead of blocking startup | A local attacker who can already write WebView storage can rename a workspace to mislead an operator into connecting to a different, config-defined alias |
| SFTP path traversal or unsafe overwrite | Native picker scopes local roots; Rust rejects absolute/parent/NUL paths and symlink escape; remote names are single components; paths and directory listings are bounded; temporary-file rename and backup rollback protect existing files | A malicious server may misreport metadata or fail operations; recursive directory transfer and resume are intentionally unavailable |
| Local terminal command injection or orphan child | IPC accepts a Rust-enumerated profile ID, not a command line; cwd uses a picker token; close and setup failures kill and wait for the child | The selected shell and its startup files execute with the user's normal local authority; OSC 133 markers are advisory and spoofable by child output |
| Session log secret leakage or viewer memory exhaustion | Logging is per-target opt-in and output-only; auth prompts bypass it; path is picker-scoped; symlinks/non-files are rejected; new Unix logs are `0600`; rotation is bounded; viewer streams with line/result limits | Remote/child output and normal PTY echo can still contain secrets; directory permissions and retention remain the operator's responsibility |

## Security invariants

1. Remote bytes are written only to xterm, never parsed as HTML.
2. A remote peer cannot open a URL, write the clipboard, manipulate the app
   window, or invoke a Tauri command through terminal escape sequences.
3. The WebView cannot obtain private-key bytes or raw SSH session handles.
4. Host-key changes fail closed.
5. Persisted UI state holds no secrets and starts no connection on its own; a
   restored tab connects only after an explicit operator action.
6. Adding a capability or plugin requires updating this model and the automated
   policy audit.
7. SFTP transfer commands cannot name an arbitrary local path; the path must resolve below a
   native-picker scope held only by Rust.
8. Local terminal IPC cannot supply an executable or argument vector, and every spawned child has
   an owned kill-and-wait lifecycle.
9. Authentication responses and normal terminal input are never sent to the session log writer.
