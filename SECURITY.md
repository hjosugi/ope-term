# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or include live
credentials, private keys, production hostnames, or exploit data in an issue.
Use GitHub's
[private vulnerability reporting](https://github.com/hjosugi/ope-term/security/advisories/new)
for this repository. Private reporting is enabled.

Include affected versions, impact, reproduction steps, and a minimal sanitized
test case when possible. Maintainers will acknowledge a report as capacity
allows, coordinate validation and remediation in the private advisory, and
publish credit only with the reporter's consent. Do not test against systems you
do not own or have permission to assess.

## Supported versions

ope-term is pre-release software. Only the latest commit on `main` receives
security fixes until the first stable release.

## Release security gate

Every release candidate must:

1. pass `just security` and the normal `just check`;
2. pass both cargo-fuzz targets (the scheduled workflow continuously exercises
   them; a release run should use a longer time budget);
3. generate `artifacts/security/ope-term.cdx.json` with `just sbom`;
4. review all RustSec informational warnings and unresolved package-manager
   advisories;
5. attach the CycloneDX SBOM to the release artifacts.

The threat model and terminal review live in
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) and
[`docs/TERMINAL_SECURITY.md`](docs/TERMINAL_SECURITY.md). Current transitive
dependency warnings and their exit conditions are recorded in
[`docs/SECURITY_ADVISORIES.md`](docs/SECURITY_ADVISORIES.md).
