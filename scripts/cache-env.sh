#!/usr/bin/env bash

# Keep this project's mutable development data off the system disk. Override
# OPE_TERM_DATA_ROOT before sourcing this file when /mnt/data is unavailable.
if [[ -z "${OPE_TERM_DATA_ROOT:-}" ]]; then
  if [[ -d /mnt/data && -w /mnt/data ]]; then
    OPE_TERM_DATA_ROOT=/mnt/data/ope-term
  else
    OPE_TERM_DATA_ROOT="${HOME}/.cache/ope-term"
  fi
fi

export OPE_TERM_DATA_ROOT
export OPE_TERM_CACHE_ROOT="${OPE_TERM_CACHE_ROOT:-${OPE_TERM_DATA_ROOT}/cache}"
export OPE_TERM_NIX_STORE_ROOT="${OPE_TERM_NIX_STORE_ROOT:-${OPE_TERM_DATA_ROOT}/nix-store}"
export OPE_TERM_NIX_BUILD_DIR="${OPE_TERM_NIX_BUILD_DIR:-${OPE_TERM_DATA_ROOT}/nix-build}"
export OPE_TERM_NIX_STORE_URI="local?root=${OPE_TERM_NIX_STORE_ROOT}"

export XDG_CACHE_HOME="${OPE_TERM_CACHE_ROOT}/xdg"
export XDG_DATA_HOME="${OPE_TERM_DATA_ROOT}/data"
export XDG_STATE_HOME="${OPE_TERM_DATA_ROOT}/state"
export TMPDIR="${OPE_TERM_DATA_ROOT}/tmp"
export TMP="${TMPDIR}"
export TEMP="${TMPDIR}"

export CARGO_HOME="${OPE_TERM_CACHE_ROOT}/cargo/home"
export CARGO_TARGET_DIR="${OPE_TERM_CACHE_ROOT}/cargo/target"
export RUSTUP_HOME="${OPE_TERM_CACHE_ROOT}/rustup"
export SCCACHE_DIR="${OPE_TERM_CACHE_ROOT}/sccache"
export BAZELISK_HOME="${OPE_TERM_CACHE_ROOT}/bazelisk"
export NPM_CONFIG_CACHE="${OPE_TERM_CACHE_ROOT}/npm"
export npm_config_cache="${NPM_CONFIG_CACHE}"
export PNPM_HOME="${OPE_TERM_DATA_ROOT}/data/pnpm"
export npm_config_store_dir="${OPE_TERM_CACHE_ROOT}/pnpm/store"
export pnpm_config_store_dir="${npm_config_store_dir}"
export VITE_CACHE_DIR="${OPE_TERM_CACHE_ROOT}/vite"

mkdir -p \
  "${XDG_CACHE_HOME}" \
  "${XDG_DATA_HOME}" \
  "${XDG_STATE_HOME}" \
  "${TMPDIR}" \
  "${CARGO_HOME}" \
  "${CARGO_TARGET_DIR}" \
  "${RUSTUP_HOME}" \
  "${SCCACHE_DIR}" \
  "${BAZELISK_HOME}" \
  "${NPM_CONFIG_CACHE}" \
  "${PNPM_HOME}" \
  "${npm_config_store_dir}" \
  "${VITE_CACHE_DIR}" \
  "${OPE_TERM_NIX_BUILD_DIR}" \
  "${OPE_TERM_NIX_STORE_ROOT}"
