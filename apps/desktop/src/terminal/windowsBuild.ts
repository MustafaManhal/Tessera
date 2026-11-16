// The Windows build whose ConPTY runs our shells, for xterm's `windowsPty` option. ConPTY before build 21376 (every
// Windows 10) redraws wrapped lines itself on resize; when xterm re-wrapped them as well, lines doubled and the start
// of a session fell out of the scrollback. xterm only needs to know which side of 21376 we are on, and Chromium's
// client hints give just that: `platformVersion` is 13 or more on Windows 11 and below 13 on Windows 10.
import { getPlatform } from "@tessera/ui";

/** A Windows 10 build (22H2): older ConPTY, so xterm leaves reflow to it. */
export const WINDOWS_10_BUILD = 19045;
/** The first Windows 11 build: newer ConPTY, so xterm reflows as usual. */
export const WINDOWS_11_BUILD = 22000;

interface UserAgentData {
  getHighEntropyValues(hints: string[]): Promise<{ platformVersion?: string }>;
}

/** The build for a client-hints `platformVersion` ("10.0.0" on Windows 10, "15.0.0" on Windows 11). */
export function windowsBuildFor(platformVersion: string | undefined): number {
  const major = Number.parseInt(platformVersion?.split(".")[0] ?? "", 10);
  return Number.isFinite(major) && major >= 13 ? WINDOWS_11_BUILD : WINDOWS_10_BUILD;
}

// Until the hints answer, assume Windows 10: leaving reflow to ConPTY is the safe side on both.
let known = getPlatform() === "windows" ? WINDOWS_10_BUILD : 0;
let asked: Promise<number> | null = null;

/** The build to use now (0 when not on Windows). */
export function windowsBuild(): number {
  return known;
}

/** Asks the WebView once which Windows this is. Resolves to 0 when not on Windows. */
export function detectWindowsBuild(): Promise<number> {
  if (known === 0) return Promise.resolve(0);
  asked ??= (async () => {
    const data = (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData;
    try {
      if (data) known = windowsBuildFor((await data.getHighEntropyValues(["platformVersion"])).platformVersion);
    } catch {
      // Keep the Windows 10 assumption.
    }
    return known;
  })();
  return asked;
}
