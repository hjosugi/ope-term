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
| Local filesystem and process authority | Unavailable to the WebView except through the eight allowlisted Tauri commands |
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
| Malicious terminal escapes | xterm window controls disabled; OSC 8 activation blocked; no OSC 52 clipboard integration | Visual spoofing and output-flood resource pressure remain possible |
| Parser/route denial of service | Include-depth and cycle checks, non-recursive polynomial-time wildcard matching, unit/property tests, continuous fuzzing, bounded fuzz inputs | Runtime config file size is not yet globally capped |
| Vulnerable dependencies | `pnpm audit`, RustSec audit, weekly CI, CycloneDX SBOM, private reporting | Linux WebKitGTK/GTK stack inherits platform advisories and patch cadence |

## Security invariants

1. Remote bytes are written only to xterm, never parsed as HTML.
2. A remote peer cannot open a URL, write the clipboard, manipulate the app
   window, or invoke a Tauri command through terminal escape sequences.
3. The WebView cannot obtain private-key bytes or raw SSH session handles.
4. Host-key changes fail closed.
5. Adding a capability or plugin requires updating this model and the automated
   policy audit.
