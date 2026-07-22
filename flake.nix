{
  description = "ope-term reproducible Tauri development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
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
          default = pkgs.mkShell {
            packages = [
              pkgs.cargo
              pkgs.clippy
              pkgs.git
              pkgs.nodejs_24
              pkgs.nixfmt
              pkgs.openssl
              pkgs.pkg-config
              pkgs.rust-analyzer
              pkgs.rustc
              pkgs.rustfmt
            ]
            ++ linuxLibraries;

            LD_LIBRARY_PATH = pkgs.lib.optionalString pkgs.stdenv.isLinux (
              pkgs.lib.makeLibraryPath linuxLibraries
            );

            GIO_MODULE_DIR = pkgs.lib.optionalString pkgs.stdenv.isLinux (
              "${pkgs.glib-networking}/lib/gio/modules"
            );

            shellHook = ''
              export OPE_TERM_DEV_SHELL=1
              echo "ope-term dev shell | node $(node --version) | rustc $(rustc --version | cut -d' ' -f2)"
            '';
          };
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
