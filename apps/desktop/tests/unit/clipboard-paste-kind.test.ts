import { describe, expect, it } from "vitest";
import { pasteKind } from "../../src/terminal/clipboard";

describe("pasteKind", () => {
  it("pastes copied files as paths, even when the clipboard also has an image or a name", () => {
    // Finder puts the file, its name and its icon on the clipboard; Ctrl+V would hand the agent the icon.
    expect(pasteKind({ text: "shot.png", hasImage: true, files: ["/Users/me/shot.png"] })).toBe("files");
    expect(pasteKind({ text: "", hasImage: true, files: ["/Users/me/shot.png"] })).toBe("files");
  });
  it("sends Ctrl+V for a copied picture with no file, and text otherwise", () => {
    expect(pasteKind({ text: "", hasImage: true, files: [] })).toBe("image");
    expect(pasteKind({ text: "ls", hasImage: false, files: [] })).toBe("text");
    expect(pasteKind({ text: "", hasImage: false, files: [] })).toBe("text");
  });
});
