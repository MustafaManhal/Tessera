import { describe, expect, it } from "vitest";
import { findPathLinks, parsePathLink, resolvePath, safeUrl, wantsOpen } from "../../src/terminal/links";
import {
  asOneLine,
  lineCount,
  pasteNeedsConfirm,
  previewLines,
  quotePaths,
  quotePosix,
  quotePowerShell,
  stripControlCharacters,
  trimTrailingWhitespace,
} from "../../src/terminal/paste";

describe("safeUrl", () => {
  it("allows http, https and mailto", () => {
    expect(safeUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeUrl("http://localhost:3000")).toBe("http://localhost:3000/");
    expect(safeUrl("mailto:me@example.com")).toBe("mailto:me@example.com");
  });

  it("never allows javascript:, file:, data: or garbage", () => {
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("JavaScript:alert(1)")).toBeNull();
    expect(safeUrl("file:///etc/passwd")).toBeNull();
    expect(safeUrl("data:text/html,<b>x</b>")).toBeNull();
    expect(safeUrl("vscode://file/x")).toBeNull();
    expect(safeUrl("not a url")).toBeNull();
  });
});

describe("findPathLinks", () => {
  const texts = (line: string) => findPathLinks(line).map((m) => m.text);

  it("finds path:line and path:line:col with relative, absolute, home and Windows paths", () => {
    expect(texts("error at src/main.rs:42:7: oops")).toEqual(["src/main.rs:42:7"]);
    expect(texts("./README.md:3 and ../lib/a.ts:10")).toEqual(["./README.md:3", "../lib/a.ts:10"]);
    expect(texts("/Users/me/x.py:1 ~/y.go:2")).toEqual(["/Users/me/x.py:1", "~/y.go:2"]);
    expect(texts("C:\\code\\app.cs:12:4")).toEqual(["C:\\code\\app.cs:12:4"]);
    expect(texts("main.c:9")).toEqual(["main.c:9"]);
  });

  it("gives positions in the line", () => {
    expect(findPathLinks("at a.ts:1")).toEqual([{ start: 3, end: 9, text: "a.ts:1" }]);
  });

  it("does not match URLs, times, plain words or paths without a line", () => {
    expect(texts("see https://example.com/file.ts:12 now")).toEqual([]);
    expect(texts("at 10:42:07 the build ran")).toEqual([]);
    expect(texts("localhost:3000")).toEqual([]);
    expect(texts("src/main.rs and README.md")).toEqual([]);
    expect(texts("a.ts:12:34:56")).toEqual([]);
  });
});

describe("parsePathLink and resolvePath", () => {
  it("splits path, line and column", () => {
    expect(parsePathLink("src/main.rs:42:7")).toEqual({ path: "src/main.rs", line: 42, column: 7 });
    expect(parsePathLink("a.ts:3")).toEqual({ path: "a.ts", line: 3 });
    expect(parsePathLink("a.ts:0")).toBeNull();
    expect(parsePathLink("a.ts")).toBeNull();
  });

  it("resolves against the cwd", () => {
    expect(resolvePath("src/main.rs", "/home/me/shop")).toBe("/home/me/shop/src/main.rs");
    expect(resolvePath("./a/../b.ts", "/home/me")).toBe("/home/me/b.ts");
    expect(resolvePath("../x.ts", "/home/me/shop")).toBe("/home/me/x.ts");
    expect(resolvePath("/etc/hosts", "/home/me")).toBe("/etc/hosts");
    expect(resolvePath("~/x.ts", "/home/me")).toBe("~/x.ts");
    expect(resolvePath("src\\app.cs", "C:\\code")).toBe("C:\\code\\src\\app.cs");
    expect(resolvePath("src\\app.cs", "\\\\server\\share\\repo")).toBe("\\\\server\\share\\repo\\src\\app.cs");
    expect(resolvePath("../README.md", "\\\\server\\share\\repo\\nested")).toBe("\\\\server\\share\\repo\\README.md");
    expect(resolvePath("\\\\other\\share\\file.cs", "C:\\code")).toBe("\\\\other\\share\\file.cs");
  });
});

describe("wantsOpen", () => {
  it("needs Cmd on macOS and Ctrl elsewhere", () => {
    expect(wantsOpen({ metaKey: true, ctrlKey: false }, "mac")).toBe(true);
    expect(wantsOpen({ metaKey: false, ctrlKey: true }, "mac")).toBe(false);
    expect(wantsOpen({ metaKey: false, ctrlKey: true }, "windows")).toBe(true);
    expect(wantsOpen({ metaKey: true, ctrlKey: false }, "other")).toBe(false);
  });
});

describe("paste rules", () => {
  it("asks for line breaks and control characters, not for one plain line", () => {
    expect(pasteNeedsConfirm("ls -la")).toBe(false);
    expect(pasteNeedsConfirm("tab\tseparated")).toBe(false);
    expect(pasteNeedsConfirm("ls\n")).toBe(true);
    expect(pasteNeedsConfirm("a\rb")).toBe(true);
    expect(pasteNeedsConfirm("evil\x1b[201~rm -rf ~")).toBe(true);
    expect(pasteNeedsConfirm("bell\x07")).toBe(true);
  });

  it("plain text drops control characters; one line joins lines", () => {
    expect(stripControlCharacters("a\x1b[31mb\x07\nc")).toBe("a[31mb\nc");
    expect(asOneLine("  git add .\n\n  git commit -m x \r\n")).toBe("git add . git commit -m x");
  });

  it("previews the first lines with visible control characters and counts the rest", () => {
    expect(previewLines("a\x1bb\nc\n", 6)).toEqual({ lines: ["a␛b", "c"], more: 0 });
    expect(previewLines("1\n2\n3\n4", 2)).toEqual({ lines: ["1", "2"], more: 2 });
    expect(lineCount("1\n2\n")).toBe(2);
    expect(lineCount("1\n2")).toBe(2);
  });

  it("trims trailing whitespace per line on copy", () => {
    expect(trimTrailingWhitespace("a   \nb\t\n\n")).toBe("a\nb");
  });
});

describe("quoting dropped paths", () => {
  it("POSIX: plain when safe, single quotes otherwise", () => {
    expect(quotePosix("/tmp/a.txt")).toBe("/tmp/a.txt");
    expect(quotePosix("/tmp/my file.txt")).toBe("'/tmp/my file.txt'");
    expect(quotePosix("/tmp/it's.txt")).toBe("'/tmp/it'\\''s.txt'");
    expect(quotePosix("$(rm -rf ~)")).toBe("'$(rm -rf ~)'");
    expect(quotePosix("")).toBe("''");
  });

  it("PowerShell: single quotes with the quote doubled", () => {
    expect(quotePowerShell("C:\\code\\a.txt")).toBe("C:\\code\\a.txt");
    expect(quotePowerShell("C:\\my files\\it's.txt")).toBe("'C:\\my files\\it''s.txt'");
    expect(quotePowerShell("$env:PATH")).toBe("'$env:PATH'");
  });

  it("joins several paths with spaces and a trailing space, per platform", () => {
    expect(quotePaths(["/a b", "/c"], "mac")).toBe("'/a b' /c ");
    expect(quotePaths(["C:\\a b"], "windows")).toBe("'C:\\a b' ");
    expect(quotePaths([], "other")).toBe("");
  });
});
