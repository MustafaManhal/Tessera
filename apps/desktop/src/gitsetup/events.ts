/** Opens the git setup dialog and checks again (the palette action sends this). */
export const GIT_SETUP_EVENT = "tessera:git-setup";

/** Opens the git setup dialog only if git really is missing (an operation failed to start git). */
export const GIT_MISSING_EVENT = "tessera:git-missing";

export function announceGitMissing(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(GIT_MISSING_EVENT));
}
