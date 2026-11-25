// Colour themes for the whole app, in the spirit of VS Code's: a theme sets every colour, from the title bar, sidebar,
// status bar and task names down to the terminal's 16 ANSI colours. Each theme is written as a small palette (the
// colours a designer picks); `buildTheme` fills in the rest and nudges any colour that would be hard to read until it
// meets WCAG AA on every surface it is drawn on (text 4.5:1, icons and edges 3:1; high contrast themes 7:1 for text).
// `tests/contrast.test.ts` checks every pair the components use, for every theme.
import { contrastRatio, mixSrgb, parseColor } from "./contrast";

export type ThemeKind = "light" | "dark";

/** What a designer picks for a theme. Hex colours, `#rrggbb`. */
export interface ThemeSpec {
  id: string;
  name: string;
  kind: ThemeKind;
  /** High contrast: text at 7:1 and strong edges. */
  highContrast?: boolean;
  /** The terminal and editor area, and the open tab. */
  bg: string;
  /** Dialogs, menus, cards, the settings panel. */
  surface: string;
  sidebar: string;
  titlebar: string;
  statusbar: string;
  statusbarFg?: string;
  /** Hover fill for rows, tabs and quiet buttons. */
  hover: string;
  /** The selected row and pressed controls. */
  selected: string;
  border: string;
  /** Edges of inputs, selects and switches (3:1). Derived from the border and the text when absent. */
  borderStrong?: string;
  text: string;
  muted: string;
  /** Primary buttons, the open tab's mark, links, the task in front. */
  accent: string;
  accentFg?: string;
  /** The hues behind status colours and tab dots. */
  hues: { red: string; orange: string; yellow: string; green: string; blue: string; purple: string };
  terminal: {
    background?: string;
    foreground?: string;
    cursor?: string;
    selection?: string;
    /** Black, red, green, yellow, blue, magenta, cyan, white, then the bright ones. */
    ansi: string[];
  };
}

export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  ansi: string[];
}

