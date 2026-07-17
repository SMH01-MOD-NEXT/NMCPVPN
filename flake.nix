{
  description = "Combined MCP server: filesystem, shell, processes, git, web and memory tools over SSE/stdio";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        node = pkgs.nodejs_22;
      in {
        # Development / runtime shell: `nix develop`, then `npm install && node index.js`
        devShells.default = pkgs.mkShell {
          packages = [ node pkgs.git ];
        };

        # `nix run .#server` from a checkout where `npm install` has been done.
        apps.server = {
          type = "app";
          program = toString (pkgs.writeShellScript "mcp-server" ''
            if [ ! -d node_modules ]; then
              echo "node_modules not found: run 'npm install' in the project directory first" >&2
              exit 1
            fi
            exec ${node}/bin/node index.js "$@"
          '');
        };
      });
}
