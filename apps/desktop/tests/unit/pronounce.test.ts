import { afterEach, describe, expect, it, vi } from "vitest";
import { canSpeak, pickVoice, pronounceName, type SpeechEngine } from "../../src/native/pronounce";

const voice = (lang: string, localService: boolean, name = lang) =>
  ({ lang, localService, name }) as SpeechSynthesisVoice;

class FakeUtterance {
  voice: unknown = null;
  lang = "";
  rate = 1;
  pitch = 0;
  constructor(readonly text: string) {}
}

afterEach(() => vi.unstubAllGlobals());

describe("pickVoice", () => {
  it("prefers a local en-US voice, then any English voice", () => {
    const voices = [
      voice("fr-FR", true),
      voice("en-GB", true, "uk"),
      voice("en-US", false, "net"),
      voice("en-US", true, "local"),
    ];
    expect(pickVoice(voices)?.name).toBe("local");
    expect(pickVoice([voice("fr-FR", true), voice("en-GB", true, "uk")])?.name).toBe("uk");
  });

  it("prefers neural and premium voices over compact ones, and never a novelty voice", () => {
    const voices = [
      voice("en-US", true, "Albert"),
      voice("en-US", true, "Fred"),
      voice("en-US", true, "Alex"),
      voice("en-US", true, "Ava (Premium)"),
      voice("en-US", false, "Microsoft Aria Online (Natural)"),
    ];
    expect(pickVoice(voices)?.name).toBe("Microsoft Aria Online (Natural)");
    expect(pickVoice(voices.slice(0, 4))?.name).toBe("Ava (Premium)");
    expect(pickVoice([voice("en-US", true, "Albert"), voice("en-US", true, "Alex")])?.name).toBe("Alex");
  });

  it("returns nothing when there is no English voice", () => {
    expect(pickVoice([voice("de-DE", true)])).toBeUndefined();
    expect(pickVoice([])).toBeUndefined();
  });
});

describe("pronounceName", () => {
  it("cancels first, then speaks Tessera slowly with an English voice", () => {
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    const calls: string[] = [];
    let spoken: FakeUtterance | undefined;
    const engine: SpeechEngine = {
      cancel: () => calls.push("cancel"),
      getVoices: () => [voice("en-US", true, "local")],
      speak: (utterance) => {
        calls.push("speak");
        spoken = utterance as unknown as FakeUtterance;
      },
    };
    expect(pronounceName(engine)).toBe(true);
    expect(calls).toEqual(["cancel", "speak"]);
    expect(spoken?.text).toBe("Tessera");
    expect(spoken?.lang).toBe("en-US");
    expect(spoken?.rate).toBe(0.9);
    expect((spoken?.voice as SpeechSynthesisVoice | undefined)?.name).toBe("local");
  });

  it("returns false when there is no engine or no utterance class (negative case)", () => {
    expect(pronounceName(undefined)).toBe(false);
    vi.stubGlobal("SpeechSynthesisUtterance", undefined);
    const engine: SpeechEngine = { cancel: () => {}, getVoices: () => [], speak: () => {} };
    expect(canSpeak(engine)).toBe(false);
    expect(pronounceName(engine)).toBe(false);
  });
});

describe("playRecording", () => {
  it("plays the recording and reports success", async () => {
    const { playRecording } = await import("../../src/native/pronounce");
    const srcs: string[] = [];
    const ok = await playRecording((src) => {
      srcs.push(src);
      return { play: () => Promise.resolve() };
    });
    expect(ok).toBe(true);
    expect(srcs[0]).toContain("tessera");
  });

  it("reports failure when playing is blocked (negative case)", async () => {
    const { playRecording } = await import("../../src/native/pronounce");
    expect(await playRecording(() => ({ play: () => Promise.reject(new Error("blocked")) }))).toBe(false);
    expect(
      await playRecording(() => {
        throw new Error("no audio");
      }),
    ).toBe(false);
  });
});
