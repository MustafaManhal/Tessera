// @xterm/addon-ligatures 0.10.0 ships only its ESM build, but its package.json `main` names a missing CommonJS file.
// We import the ESM file by path, so it resolves in Vite and in Node; this gives that path the package's types.
declare module "@xterm/addon-ligatures/lib/addon-ligatures.mjs" {
  export { LigaturesAddon } from "@xterm/addon-ligatures";
}

// xterm's stylesheet, imported for its side effect (Vite bundles it; Vitest ignores CSS).
declare module "@xterm/xterm/css/xterm.css";
