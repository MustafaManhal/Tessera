# Ghostty Web spike

This isolated browser probe compares the published `ghostty-web@0.4.0` API with the installed xterm 6.0.0 baseline.
It is not imported or built by the app. It uses the npm package from jsDelivr and the workspace's existing xterm
packages; no dependency was added.

Run it from the workspace root:

```sh
pnpm exec vite packages/term/spikes/ghostty-web --host 127.0.0.1 --port 1423 --strictPort
```

Open `http://127.0.0.1:1423/`. The page shows initialization/first-paint time, Unicode buffer text, selection, and
search/OSC hook availability. The button runs 100 MiB through each engine, pacing writes at 512 KiB per frame.
Measurements and the recommendation are in `.ai/research/terminal-engine.md`.