export interface ColorTheme {
  id: string;
  name: string;
  kind: ThemeKind;
  highContrast: boolean;
  /** Every base token, as CSS custom properties (`--bg`: `#1f1f1f`). */
  variables: Record<string, string>;
  terminal: TerminalPalette;
  /** The palette the theme was built from (a primary colour override rebuilds the theme from it). */
  spec: ThemeSpec;
  /** The primary colour the user picked instead of the theme's own, when there is one. */
  accentOverride?: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Colour maths

const toHex = (rgba: readonly number[]) =>
  `#${rgba
    .slice(0, 3)
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

/** `a` mixed with `b`, `weight` (0–1) of `a`, like `color-mix(in srgb, a weight, b)`. */
export function mix(a: string, b: string, weight: number): string {
  return toHex(mixSrgb(parseColor(a), parseColor(b), weight));
}

const contrast = (a: string, b: string) => contrastRatio(a, b);

/** `colour` moved toward `target` in small steps until it has `min` contrast on every surface (or reaches `target`). */
function ensure(colour: string, surfaces: readonly string[], min: number, target: string): string {
  for (let step = 0; step <= 40; step++) {
    const candidate = mix(target, colour, step / 40);
    if (surfaces.every((surface) => contrast(candidate, surface) >= min)) return candidate;
  }
  return target;
}

/** Like `ensure`, for a status colour that also sits on its own tint (12 % of itself over the surface). */
function ensureStatus(colour: string, surfaces: readonly string[], min: number, target: string): string {
  for (let step = 0; step <= 40; step++) {
    const candidate = mix(target, colour, step / 40);
    const tints = surfaces.map((surface) => mix(candidate, surface, 0.12));
    if ([...surfaces, ...tints].every((surface) => contrast(candidate, surface) >= min)) return candidate;
  }
  return target;
}

/** Black for a light colour, white for a dark one: the direction in which a fill gains contrast with `label`. */
function awayFrom(label: string): string {
  return contrast(label, "#000000") > contrast(label, "#ffffff") ? "#000000" : "#ffffff";
}

/** Text for a fill: whichever of near-black and white reads better. */
function onFill(fill: string): string {
  return contrast("#0a0a0a", fill) >= contrast("#ffffff", fill) ? "#0a0a0a" : "#ffffff";
}

// ---------------------------------------------------------------------------------------------------------------------
// Building a theme

export function buildTheme(spec: ThemeSpec): ColorTheme {
  const dark = spec.kind === "dark";
  const far = dark ? "#ffffff" : "#000000";
  const textMin = spec.highContrast ? 7 : 4.5;

  // Text sits on every surface, the hover and selected fills, a selected nav item (the accent over the surface) and a
  // pressed secondary button (the selected fill toward the text).
  const surfaces = [spec.bg, spec.surface, spec.sidebar, spec.titlebar, spec.hover, spec.selected];
  const accentSoft = mix(spec.accent, spec.surface, 0.22);
  const text = ensure(spec.text, [...surfaces, accentSoft, mix(spec.selected, far, 0.88)], textMin, far);
  const muted = ensure(spec.muted, surfaces, spec.highContrast ? 7 : 4.5, far);
  const borderStrong = ensure(
    spec.borderStrong ?? mix(spec.text, spec.border, 0.35),
    [spec.bg, spec.surface, spec.sidebar, spec.titlebar, spec.hover],
    3,
    far,
  );
  const ink = ensure(spec.accent, surfaces, 4.5, far);

  // The accent fill and its label. Hover and press move away from the label, so they only gain contrast.
  const accentFg = spec.accentFg ?? onFill(spec.accent);
  const accentShade = awayFrom(accentFg);
  const accent = ensure(spec.accent, [accentFg], 4.5, accentShade);

  // Status colours: 3:1 on every surface and on their own tint; the error colour is also inline text (4.5:1).
  const statusSurfaces = [spec.bg, spec.surface, spec.sidebar, spec.hover, spec.selected];
  const error = ensureStatus(ensure(spec.hues.red, [spec.bg, spec.surface], 4.5, far), statusSurfaces, 3, far);
  const status = {
    working: ensureStatus(spec.hues.blue, statusSurfaces, 3, far),
    needs: ensureStatus(dark ? spec.hues.yellow : spec.hues.orange, statusSurfaces, 3, far),
    done: ensureStatus(spec.hues.green, statusSurfaces, 3, far),
    error,
    off: ensureStatus(mix(spec.muted, spec.bg, 0.8), statusSurfaces, 3, far),
  };
  const dangerFg = onFill(error);
  const dangerShade = awayFrom(dangerFg);
  const tab = Object.fromEntries(
    (["red", "orange", "yellow", "green", "blue", "purple"] as const).map((hue) => [
      hue,
      ensure(spec.hues[hue], surfaces, 3, far),
    ]),
  ) as Record<keyof ThemeSpec["hues"], string>;

  // The status bar may be coloured (Dark+ is blue). Its hover moves away from the label, so the label stays readable.
  const barFar = contrast("#ffffff", spec.statusbar) >= contrast("#000000", spec.statusbar) ? "#ffffff" : "#000000";
  const statusbarFg = ensure(spec.statusbarFg ?? muted, [spec.statusbar], 4.5, barFar);
  const barShade = awayFrom(statusbarFg);
  // Hover lifts the bar toward its label when the label stays readable on it; otherwise it moves the other way.
  const towardLabel = (amount: number) => mix(statusbarFg, spec.statusbar, amount);
  const awayFromLabel = (amount: number) => mix(barShade, spec.statusbar, amount);
  const statusbarHover = contrast(statusbarFg, towardLabel(0.12)) >= 4.5 ? towardLabel(0.12) : awayFromLabel(0.16);
  const statusbarActive = contrast(statusbarFg, towardLabel(0.2)) >= 4.5 ? towardLabel(0.2) : awayFromLabel(0.26);

  const variables: Record<string, string> = {
    "--bg": spec.bg,
    "--surface": spec.surface,
    "--surface-2": spec.hover,
    "--surface-3": spec.selected,
    "--sidebar-bg": spec.sidebar,
    "--titlebar-bg": spec.titlebar,
    "--statusbar-bg": spec.statusbar,
    "--statusbar-fg": statusbarFg,
    "--statusbar-hover": statusbarHover,
    "--statusbar-active": statusbarActive,
    "--border": spec.border,
    "--border-strong": borderStrong,
    "--text": text,
    "--text-muted": muted,
    "--accent": accent,
    "--accent-fg": accentFg,
    "--accent-ink": ink,
    "--accent-shade": accentShade,
    "--danger-fg": dangerFg,
    "--danger-shade": dangerShade,
    "--overlay": dark ? "rgb(0 0 0 / 0.6)" : "rgb(0 0 0 / 0.32)",
    "--st-working": status.working,
    "--st-needs": status.needs,
    "--st-done": status.done,
    "--st-error": status.error,
    "--st-off": status.off,
    "--tab-red": tab.red,
    "--tab-orange": tab.orange,
    "--tab-yellow": tab.yellow,
    "--tab-green": tab.green,
    "--tab-blue": tab.blue,
    "--tab-purple": tab.purple,
  };

  const background = spec.terminal.background ?? spec.bg;
  const foreground = spec.terminal.foreground ?? text;
  return {
    id: spec.id,
    name: spec.name,
    kind: spec.kind,
    highContrast: spec.highContrast ?? false,
    spec,
    variables,
    terminal: {
      background,
      foreground,
      cursor: spec.terminal.cursor ?? foreground,
      selection: spec.terminal.selection ?? mix(spec.accent, background, dark ? 0.35 : 0.25),
      ansi: spec.terminal.ansi,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The themes

const VSCODE_DARK_ANSI = [
  "#000000",
  "#cd3131",
  "#0dbc79",
  "#e5e510",
  "#2472c8",
  "#bc3fbc",
  "#11a8cd",
  "#e5e5e5",
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#e5e5e5",
];

const VSCODE_LIGHT_ANSI = [
  "#000000",
  "#cd3131",
  "#107c10",
  "#795e26",
  "#0451a5",
  "#bc05bc",
  "#0598bc",
  "#555555",
  "#666666",
  "#cd3131",
  "#14a314",
  "#949800",
  "#0451a5",
  "#bc05bc",
  "#0598bc",
  "#a5a5a5",
];

export const THEME_SPECS: ThemeSpec[] = [
  {
    id: "tessera-dark",
    name: "Tessera Dark",
    kind: "dark",
    bg: "#16181c",
    surface: "#1c1f24",
    sidebar: "#121417",
    titlebar: "#121417",
    statusbar: "#121417",
    hover: "#23272d",
    selected: "#2b3038",
    border: "#262a30",
    text: "#e4e7eb",
    muted: "#9aa2ad",
    accent: "#2f6feb",
    accentFg: "#ffffff",
    hues: {
      red: "#f2555a",
      orange: "#f0883e",
      yellow: "#f5b83d",
      green: "#3ecf8e",
      blue: "#5c9cf5",
      purple: "#b392f0",
    },
    terminal: {
      ansi: [
        "#2a2e35",
        "#f2555a",
        "#3ecf8e",
        "#f5b83d",
        "#5eb1ef",
        "#c690f5",
        "#4fd1d9",
        "#d5d9de",
        "#5f6673",
        "#ff7b7f",
        "#6ee7b0",
        "#ffd479",
        "#8ccaf7",
        "#dbb3ff",
        "#7fe3e9",
        "#ffffff",
      ],
    },
  },
  {
    id: "tessera-light",
    name: "Tessera Light",
    kind: "light",
    bg: "#ffffff",
    surface: "#ffffff",
    sidebar: "#f5f6f8",
    titlebar: "#eef0f3",
    statusbar: "#f5f6f8",
    hover: "#e9ecf0",
    selected: "#dde2e8",
    border: "#dfe3e8",
    text: "#1b1f24",
    muted: "#5b6470",
    accent: "#2563eb",
    accentFg: "#ffffff",
    hues: {
      red: "#d1242f",
      orange: "#bc4c00",
      yellow: "#9a6700",
      green: "#1a7f37",
      blue: "#0b72d1",
      purple: "#8250df",
    },
    terminal: {
      ansi: [
        "#1b1f24",
        "#cf222e",
        "#1a7f37",
        "#9a6700",
        "#0b72d1",
        "#8250df",
        "#1b7c83",
        "#6e7781",
        "#57606a",
        "#a40e26",
        "#2da44e",
        "#bf8700",
        "#218bff",
        "#a475f9",
        "#3192aa",
        "#8c959f",
      ],
    },
  },
  {
    id: "dark-modern",
    name: "Dark Modern",
    kind: "dark",
    bg: "#1f1f1f",
    surface: "#202020",
    sidebar: "#181818",
    titlebar: "#181818",
    statusbar: "#181818",
    statusbarFg: "#cccccc",
    hover: "#2a2d2e",
    selected: "#37373d",
    border: "#2b2b2b",
    text: "#cccccc",
    muted: "#9d9d9d",
    accent: "#0078d4",
    accentFg: "#ffffff",
    hues: {
      red: "#f85149",
      orange: "#d18616",
      yellow: "#cca700",
      green: "#2ea043",
      blue: "#3794ff",
      purple: "#b180d7",
    },
    terminal: { background: "#181818", ansi: VSCODE_DARK_ANSI },
  },
  {
    id: "light-modern",
    name: "Light Modern",
    kind: "light",
    bg: "#ffffff",
    surface: "#ffffff",
    sidebar: "#f8f8f8",
    titlebar: "#f8f8f8",
    statusbar: "#f8f8f8",
    statusbarFg: "#3b3b3b",
    hover: "#f2f2f2",
    selected: "#e4e6f1",
    border: "#e5e5e5",
    text: "#3b3b3b",
    muted: "#616161",
    accent: "#005fb8",
    accentFg: "#ffffff",
    hues: {
      red: "#e51400",
      orange: "#c24e00",
      yellow: "#bf8803",
      green: "#2ea043",
      blue: "#005fb8",
      purple: "#652d90",
    },
    terminal: { ansi: VSCODE_LIGHT_ANSI },
  },
  {
    id: "dark-plus",
    name: "Dark+",
    kind: "dark",
    bg: "#1e1e1e",
    surface: "#252526",
    sidebar: "#252526",
    titlebar: "#3c3c3c",
    statusbar: "#007acc",
    statusbarFg: "#ffffff",
    hover: "#2a2d2e",
    selected: "#37373d",
    border: "#3c3c3c",
    text: "#cccccc",
    muted: "#a0a0a0",
    accent: "#0e639c",
    accentFg: "#ffffff",
    hues: {
      red: "#f48771",
      orange: "#ce9178",
      yellow: "#dcdcaa",
      green: "#89d185",
      blue: "#3794ff",
      purple: "#c586c0",
    },
    terminal: { ansi: VSCODE_DARK_ANSI },
  },
  {
    id: "light-plus",
    name: "Light+",
    kind: "light",
    bg: "#ffffff",
    surface: "#f3f3f3",
    sidebar: "#f3f3f3",
    titlebar: "#dddddd",
    statusbar: "#007acc",
    statusbarFg: "#ffffff",
    hover: "#e8e8e8",
    selected: "#e4e6f1",
    border: "#d4d4d4",
    text: "#333333",
    muted: "#616161",
    accent: "#007acc",
    accentFg: "#ffffff",
    hues: {
      red: "#e51400",
      orange: "#a31515",
      yellow: "#795e26",
      green: "#388a34",
      blue: "#0070c1",
      purple: "#af00db",
    },
    terminal: { ansi: VSCODE_LIGHT_ANSI },
  },
  {
    id: "monokai",
    name: "Monokai",
    kind: "dark",
    bg: "#272822",
    surface: "#1e1f1c",
    sidebar: "#1e1f1c",
    titlebar: "#1e1f1c",
    statusbar: "#414339",
    statusbarFg: "#f8f8f2",
    hover: "#3e3d32",
    selected: "#49483e",
    border: "#3b3c35",
    text: "#f8f8f2",
    muted: "#a59f85",
    accent: "#a6e22e",
    hues: {
      red: "#f92672",
      orange: "#fd971f",
      yellow: "#e6db74",
      green: "#a6e22e",
      blue: "#66d9ef",
      purple: "#ae81ff",
    },
    terminal: {
      ansi: [
        "#333333",
        "#f92672",
        "#a6e22e",
        "#e6db74",
        "#66d9ef",
        "#ae81ff",
        "#a1efe4",
        "#e3e3dd",
        "#75715e",
        "#ff6a9e",
        "#c4f060",
        "#f4ec9c",
        "#8ee4f5",
        "#c9a8ff",
        "#c2f7ef",
        "#f8f8f2",
      ],
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    kind: "dark",
    bg: "#002b36",
    surface: "#00212b",
    sidebar: "#00212b",
    titlebar: "#002c39",
    statusbar: "#00212b",
    statusbarFg: "#93a1a1",
    hover: "#04313c",
    selected: "#073642",
    border: "#0b3b47",
    text: "#93a1a1",
    muted: "#839496",
    accent: "#2aa198",
    hues: {
      red: "#dc322f",
      orange: "#cb4b16",
      yellow: "#b58900",
      green: "#859900",
      blue: "#268bd2",
      purple: "#6c71c4",
    },
    terminal: {
      foreground: "#93a1a1",
      ansi: [
        "#073642",
        "#dc322f",
        "#859900",
        "#b58900",
        "#268bd2",
        "#d33682",
        "#2aa198",
        "#eee8d5",
        "#586e75",
        "#cb4b16",
        "#93a1a1",
        "#b58900",
        "#839496",
        "#6c71c4",
        "#93a1a1",
        "#fdf6e3",
      ],
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    kind: "light",
    bg: "#fdf6e3",
    surface: "#fdf6e3",
    sidebar: "#eee8d5",
    titlebar: "#eee8d5",
    statusbar: "#eee8d5",
    statusbarFg: "#586e75",
    hover: "#e9e2cb",
    selected: "#dfd8bf",
    border: "#ddd6c1",
    text: "#4b5e66",
    muted: "#596b72",
    accent: "#268bd2",
    accentFg: "#ffffff",
    hues: {
      red: "#dc322f",
      orange: "#cb4b16",
      yellow: "#b58900",
      green: "#859900",
      blue: "#268bd2",
      purple: "#6c71c4",
    },
    terminal: {
      foreground: "#4b5e66",
      ansi: [
        "#073642",
        "#dc322f",
        "#6f8000",
        "#946f00",
        "#1f74b0",
        "#d33682",
        "#1d8079",
        "#93a1a1",
        "#586e75",
        "#cb4b16",
        "#586e75",
        "#657b83",
        "#3e5056",
        "#6c71c4",
        "#3e5056",
        "#002b36",
      ],
    },
  },
  {
    id: "github-dark",
    name: "GitHub Dark",
    kind: "dark",
    bg: "#0d1117",
    surface: "#161b22",
    sidebar: "#010409",
    titlebar: "#010409",
    statusbar: "#0d1117",
    statusbarFg: "#8b949e",
    hover: "#1c2129",
    selected: "#262c36",
    border: "#30363d",
    text: "#e6edf3",
    muted: "#8b949e",
    accent: "#1f6feb",
    accentFg: "#ffffff",
    hues: {
      red: "#f85149",
      orange: "#db6d28",
      yellow: "#d29922",
      green: "#3fb950",
      blue: "#2f81f7",
      purple: "#a371f7",
    },
    terminal: {
      ansi: [
        "#484f58",
        "#ff7b72",
        "#3fb950",
        "#d29922",
        "#58a6ff",
        "#bc8cff",
        "#39c5cf",
        "#b1bac4",
        "#6e7681",
        "#ffa198",
        "#56d364",
        "#e3b341",
        "#79c0ff",
        "#d2a8ff",
        "#56d4dd",
        "#ffffff",
      ],
    },
  },
  {
    id: "github-light",
    name: "GitHub Light",
    kind: "light",
    bg: "#ffffff",
    surface: "#ffffff",
    sidebar: "#f6f8fa",
    titlebar: "#f6f8fa",
    statusbar: "#ffffff",
    statusbarFg: "#59636e",
    hover: "#eef1f4",
    selected: "#e2e6ea",
    border: "#d1d9e0",
    text: "#1f2328",
    muted: "#59636e",
    accent: "#0969da",
    accentFg: "#ffffff",
    hues: {
      red: "#d1242f",
      orange: "#bc4c00",
      yellow: "#9a6700",
      green: "#1a7f37",
      blue: "#0969da",
      purple: "#8250df",
    },
    terminal: {
      ansi: [
        "#24292f",
        "#cf222e",
        "#116329",
        "#4d2d00",
        "#0969da",
        "#8250df",
        "#1b7c83",
        "#6e7781",
        "#57606a",
        "#a40e26",
        "#1a7f37",
        "#633c01",
        "#218bff",
        "#a475f9",
        "#3192aa",
        "#8c959f",
      ],
    },
  },
  {
    id: "one-dark",
    name: "One Dark",
    kind: "dark",
    bg: "#282c34",
    surface: "#21252b",
    sidebar: "#21252b",
    titlebar: "#21252b",
    statusbar: "#21252b",
    statusbarFg: "#9da5b4",
    hover: "#2c313a",
    selected: "#3a3f4b",
    border: "#181a1f",
    borderStrong: "#5c6370",
    text: "#d7dae0",
    muted: "#9da5b4",
    accent: "#61afef",
    hues: {
      red: "#e06c75",
      orange: "#d19a66",
      yellow: "#e5c07b",
      green: "#98c379",
      blue: "#61afef",
      purple: "#c678dd",
    },
    terminal: {
      foreground: "#abb2bf",
      ansi: [
        "#3f4451",
        "#e06c75",
        "#98c379",
        "#e5c07b",
        "#61afef",
        "#c678dd",
        "#56b6c2",
        "#d7dae0",
        "#5c6370",
        "#ff7a85",
        "#b5e08f",
        "#f0d197",
        "#7dc3ff",
        "#de95f0",
        "#6fd0dc",
        "#ffffff",
      ],
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    kind: "dark",
    bg: "#282a36",
    surface: "#21222c",
    sidebar: "#21222c",
    titlebar: "#21222c",
    statusbar: "#191a21",
    statusbarFg: "#f8f8f2",
    hover: "#343746",
    selected: "#44475a",
    border: "#191a21",
    borderStrong: "#6272a4",
    text: "#f8f8f2",
    muted: "#a3acd0",
    accent: "#bd93f9",
    hues: {
      red: "#ff5555",
      orange: "#ffb86c",
      yellow: "#f1fa8c",
      green: "#50fa7b",
      blue: "#8be9fd",
      purple: "#bd93f9",
    },
    terminal: {
      ansi: [
        "#21222c",
        "#ff5555",
        "#50fa7b",
        "#f1fa8c",
        "#bd93f9",
        "#ff79c6",
        "#8be9fd",
        "#f8f8f2",
        "#6272a4",
        "#ff6e6e",
        "#69ff94",
        "#ffffa5",
        "#d6acff",
        "#ff92df",
        "#a4ffff",
        "#ffffff",
      ],
    },
  },
  {
    id: "nord",
    name: "Nord",
    kind: "dark",
    bg: "#2e3440",
    surface: "#343a47",
    sidebar: "#2e3440",
    titlebar: "#2e3440",
    statusbar: "#3b4252",
    statusbarFg: "#d8dee9",
    hover: "#3b4252",
    selected: "#434c5e",
    border: "#3b4252",
    borderStrong: "#616e88",
    text: "#d8dee9",
    muted: "#a3adbf",
    accent: "#88c0d0",
    hues: {
      red: "#bf616a",
      orange: "#d08770",
      yellow: "#ebcb8b",
      green: "#a3be8c",
      blue: "#81a1c1",
      purple: "#b48ead",
    },
    terminal: {
      ansi: [
        "#3b4252",
        "#bf616a",
        "#a3be8c",
        "#ebcb8b",
        "#81a1c1",
        "#b48ead",
        "#88c0d0",
        "#e5e9f0",
        "#4c566a",
        "#d57780",
        "#b6d0a0",
        "#f0d8a8",
        "#9ab6d3",
        "#c7a3c0",
        "#8fbcbb",
        "#eceff4",
      ],
    },
  },
  {
    id: "high-contrast-dark",
    name: "High Contrast Dark",
    kind: "dark",
    highContrast: true,
    bg: "#000000",
    surface: "#0a0a0a",
    sidebar: "#000000",
    titlebar: "#000000",
    statusbar: "#000000",
    statusbarFg: "#ffffff",
    hover: "#1a1a1a",
    selected: "#2b2b2b",
    border: "#6fc3df",
    borderStrong: "#6fc3df",
    text: "#ffffff",
    muted: "#d6d6d6",
    accent: "#f38518",
    accentFg: "#000000",
    hues: {
      red: "#ff6b6b",
      orange: "#f38518",
      yellow: "#ffeb3b",
      green: "#4eea6a",
      blue: "#6cb6ff",
      purple: "#e08cff",
    },
    terminal: {
      ansi: [
        "#000000",
        "#ff6b6b",
        "#4eea6a",
        "#ffeb3b",
        "#6cb6ff",
        "#ff77ff",
        "#4ce6ff",
        "#e5e5e5",
        "#7f7f7f",
        "#ff8f8f",
        "#7df58f",
        "#fff176",
        "#9ccdff",
        "#ffa3ff",
        "#8cf0ff",
        "#ffffff",
      ],
    },
  },
  {
    id: "high-contrast-light",
    name: "High Contrast Light",
    kind: "light",
    highContrast: true,
    bg: "#ffffff",
    surface: "#ffffff",
    sidebar: "#ffffff",
    titlebar: "#ffffff",
    statusbar: "#ffffff",
    statusbarFg: "#000000",
    hover: "#ebebeb",
    selected: "#dcdcdc",
    border: "#0f4a85",
    borderStrong: "#0f4a85",
    text: "#000000",
    muted: "#292929",
    accent: "#0f4a85",
    accentFg: "#ffffff",
    hues: {
      red: "#b5200d",
      orange: "#8f3a00",
      yellow: "#6c5400",
      green: "#136c00",
      blue: "#0f4a85",
      purple: "#6f2a9e",
    },
    terminal: {
      ansi: [
        "#000000",
        "#b5200d",
        "#136c00",
        "#6c5400",
        "#0f4a85",
        "#8b008b",
        "#006c7a",
        "#555555",
        "#444444",
        "#b5200d",
        "#136c00",
        "#6c5400",
        "#0f4a85",
        "#8b008b",
        "#006c7a",
        "#333333",
      ],
    },
  },
];

export const COLOR_THEMES: readonly ColorTheme[] = THEME_SPECS.map(buildTheme);

export const DEFAULT_THEME_IDS: Record<ThemeKind, string> = { dark: "Tessera Dark", light: "Tessera Light" };

/** The theme a config value names (its name or id, any case); null when nothing matches. */
export function findColorTheme(name: unknown): ColorTheme | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const wanted = name.trim().toLowerCase();
  return COLOR_THEMES.find((theme) => theme.name.toLowerCase() === wanted || theme.id === wanted) ?? null;
}

/** The theme a config value names, or the default theme of `kind` when nothing matches. */
export function colorThemeOr(name: unknown, kind: ThemeKind): ColorTheme {
  return findColorTheme(name) ?? (findColorTheme(DEFAULT_THEME_IDS[kind]) as ColorTheme);
}

// ---------------------------------------------------------------------------------------------------------------------
// The primary colour (accent) override

/** Primary colours offered next to "Theme default". Any other colour can be picked too. */
export const ACCENT_PRESETS: readonly { id: string; name: string; fill: string }[] = [
  { id: "blue", name: "Blue", fill: "#2f6feb" },
  { id: "sky", name: "Sky", fill: "#38a3f5" },
  { id: "babyblue", name: "Baby blue", fill: "#89cff0" },
  { id: "teal", name: "Teal", fill: "#14a89a" },
  { id: "green", name: "Green", fill: "#22a352" },
  { id: "lime", name: "Lime", fill: "#9bd22e" },
  { id: "yellow", name: "Yellow", fill: "#e8b417" },
  { id: "orange", name: "Orange", fill: "#f07b22" },
  { id: "red", name: "Red", fill: "#e5484d" },
  { id: "pink", name: "Pink", fill: "#e6539f" },
  { id: "purple", name: "Purple", fill: "#8e5cf0" },
  { id: "graphite", name: "Graphite", fill: "#6b7280" },
];

/** "#rrggbb" for a 3 or 6 digit hex colour (with or without "#"); null for anything else, including "". */
export function normalizeAccent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const six = /^\s*#?([0-9a-f]{6})\s*$/i.exec(value)?.[1];
  if (six) return `#${six.toLowerCase()}`;
  const three = /^\s*#?([0-9a-f]{3})\s*$/i.exec(value)?.[1];
  return three
    ? `#${[...three]
        .map((c) => c + c)
        .join("")
        .toLowerCase()}`
    : null;
}

/**
 * The theme with another primary colour: buttons, links, the open tab's mark, the task in front, switches and the
 * focus ring. The theme is rebuilt from its palette, so the label on the colour and the colour as text are nudged to
 * stay readable exactly as for the theme's own accent. An empty or invalid colour keeps the theme as it is.
 */
export function withAccent(theme: ColorTheme, accent: unknown): ColorTheme {
  const fill = normalizeAccent(accent);
  if (!fill || fill === theme.spec.accent) return theme;
  const { accentFg: _themeLabel, ...spec } = theme.spec;
  // The result keeps the theme's own palette, so "Theme default" still knows the theme's colour.
  return { ...buildTheme({ ...spec, accent: fill }), spec: theme.spec, accentOverride: fill };
}
