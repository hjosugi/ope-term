{
  description = "ope-term reproducible Tauri development and build environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs, ... }:
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
            "dist"
            "docs"
            "fuzz"
            "gen"
            "issues"
            "node_modules"
            "artifacts"
            "result"
            "scripts"
            "target"
            ".bazelrc"
            ".bazelversion"
            ".cargo"
            ".envrc"
            ".github"
            ".gitignore"
            "BUILD.bazel"
            "CONTRIBUTING.md"
            "flake.lock"
            "flake.nix"
            "Justfile"
            "MODULE.bazel"
            "MODULE.bazel.lock"
            "README.md"
            "REPO.bazel"
            "SECURITY.md"
          ]
          && !nixpkgs.lib.hasPrefix "bazel-" name
          && !nixpkgs.lib.hasPrefix "result-" name;
      };
      buildFor =
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          linuxBuildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [
            pkgs.glib-networking
            pkgs.libayatana-appindicator
            pkgs.webkitgtk_4_1
          ];
          pnpmDeps = pkgs.fetchPnpmDeps {
            pname = "ope-term";
            version = "0.1.0";
            src = source;
            pnpm = pkgs.pnpm_10;
            fetcherVersion = 4;
            hash = "sha256-1iVb+NEBTVsnG2x3T9ELHHO/Tx8Ev2IWA+fa7sAwhnY=";
          };
          frontend = pkgs.stdenvNoCC.mkDerivation {
            pname = "ope-term-frontend";
            version = "0.1.0";
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
          app = pkgs.rustPlatform.buildRustPackage {
            pname = "ope-term";
            version = "0.1.0";
            src = source;

            cargoRoot = "src-tauri";
            buildAndTestSubdir = "src-tauri";
            cargoLock.lockFile = ./src-tauri/Cargo.lock;
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

            preBuild = ''
              pnpm run build
            '';

            doCheck = true;

            meta = {
              description = "Route-first SSH terminal for operators and developers";
              homepage = "https://github.com/hjosugi/ope-term";
              license = pkgs.lib.licenses.mit;
              mainProgram = "ope-term";
              platforms = pkgs.lib.platforms.linux ++ pkgs.lib.platforms.darwin;
            };
          };
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

      checks = forAllSystems (system: {
        package = self.packages.${system}.default;
        frontend = self.packages.${system}.frontend;
      });

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
            pkgs.gtk3
            pkgs.libayatana-appindicator
            pkgs.libsoup_3
            pkgs.librsvg
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
