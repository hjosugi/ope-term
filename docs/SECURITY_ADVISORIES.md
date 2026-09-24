# Dependency advisory review

Last reviewed: 2026-09-24 with `cargo-audit`, `cargo-deny`, the current
RustSec database, and GitHub Dependabot alerts.

`just security` reports no entries in cargo-audit's vulnerability category and
no pnpm vulnerabilities at high severity or above. Informational RustSec
warnings remain visible in CI; they are not silently ignored by configuration.
GitHub classifies the `glib::VariantStrIter` unsoundness below as a separate
open moderate alert, so a green audit is not presented as meaning that every
transitive advisory has been fixed.

`cargo-audit` also warns about yanked crates in `Cargo.lock`. These are not
advisories, but a yanked entry is a lockfile update to make, not a warning to
accept. The 2026-09-24 review found two:

- `chacha20` 0.10.1, through `ssh-cipher` and `rand`. Version 0.10.2 stops
  the SSE2 backend from using an SSE4.1 intrinsic in the RNG and in the legacy
  64-bit-counter variant, which is the one the OpenSSH `chacha20-poly1305`
  cipher uses.
- `wnaf` 0.14.0, through `primeorder`. Version 0.14.1 replaces it.

`cargo-deny` independently rejects unapproved dependency licenses, wildcard
version requirements, unknown registries, and Git dependencies. Duplicate
transitive versions remain Cargo/upstream maintenance work rather than a
release failure; vulnerabilities in any duplicate still fail `cargo-audit`.

## Removed vulnerable RSA implementation

`russh`'s optional RSA feature pulled in `rsa 0.10.0-rc.18`, affected by
[RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html).
No patched release is available through the current `russh` feature. ope-term
therefore disables that feature and does not ship the vulnerable implementation.

This temporarily removes RSA private-key authentication and RSA-only host-key
support. Ed25519 and ECDSA authentication/host keys remain available. Re-enable
RSA only after the dependency path uses a constant-time implementation and both
the RustSec audit and SSH interoperability tests pass.

## Accepted informational warnings

The Linux Tauri WebView stack currently brings in the gtk-rs 0.18 GTK3 bindings.
RustSec reports two informational warnings through them:

- RUSTSEC-2024-0370 (`proc-macro-error`, through `glib-macros` and
  `gtk3-macros`);
- RUSTSEC-2024-0429 (`glib::VariantStrIter` unsoundness).

RustSec withdrew the GTK3/ATK/GDK "unmaintained" advisories
(RUSTSEC-2024-0411 through RUSTSEC-2024-0420) on 2026-09-08, after the gtk3-rs
repository was unarchived and maintenance resumed. `cargo audit` no longer
reports them.

GitHub tracks RUSTSEC-2024-0429 as
[GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g), and
that Dependabot alert is still open. The patched `glib` line starts at 0.20.
gtk3-rs now publishes GTK3 bindings on a patched `glib` (`gtk` 0.19.0 on
`glib` 0.22, released 2026-09-08), but the Tauri Linux stack has not adopted
them. The lockfile resolves Tauri 2.11.5 / Wry 0.55.1 to `glib` 0.18.5. The
newest releases, Tauri 2.11.6, tauri-runtime-wry 2.11.4, and Wry 0.57.0, still
require `gtk` ^0.18 and `webkit2gtk` 2.0.2, and `webkit2gtk` 2.0.2 itself
depends on the 0.18 bindings. This alert therefore stays open for an upstream
update rather than being dismissed as resolved. It closes when either of these
happens: webkit2gtk-rs, Wry, and Tauri move to the 0.19 GTK3 bindings; or the
GTK4/WebKit6 migrations tracked in
[Tauri #7335](https://github.com/tauri-apps/tauri/issues/7335) and
[Wry #1474](https://github.com/tauri-apps/wry/issues/1474) land.

ope-term does not call GTK, ATK, GDK, `proc-macro-error`, or
`glib::VariantStrIter` directly, and no other crate in the locked dependency
graph references `VariantStrIter`. They are platform dependencies of
Tauri/Wry/WebKitGTK. Removing them requires upstream Tauri's Linux WebView stack
to migrate. Until then:

- Tauri/Wry and the system WebKitGTK packages are updated regularly;
- all remote content is blocked by CSP and terminal output cannot invoke WebView
  APIs;
- every release re-runs RustSec and stops on vulnerabilities (informational
  warnings remain review items);
- a warning becoming a vulnerability, or a reachable exploit in the WebView
  path, blocks release.

Tauri's URL-pattern parser also brings unmaintained `unic-*` crates:
RUSTSEC-2025-0075, RUSTSEC-2025-0080, RUSTSEC-2025-0081,
RUSTSEC-2025-0098, and RUSTSEC-2025-0100. They have no reported vulnerability;
the same upgrade and release-review policy applies.

This acceptance is scoped to alpha builds and must be revisited when Tauri
changes its Linux bindings or before declaring a stable release.
