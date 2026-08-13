{
  description = "ope-term reproducible Tauri development and build environment";

  inputs.crane.url = "github:ipetkov/crane";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    {
      self,
      crane,
      nixpkgs,
      ...
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      source = nixpkgs.lib.cleanSourceWith {
        src = ./.;
        filter =
          path: _type:
          let
            name = builtins.baseNameOf path;
          in
          !builtins.elem name [
            ".direnv"
            ".git"
            ".claude"
            "dist"
            "docs"
            "fuzz"
            "gen"
            "graphify-out"
            "issues"
            "node_modules"
            "artifacts"
            "result"
            "site"
            "target"
            ".bazelrc"
            ".bazelversion"
            ".cargo"
            ".envrc"
            ".gitignore"
            "BUILD.bazel"
            "CONTRIBUTING.md"
            "flake.lock"
            "flake.nix"
            "MODULE.bazel"
            "MODULE.bazel.lock"
            "README.md"
            "REPO.bazel"
            "SECURITY.md"
          ]
          && !nixpkgs.lib.hasPrefix ".venv" name
          && !nixpkgs.lib.hasPrefix "bazel-" name
          && !nixpkgs.lib.hasPrefix "result-" name;
      };
      buildFor =
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          craneLib = crane.mkLib pkgs;
          cargoTarget = pkgs.stdenv.hostPlatform.rust.rustcTarget;
          linuxBuildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [
            pkgs.glib-networking
            pkgs.gst_all_1.gst-plugins-base
            pkgs.libayatana-appindicator
            pkgs.mesa
            pkgs.webkitgtk_4_1
          ];
          pnpmDeps = pkgs.fetchPnpmDeps {
            pname = "ope-term";
            version = "0.1.1";
            src = source;
            pnpm = pkgs.pnpm_10;
            fetcherVersion = 4;
            hash = "sha256-h3lo9aKwW4ZkTwVrqyk1fMirnhu4TmpWDkbGK9mmHX4=";
          };
          cargoVendorDir = craneLib.vendorCargoDeps {
            src = source;
            cargoLock = ./src-tauri/Cargo.lock;
            cargoToml = ./src-tauri/Cargo.toml;
          };
          cargoCommonArgs = {
            pname = "ope-term";
            version = "0.1.1";
            src = source;
            cargoLock = ./src-tauri/Cargo.lock;
            cargoToml = ./src-tauri/Cargo.toml;
            inherit cargoVendorDir;

            env = {
              CARGO_PROFILE_RELEASE_STRIP = "false";
              CARGO_TARGET_DIR = "target";
              HOST_CC = "${pkgs.stdenv.cc}/bin/${pkgs.stdenv.cc.targetPrefix}cc";
              HOST_CXX = "${pkgs.stdenv.cc}/bin/${pkgs.stdenv.cc.targetPrefix}c++";
              "CARGO_TARGET_${pkgs.stdenv.hostPlatform.rust.cargoEnvVarTarget}_LINKER" =
                "${pkgs.stdenv.cc}/bin/${pkgs.stdenv.cc.targetPrefix}cc";
              "CARGO_TARGET_${pkgs.stdenv.hostPlatform.rust.cargoEnvVarTarget}_RUSTFLAGS" =
                "-Cforce-frame-pointers=yes";
            };
            postConfigure = ''
              cp Cargo.lock src-tauri/Cargo.lock
            '';

            inherit pnpmDeps;
            nativeBuildInputs = [
              pkgs.cargo-tauri.hook
              pkgs.nodejs_24
              pkgs.pkg-config
              pkgs.pnpm_10
              pkgs.pnpmConfigHook
            ]
            ++ pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.wrapGAppsHook4 ];
            buildInputs = [ pkgs.openssl ] ++ linuxBuildInputs;
          };
          cargoArtifacts = craneLib.buildDepsOnly (
            cargoCommonArgs
            // {
              buildPhaseCargoCommand = ''
                cargoWithProfile build --manifest-path src-tauri/Cargo.toml --target ${cargoTarget} --bins --features tauri/custom-protocol --locked
              '';
              doCheck = false;
              env = cargoCommonArgs.env // {
                dontPnpmConfigure = "1";
                dontTauriFixup = "1";
              };
            }
          );
          frontend = pkgs.stdenvNoCC.mkDerivation {
            pname = "ope-term-frontend";
            version = "0.1.1";
            src = source;
            inherit pnpmDeps;
            nativeBuildInputs = [
              pkgs.nodejs_24
              pkgs.pnpm_10
              pkgs.pnpmConfigHook
            ];
            buildPhase = ''
              runHook preBuild
              pnpm test
              pnpm run build
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              mkdir -p $out
              cp -r dist $out/
              runHook postInstall
            '';
          };
          app = craneLib.mkCargoDerivation (
            cargoCommonArgs
            // {
              buildAndTestSubdir = "src-tauri";
              inherit cargoArtifacts pnpmDeps;
              buildPhaseCargoCommand = "";
              checkPhaseCargoCommand = "";
              buildPhase = "tauriBuildHook";
              installPhase = "tauriInstallHook";
              doCheck = false;
              doInstallCargoArtifacts = false;

              preFixup = pkgs.lib.optionalString pkgs.stdenv.isLinux ''
                gappsWrapperArgs+=(
                  --prefix LD_LIBRARY_PATH : "${pkgs.lib.makeLibraryPath [ pkgs.mesa ]}"
                  --set GBM_BACKENDS_PATH "${pkgs.mesa}/lib/gbm"
                  --set LIBGL_DRIVERS_PATH "${pkgs.mesa}/lib/dri"
                )
              '';

              meta = {
                description = "Route-first SSH terminal for operators and developers";
                homepage = "https://github.com/hjosugi/ope-term";
                license = pkgs.lib.licenses.mit;
                mainProgram = "ope-term";
                platforms = pkgs.lib.platforms.linux ++ pkgs.lib.platforms.darwin;
              };
            }
          );
        in
        {
          inherit app frontend pnpmDeps;
        };
    in
    {
      packages = forAllSystems (
        system:
        let
          build = buildFor system;
        in
        {
          default = build.app;
          ope-term = build.app;
          frontend = build.frontend;
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          package = self.packages.${system}.default;
        in
        {
          inherit package;
          frontend = self.packages.${system}.frontend;
          build-path-policy =
            pkgs.runCommand "ope-term-build-path-policy"
              {
                nativeBuildInputs = [ pkgs.jq ];
                flakeSource = ./flake.nix;
                moduleSource = ./MODULE.bazel;
                packageSource = ./package.json;
                tauriSource = ./src-tauri/tauri.conf.json;
              }
              ''
                test "$(jq -r '.scripts.bundle' "$packageSource")" = "vite build"
                test "$(jq -r '.scripts.build' "$packageSource")" = "pnpm run typecheck && pnpm run bundle"
                test "$(jq -r '.build.beforeBuildCommand' "$tauriSource")" = "pnpm run build"
                version="$(jq -r '.version' "$packageSource")"
                test "$(sed -n 's/^[[:space:]]*version = "\([^"]*\)",/\1/p' "$moduleSource")" = "$version"
                test "$(sed -n 's/^[[:space:]]*version = "\([^"]*\)";/\1/p' "$flakeSource" | sort -u)" = "$version"
                if grep 'pre[B]uild =' "$flakeSource"; then
                  echo "Nix app must not duplicate Tauri's frontend build" >&2
                  exit 1
                fi
                grep -F 'craneLib.buildDepsOnly' "$flakeSource" >/dev/null
                grep -F 'inherit cargoArtifacts pnpmDeps;' "$flakeSource" >/dev/null
                grep -F 'HOST_CC =' "$flakeSource" >/dev/null
                grep -F 'HOST_CXX =' "$flakeSource" >/dev/null
                touch "$out"
              '';
        }
        // pkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
          linux-runtime-wrapper =
            pkgs.runCommand "ope-term-linux-runtime-wrapper"
              {
                nativeBuildInputs = [ pkgs.binutils ];
              }
              ''
                wrapper="${package}/bin/ope-term"
                strings "$wrapper" > wrapper-strings
                grep -Fx LD_LIBRARY_PATH wrapper-strings >/dev/null
                grep -Fx "GBM_BACKENDS_PATH=${pkgs.mesa}/lib/gbm" wrapper-strings >/dev/null
                grep -Fx "LIBGL_DRIVERS_PATH=${pkgs.mesa}/lib/dri" wrapper-strings >/dev/null
                grep -F "${pkgs.gst_all_1.gst-plugins-base}/lib/gstreamer-1.0" wrapper-strings >/dev/null
                touch "$out"
              '';
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          linuxLibraries = pkgs.lib.optionals pkgs.stdenv.isLinux [
            pkgs.atk
            pkgs.cairo
            pkgs.gdk-pixbuf
            pkgs.glib
            pkgs.glib-networking
            pkgs.gst_all_1.gst-plugins-base
            pkgs.gtk3
            pkgs.libayatana-appindicator
            pkgs.libsoup_3
            pkgs.librsvg
            pkgs.mesa
            pkgs.pango
            pkgs.webkitgtk_4_1
            pkgs.xdotool
          ];
        in
        {
          default = pkgs.mkShell (
            {
              packages = [
                pkgs.actionlint
                pkgs.bazelisk
                pkgs.buildifier
                pkgs.cargo
                pkgs.cargo-audit
                pkgs.cargo-deny
                pkgs.cargo-fuzz
                pkgs.cargo-nextest
                pkgs.cargo-watch
                pkgs.clippy
                pkgs.git
                pkgs.hyperfine
                pkgs.just
                pkgs.nodejs_24
                pkgs.nix
                pkgs.nixfmt
                pkgs.openssl
                pkgs.pkg-config
                pkgs.pnpm_10
                (pkgs.python3.withPackages (ps: [
                  ps.mkdocs
                  ps.mkdocs-material
                ]))
                pkgs.rust-analyzer
                pkgs.rustc
                pkgs.rustfmt
                pkgs.sccache
                pkgs.shellcheck
                pkgs.syft
              ]
              ++ pkgs.lib.optionals pkgs.stdenv.isLinux [
                pkgs.mold
              ]
              ++ linuxLibraries;

              CARGO_INCREMENTAL = "0";
              GIO_MODULE_DIR = pkgs.lib.optionalString pkgs.stdenv.isLinux (
                "${pkgs.glib-networking}/lib/gio/modules"
              );
              GBM_BACKENDS_PATH = pkgs.lib.optionalString pkgs.stdenv.isLinux ("${pkgs.mesa}/lib/gbm");
              LIBGL_DRIVERS_PATH = pkgs.lib.optionalString pkgs.stdenv.isLinux ("${pkgs.mesa}/lib/dri");
              LD_LIBRARY_PATH = pkgs.lib.optionalString pkgs.stdenv.isLinux (
                pkgs.lib.makeLibraryPath linuxLibraries
              );
              RUSTC_WRAPPER = "${pkgs.sccache}/bin/sccache";

              shellHook = ''
                if [ -f "$PWD/scripts/cache-env.sh" ]; then
                  source "$PWD/scripts/cache-env.sh"
                else
                  if [ -z "''${OPE_TERM_DATA_ROOT:-}" ]; then
                    if [ -d /mnt/data ] && [ -w /mnt/data ]; then
                      export OPE_TERM_DATA_ROOT=/mnt/data/ope-term
                    else
                      export OPE_TERM_DATA_ROOT="$HOME/.cache/ope-term"
                    fi
                  fi
                  export OPE_TERM_CACHE_ROOT="''${OPE_TERM_CACHE_ROOT:-$OPE_TERM_DATA_ROOT/cache}"
                  export CARGO_HOME="$OPE_TERM_CACHE_ROOT/cargo/home"
                  export CARGO_TARGET_DIR="$OPE_TERM_CACHE_ROOT/cargo/target"
                  export RUSTUP_HOME="$OPE_TERM_CACHE_ROOT/rustup"
                  export SCCACHE_DIR="$OPE_TERM_CACHE_ROOT/sccache"
                  mkdir -p "$CARGO_HOME" "$CARGO_TARGET_DIR" "$RUSTUP_HOME" "$SCCACHE_DIR"
                fi
                echo "ope-term dev shell | node $(node --version) | rustc $(rustc --version | cut -d' ' -f2) | bazel $(bazelisk version --gnu_format 2>/dev/null | head -1)"
              '';
            }
            // pkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
              RUSTFLAGS = "-C link-arg=-fuse-ld=mold";
            }
          );
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
