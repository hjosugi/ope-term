set dotenv-load := false

fuzz-toolchain := "nightly-2026-07-28"

default:
    @just --list

bootstrap:
    CI=true ./scripts/run-cached pnpm install --frozen-lockfile

dev:
    ./scripts/run-cached pnpm run tauri dev

test:
    ./scripts/run-cached pnpm test
    ./scripts/run-cached cargo nextest run --locked --manifest-path src-tauri/Cargo.toml

lint:
    ./scripts/run-cached pnpm run typecheck
    ./scripts/run-cached pnpm run release:policy
    ./scripts/run-cached actionlint
    ./scripts/run-cached buildifier -mode=check BUILD.bazel MODULE.bazel REPO.bazel
    ./scripts/run-cached shellcheck -x -P scripts scripts/cache-env.sh scripts/nix-local scripts/run-bazel scripts/run-cached scripts/run-fuzz
    ./scripts/run-cached nixfmt --check flake.nix
    ./scripts/run-cached cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
    ./scripts/run-cached cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

frontend-build:
    ./scripts/run-cached pnpm run build

frontend-bundle:
    ./scripts/run-cached pnpm run bundle

rust-build:
    ./scripts/run-cached cargo build --locked --manifest-path src-tauri/Cargo.toml

build: frontend-build rust-build

version-check *args:
    ./scripts/run-cached node scripts/version-consistency.mjs {{args}}

release-policy:
    ./scripts/run-cached pnpm run release:policy

check: lint test frontend-bundle rust-build

security:
    ./scripts/run-cached pnpm run security:policy
    ./scripts/run-cached pnpm audit --audit-level high
    ./scripts/run-cached cargo audit --file src-tauri/Cargo.lock
    ./scripts/run-cached cargo deny --manifest-path src-tauri/Cargo.toml check bans licenses sources

sbom:
    mkdir -p artifacts/security
    ./scripts/run-cached syft scan dir:. \
        --source-name ope-term \
        --source-version "$(node -p 'require("./package.json").version')" \
        --exclude './.git/**' \
        --exclude './.venv*/**' \
        --exclude './node_modules/**' \
        --exclude './dist/**' \
        --exclude './artifacts/**' \
        --exclude './graphify-out/**' \
        --exclude './site/**' \
        --exclude './src-tauri/target/**' \
        --exclude './src-tauri/fuzz/target/**' \
        --exclude './bazel-*' \
        --output cyclonedx-json=artifacts/security/ope-term.cdx.json

fuzz-check:
    ./scripts/run-cached cargo check --locked --manifest-path src-tauri/fuzz/Cargo.toml --bins

msrv-check:
    msrv="$(sed -n 's/^rust-version = "\(.*\)"/\1/p' src-tauri/Cargo.toml)"; \
        test -n "$msrv"; \
        ./scripts/run-cached rustup toolchain install "$msrv" --profile minimal --no-self-update; \
        ./scripts/run-cached rustup run "$msrv" cargo check --locked --manifest-path src-tauri/Cargo.toml

fuzz-bootstrap:
    ./scripts/run-cached rustup toolchain install {{fuzz-toolchain}} --profile minimal --no-self-update

fuzz-smoke duration="30":
    cd src-tauri && OPE_TERM_FUZZ_TOOLCHAIN={{fuzz-toolchain}} ../scripts/run-fuzz run ssh_config_parser -- -max_total_time={{duration}} -timeout=10 -verbosity=0
    cd src-tauri && OPE_TERM_FUZZ_TOOLCHAIN={{fuzz-toolchain}} ../scripts/run-fuzz run route_expansion -- -max_total_time={{duration}} -timeout=10 -verbosity=0

docs:
    ./scripts/run-cached mkdocs build --strict
    ./scripts/run-cached pnpm run docs:policy

docs-serve:
    ./scripts/run-cached mkdocs serve

bazel:
    ./scripts/run-bazel test //:check
    ./scripts/run-bazel build //:frontend

benchmark-build:
    hyperfine --warmup 1 --runs 5 './scripts/run-cached pnpm run build' './scripts/run-bazel build //:frontend'

performance-fixture bytes="104857600":
    ./scripts/run-cached node scripts/performance-fixture.mjs {{bytes}}

performance-gate report:
    ./scripts/run-cached node scripts/performance-gate.mjs {{report}}

performance-bundle webgl fallback output="artifacts/performance/bundle":
    ./scripts/run-cached node scripts/performance-bundle.mjs \
        --webgl {{webgl}} --fallback {{fallback}} --output {{output}}

reliability-soak upstream upstream_port="22" listen_port="2222" duration="86400" fault_every="900" report="artifacts/reliability/soak.json":
    ./scripts/run-cached node scripts/fault-proxy.mjs \
        --upstream-host {{upstream}} \
        --upstream-port {{upstream_port}} \
        --listen-port {{listen_port}} \
        --duration-seconds {{duration}} \
        --fault-every-seconds {{fault_every}} \
        --report {{report}}

reliability-gate report:
    ./scripts/run-cached node scripts/reliability-gate.mjs {{report}}

nix:
    ./scripts/nix-local flake check
    ./scripts/nix-local build

cache-stats:
    @echo "cache root: ${OPE_TERM_CACHE_ROOT:-/mnt/data/ope-term/cache}"
    ./scripts/run-cached sccache --show-stats
