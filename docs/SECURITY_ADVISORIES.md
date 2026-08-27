# Dependency advisory review

Last reviewed: 2026-08-27 with `cargo-audit`, `cargo-deny`, the current
RustSec database, and GitHub Dependabot alerts.

`just security` reports no entries in cargo-audit's vulnerability category and
no pnpm vulnerabilities at high severity or above. Informational RustSec
warnings remain visible in CI; they are not silently ignored by configuration.
GitHub classifies the `glib::VariantStrIter` unsoundness below as a separate
open moderate alert, so a green audit is not presented as meaning that every
transitive advisory has been fixed.

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
RustSec marks those bindings unmaintained:

- RUSTSEC-2024-0411 through RUSTSEC-2024-0420 (GTK3/ATK/GDK bindings);
- RUSTSEC-2024-0370 (`proc-macro-error`, through GTK macros);
- RUSTSEC-2024-0429 (`glib::VariantStrIter` unsoundness).

GitHub tracks RUSTSEC-2024-0429 as
[GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g). The
patched `glib` line starts at 0.20, while the current Tauri 2.11.5 / Wry 0.55.1
Linux dependency graph requires the GTK3 binding line at `glib` 0.18.5. This is
therefore kept open for upstream migration rather than dismissed as resolved.
The required GTK4/WebKit6 migrations are still tracked upstream in
[Tauri #7335](https://github.com/tauri-apps/tauri/issues/7335) and
[Wry #1474](https://github.com/tauri-apps/wry/issues/1474).

ope-term does not call GTK, ATK, GDK, `proc-macro-error`, or
`glib::VariantStrIter` directly; they are platform dependencies of
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
