set dotenv-load := false

default:
    @just --list

bootstrap:
    ./scripts/run-cached pnpm install --frozen-lockfile

dev:
    ./scripts/run-cached pnpm run tauri dev

test:
    ./scripts/run-cached pnpm test
    ./scripts/run-cached cargo nextest run --manifest-path src-tauri/Cargo.toml

lint:
    ./scripts/run-cached pnpm run typecheck
    ./scripts/run-cached actionlint
    ./scripts/run-cached buildifier -mode=check BUILD.bazel MODULE.bazel REPO.bazel
    ./scripts/run-cached shellcheck -x -P scripts scripts/cache-env.sh scripts/nix-local scripts/run-bazel scripts/run-cached
    ./scripts/run-cached cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
    ./scripts/run-cached cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

build:
    ./scripts/run-cached pnpm run build
    ./scripts/run-cached cargo build --manifest-path src-tauri/Cargo.toml

check: lint test build

bazel:
    ./scripts/run-bazel test //:check
    ./scripts/run-bazel build //:frontend

benchmark-build:
    hyperfine --warmup 1 --runs 5 './scripts/run-cached pnpm run build' './scripts/run-bazel build //:frontend'

nix:
    ./scripts/nix-local flake check
    ./scripts/nix-local build

cache-stats:
    @echo "cache root: $${OPE_TERM_CACHE_ROOT:-/mnt/data/ope-term/cache}"
    ./scripts/run-cached sccache --show-stats
