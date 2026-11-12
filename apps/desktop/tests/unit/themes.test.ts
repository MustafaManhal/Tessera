import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILTIN_NAMES, builtinThemes, isBuiltinName, resolveTheme } from "../../src/themes/catalog";
import {
  appearanceOf,
  chromeVariables,
  contrastOf,
  isHighContrast,
  makeTheme,
  normalizeHex,
  themeIssues,
  toEngineTheme,
} from "../../src/themes/model";
import {
  detectFormat,
  parseGhostty,
  parseItermColors,
  parseThemeFile,
  parseWindowsTerminal,
  type ThemeParseError,
} from "../../src/themes/parsers";

const ANSI = [
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
];

function plist(colours: Record<string, string>, omit: string[] = []): string {
  const part = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
    return `<dict><key>Alpha Component</key><real>1</real><key>Blue Component</key><real>${b}</real><key>Color Space</key><string>sRGB</string><key>Green Component</key><real>${g}</real><key>Red Component</key><real>${r}</real></dict>`;
  };
  const entries = Object.entries(colours).filter(([key]) => !omit.includes(key));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${entries.map(([key, hex]) => `<key>${key}</key>\n${part(hex)}`).join("\n")}\n</dict>\n</plist>\n`;
}
const itermColours = (): Record<string, string> => ({
  ...Object.fromEntries(ANSI.map((hex, i) => [`Ansi ${i} Color`, hex])),
  "Background Color": "#282a36",
  "Foreground Color": "#f8f8f2",
  "Cursor Color": "#ffb86c",
  "Selection Color": "#44475a",
});

const wtScheme = (extra: Record<string, unknown> = {}) => ({
  name: "Dracula",
  black: ANSI[0],
  red: ANSI[1],
  green: ANSI[2],
  yellow: ANSI[3],
  blue: ANSI[4],
  purple: ANSI[5],
  cyan: ANSI[6],
  white: ANSI[7],
  brightBlack: ANSI[8],
  brightRed: ANSI[9],
  brightGreen: ANSI[10],
  brightYellow: ANSI[11],
  brightBlue: ANSI[12],
  brightPurple: ANSI[13],
  brightCyan: ANSI[14],
  brightWhite: ANSI[15],
  background: "#282a36",
  foreground: "#f8f8f2",
  cursorColor: "#f8f8f2",
  selectionBackground: "#44475a",
  ...extra,
});

const ghostty = (lines: string[] = []) =>
  [
    "# Dracula",
    ...ANSI.map((hex, i) => `palette = ${i}=${hex}`),
    "background = 282a36",
    "foreground = #f8f8f2",
    "cursor-color = #f8f8f2",
    "selection-background = #44475a",
    ...lines,
  ].join("\n");

describe("iTerm2 .itermcolors", () => {
  it("reads the 16 colours, background, foreground, cursor and selection", () => {
    const theme = parseItermColors(plist(itermColours()), "/Users/me/Downloads/Dracula.itermcolors");
    expect(theme).toMatchObject({
      name: "Dracula",
      id: "imported:Dracula",
      appearance: "dark",
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#ffb86c",
      selection: "#44475a",
      imported: true,
    });
    expect(theme.ansi).toEqual(ANSI);
  });

  it("falls back to the foreground when cursor and selection are missing", () => {
    const theme = parseItermColors(plist(itermColours(), ["Cursor Color", "Selection Color"]), "x.itermcolors");
    expect(theme.cursor).toBe("#f8f8f2");
    expect(theme.selection).toBe("#f8f8f2");
  });

  it("rejects what is not a colour scheme", () => {
    const reason = (text: string) => {
      try {
        parseItermColors(text, "x");
      } catch (cause) {
        return (
          (cause as ThemeParseError).reason +
          ((cause as ThemeParseError).detail ? `:${(cause as ThemeParseError).detail}` : "")
        );
      }
      return "none";
    };
    expect(reason("hello")).toBe("badXml");
    expect(reason("<plist><dict></dict>")).toBe("badXml");
    expect(reason("<plist><dict></dict></plist>")).toBe("missingColour:Ansi 0 Color");
    expect(reason(plist(itermColours(), ["Ansi 9 Color"]))).toBe("missingColour:Ansi 9 Color");
    expect(reason(plist(itermColours(), ["Background Color"]))).toBe("missingColour:Background Color");
    expect(
      reason(
        plist(itermColours()).replace(
          /<key>Red Component<\/key><real>[^<]*<\/real>/,
          "<key>Red Component</key><real>x</real>",
        ),
      ),
    ).toBe("badColour:Ansi 0 Color");
  });
});

describe("Ghostty theme files", () => {
  it("reads palette, background, foreground, cursor and selection (with or without #)", () => {
    const theme = parseGhostty(ghostty(), "dracula");
    expect(theme).toMatchObject({ name: "dracula", background: "#282a36", cursor: "#f8f8f2", selection: "#44475a" });
    expect(theme.ansi).toEqual(ANSI);
  });

  it("rejects missing, malformed and out-of-form colours", () => {
    const fails = (text: string) => {
      try {
        parseGhostty(text, "x");
        return null;
      } catch (cause) {
        return `${(cause as ThemeParseError).reason}:${(cause as ThemeParseError).detail}`;
      }
    };
    expect(fails(ghostty().replace("palette = 3=#f1fa8c\n", ""))).toBe("missingColour:palette 3");
    expect(fails(ghostty().replace("background = 282a36\n", ""))).toBe("missingColour:background");
    expect(fails(ghostty(["foreground = blue"]))).toBe("badColour:foreground");
    expect(fails(ghostty(["palette = nonsense"]))).toBe("badColour:palette = nonsense");
    expect(fails(ghostty().replace("palette = 1=#ff5555", "palette = 1=#ff55"))).toBe("badColour:palette 1");
  });
});

describe("Windows Terminal JSON", () => {
  it("reads one scheme, a list, and a settings.json", () => {
    const one = parseWindowsTerminal(JSON.stringify(wtScheme()), "x.json");
    expect(one).toHaveLength(1);
    expect(one[0]?.ansi).toEqual(ANSI);
    expect(
      parseWindowsTerminal(JSON.stringify([wtScheme(), wtScheme({ name: "Other", background: "#ffffff" })]), "x"),
    ).toHaveLength(2);
    const settings = parseWindowsTerminal(
      JSON.stringify({ profiles: {}, schemes: [wtScheme({ name: "Light", background: "#fafafa" })] }),
      "settings.json",
    );
    expect(settings[0]).toMatchObject({ name: "Light", appearance: "light" });
  });

  it("accepts magenta spelled either way and names the theme after the file when it has no name", () => {
    const { purple, ...rest } = wtScheme();
    const theme = parseWindowsTerminal(
      JSON.stringify({ ...rest, name: undefined, magenta: purple, brightMagenta: ANSI[13], brightPurple: undefined }),
      "/tmp/My Scheme.json",
    );
    expect(theme[0]?.name).toBe("My Scheme");
    expect(theme[0]?.ansi[5]).toBe(ANSI[5]);
  });

  it("rejects bad JSON, empty lists, non-objects, and missing or bad colours", () => {
    const reason = (text: string) => {
      try {
        parseWindowsTerminal(text, "x");
        return "none";
      } catch (cause) {
        return `${(cause as ThemeParseError).reason}:${(cause as ThemeParseError).detail}`;
      }
    };
    expect(reason("{not json")).toBe("badJson:");
    expect(reason("[]")).toBe("unknownFormat:");
    expect(reason("[1]")).toBe("unknownFormat:");
    expect(reason("5")).toBe("unknownFormat:");
    expect(reason(JSON.stringify(wtScheme({ red: undefined })))).toBe("missingColour:red");
    expect(reason(JSON.stringify(wtScheme({ brightCyan: "cyan" })))).toBe("badColour:brightCyan");
    expect(reason(JSON.stringify(wtScheme({ cursorColor: 5 })))).toBe("badColour:cursorColor");
  });
});

describe("format detection", () => {
  it("picks the parser by content, whatever the extension", () => {
    expect(detectFormat(plist(itermColours()))).toBe("iterm");
    expect(detectFormat(JSON.stringify(wtScheme()))).toBe("windowsTerminal");
    expect(detectFormat(ghostty())).toBe("ghostty");
    expect(detectFormat("just some words")).toBeNull();
    expect(parseThemeFile(ghostty(), "a.conf")[0]?.name).toBe("a");
    expect(parseThemeFile(plist(itermColours()), "b.itermcolors")[0]?.name).toBe("b");
  });

  it("reports empty, unknown and oversized files", () => {
    const reason = (text: string) => {
      try {
        parseThemeFile(text, "x");
        return "none";
      } catch (cause) {
        return (cause as ThemeParseError).reason;
      }
    };
    expect(reason("   \n")).toBe("empty");
    expect(reason("hello world")).toBe("unknownFormat");
    expect(reason(`{${" ".repeat(600 * 1024)}}`)).toBe("tooLarge");
  });
});

describe("model: contrast, appearance, engine mapping", () => {
  it("normalises hex colours", () => {
    expect(normalizeHex("#ABCDEF")).toBe("#abcdef");
    expect(normalizeHex("abc")).toBe("#aabbcc");
    for (const bad of ["", "#12", "#12345", "#gggggg", "rgb(1,2,3)", 5, null])
      expect(normalizeHex(bad as string), String(bad)).toBeNull();
  });

  it("measures contrast like WCAG and classifies light and dark", () => {
    expect(contrastOf("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastOf("#777777", "#777777")).toBeCloseTo(1, 5);
    expect(appearanceOf("#fafafa")).toBe("light");
    expect(appearanceOf("#282a36")).toBe("dark");
    expect(isHighContrast({ background: "#000000", foreground: "#ffffff" })).toBe(true);
    expect(isHighContrast({ background: "#282a36", foreground: "#8a8fa0" })).toBe(false);
  });

  it("warns about unreadable text and ANSI colours, and about nothing in a good theme", () => {
    const good = makeTheme({ name: "Good", background: "#282a36", foreground: "#f8f8f2", ansi: ANSI });
    expect(themeIssues(good)).toEqual([]);
    const bad = makeTheme({
      name: "Bad",
      background: "#ffffff",
      foreground: "#cccccc",
      ansi: ANSI.map((hex, i) => (i === 3 ? "#ffff00" : hex)),
    });
    const issues = themeIssues(bad);
    expect(issues[0]).toMatchObject({ kind: "foreground" });
    expect(issues.some((issue) => issue.kind === "ansi" && issue.index === 3)).toBe(true);
    // Black and white may match the background on purpose.
    expect(
      issues.some((issue) => issue.kind === "ansi" && (issue.index === 0 || issue.index === 7 || issue.index === 15)),
    ).toBe(false);
  });

  it("maps a theme to the engine's, with the cursor text in the background colour", () => {
    const engine = toEngineTheme(
      makeTheme({
        name: "T",
        background: "#282a36",
        foreground: "#f8f8f2",
        cursor: "#ffb86c",
        selection: "#44475a",
        ansi: ANSI,
      }),
    );
    expect(engine).toMatchObject({
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#ffb86c",
      cursorAccent: "#282a36",
      selectionBackground: "#44475a",
      black: ANSI[0],
      magenta: ANSI[5],
      brightWhite: ANSI[15],
    });
    expect(chromeVariables(makeTheme({ name: "T", background: "#282a36", foreground: "#fff", ansi: ANSI }))).toEqual({
      "--term-bg": "#282a36",
    });
    expect(chromeVariables(null)).toEqual({});
  });
});

describe("catalog", () => {
  const bundled = (
    JSON.parse(readFileSync(new URL("../../src/themes/iterm2-schemes.json", import.meta.url), "utf8")) as [
      string,
      string,
      string,
      string,
      string,
      string[],
    ][]
  ).map(([name, background, foreground, cursor, selection, ansi]) =>
    makeTheme({
      name,
      background: `#${background}`,
      foreground: `#${foreground}`,
      cursor: `#${cursor}`,
      selection: `#${selection}`,
      ansi: ansi.map((c) => `#${c}`),
    }),
  );

  it("bundles 900+ valid themes", () => {
    expect(bundled.length).toBeGreaterThan(900);
    for (const theme of bundled) {
      expect(theme.ansi, theme.name).toHaveLength(16);
      expect(normalizeHex(theme.background), theme.name).not.toBeNull();
    }
    expect(bundled.some((theme) => theme.appearance === "light")).toBe(true);
    expect(bundled.some((theme) => theme.appearance === "dark")).toBe(true);
  });

  it("resolves names: built-ins to null, imported before bundled, unknown to null", () => {
    expect(isBuiltinName("Tessera Night")).toBe(true);
    expect(isBuiltinName("GitHub Light")).toBe(true);
    expect(isBuiltinName("Dracula")).toBe(false);
    expect(resolveTheme("GitHub Light", [], bundled)).toBeNull();
    expect(resolveTheme("Dracula", [], bundled)?.name).toBe("Dracula");
    const mine = makeTheme({
      name: "Dracula",
      background: "#000000",
      foreground: "#ffffff",
      ansi: ANSI,
      imported: true,
    });
    expect(resolveTheme("Dracula", [mine], bundled)?.imported).toBe(true);
    expect(resolveTheme("No Such Theme", [], bundled)).toBeNull();
    expect(builtinThemes().map((theme) => theme.name)).toEqual([BUILTIN_NAMES.dark, BUILTIN_NAMES.light]);
  });
});
