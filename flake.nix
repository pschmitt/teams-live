{
  description = "teams-live - Microsoft Teams push watcher and GitLab MR integration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    teams-auth-source = {
      url = "github:pschmitt/homeassistant-msteams";
      flake = false;
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      teams-auth-source,
    }:
    let
      eachSystem = flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-linux" ] (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          msteams-mcp = pkgs.callPackage ./nix/msteams-mcp { inherit teams-auth-source; };
          teams-live = pkgs.callPackage ./nix/package.nix { inherit msteams-mcp; };
        in
        {
          packages = {
            default = teams-live;
            inherit teams-live msteams-mcp;
          };

          checks = {
            inherit teams-live;
            nixfmt =
              pkgs.runCommand "teams-live-nixfmt"
                {
                  nativeBuildInputs = [ pkgs.nixfmt ];
                }
                ''
                  cd ${self}
                  nixfmt --check flake.nix nix/*.nix nix/msteams-mcp/*.nix
                  touch $out
                '';
          };

          formatter = pkgs.nixfmt;

          devShells.default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs
              just
              nixfmt
            ];
          };
        }
      );
    in
    eachSystem
    // {
      hydraJobs = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (system: {
        packages = self.packages.${system} or { };
        checks = self.checks.${system} or { };
      });

      overlays.default = _final: prev: {
        msteams-mcp = prev.callPackage ./nix/msteams-mcp { inherit teams-auth-source; };
        teams-live = prev.callPackage ./nix/package.nix {
          msteams-mcp =
            prev.msteams-mcp or (prev.callPackage ./nix/msteams-mcp { inherit teams-auth-source; });
        };
      };

      nixosModules.default =
        { lib, pkgs, ... }:
        {
          imports = [ ./nix/module.nix ];
          services.teams-live.package =
            lib.mkDefault
              self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        };
      nixosModules.teams-live = self.nixosModules.default;
    };
}
