// Says the product name out loud, for people who do not know how to pronounce it. Plays a bundled recording of a
// neural human voice (src/assets/audio/tessera.mp3, made with Microsoft Edge neural voice en-US-AvaNeural). If the
// recording cannot play, falls back to the system speech voice (Web Speech API).
// "Tessera" is /ˈtɛsərə/, "TESS-er-uh": Latin for one small tile of a mosaic.

import recordingUrl from "../assets/audio/tessera.mp3?url";

/** Minimal audio element, injectable for tests. */
export interface AudioLike {
  play(): Promise<void>;
}

let current: HTMLAudioElement | undefined;

/**
 * Plays the bundled human recording. Resolves false when it cannot play (no audio support, blocked, load error), so
 * the caller can fall back to {@link pronounceName}. A second click restarts it instead of stacking.
 */
export async function playRecording(create: (src: string) => AudioLike = (src) => new Audio(src)): Promise<boolean> {
  try {
    if (current) {
      current.pause();
      current.currentTime = 0;
    }
    const audio = create(recordingUrl);
    current = typeof HTMLAudioElement !== "undefined" && audio instanceof HTMLAudioElement ? audio : undefined;
    await audio.play();
    return true;
  } catch {
    return false;
  }
}

/** The text sent to the speech voice. Kept as one constant so tests and the UI agree. */
export const PRONUNCIATION_TEXT = "Tessera";

/** The engine, injectable for tests. */
export interface SpeechEngine {
  speak(utterance: SpeechSynthesisUtterance): void;
  cancel(): void;
  getVoices(): SpeechSynthesisVoice[];
}

/** True when the platform can speak. */
export function canSpeak(engine: Pick<SpeechEngine, "speak"> | undefined = browserEngine()): boolean {
  return engine !== undefined && typeof SpeechSynthesisUtterance !== "undefined";
}

function browserEngine(): SpeechEngine | undefined {
  return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : undefined;
}

/** Voice names that sound robotic or are novelty voices (macOS ships these). Never picked while a real voice exists. */
const NOVELTY =
  /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|organ|pipe organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy|princess|agnes|bruce|vicki|victoria|espeak|compact)\b/i;

/** Marks of a neural or enhanced voice, which sound far more human than the default compact ones. */
const QUALITY: readonly [RegExp, number][] = [
  [/natural|neural|online/i, 50],
  [/premium/i, 45],
  [/enhanced/i, 35],
  [/siri/i, 30],
  [/\b(ava|samantha|allison|serena|zoe|evan|nathan|tom|jenny|aria|guy|karen|daniel|moira|tessa)\b/i, 20],
  [/google/i, 10],
];

function scoreVoice(voice: SpeechSynthesisVoice): number {
  const lang = voice.lang.toLowerCase().replace("_", "-");
  let score = lang === "en-us" ? 10 : lang.startsWith("en-") ? 6 : 0;
  if (voice.localService) score += 2;
  for (const [pattern, points] of QUALITY) if (pattern.test(voice.name)) score += points;
  if (NOVELTY.test(voice.name)) score -= 100;
  return score;
}

/** Picks the most human English voice: neural or premium first, en-US before other English, novelty voices last. */
export function pickVoice(voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const english = voices.filter((voice) => voice.lang.toLowerCase().replace("_", "-").startsWith("en"));
  let best: SpeechSynthesisVoice | undefined;
  let bestScore = -Infinity;
  for (const voice of english) {
    const score = scoreVoice(voice);
    if (score > bestScore) {
      best = voice;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Speaks the name once, at a natural pace. Stops anything that is already being said first, so a double click does not stack.
 * Returns false when speech is not available (the caller shows the written respelling instead).
 */
export function pronounceName(engine: SpeechEngine | undefined = browserEngine()): boolean {
  if (!canSpeak(engine) || !engine) return false;
  engine.cancel();
  const utterance = new SpeechSynthesisUtterance(PRONUNCIATION_TEXT);
  utterance.lang = "en-US";
  utterance.rate = 0.9; // close to natural speech; slower sounds synthetic
  utterance.pitch = 1;
  const voice = pickVoice(engine.getVoices());
  if (voice) utterance.voice = voice;
  engine.speak(utterance);
  return true;
}
