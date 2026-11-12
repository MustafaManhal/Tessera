export interface PtyPaneDiagnostics {
  bytesReceived: number;
  framesDecoded: number;
  decodeErrors: number;
  writeCallbacks: number;
  lastDecodeError: string | null;
  sessionId: string | null;
}

interface PtyDiagnostics {
  panes: Record<string, PtyPaneDiagnostics>;
}

declare global {
  interface Window {
    __tessera_diag?: PtyDiagnostics;
  }
}

const EVENT = "tessera:pty-diagnostics";
const EMPTY: PtyPaneDiagnostics = {
  bytesReceived: 0,
  framesDecoded: 0,
  decodeErrors: 0,
  writeCallbacks: 0,
  lastDecodeError: null,
  sessionId: null,
};

export function ptyDiagnosticsEnabled(): boolean {
  return new URLSearchParams(window.location.search).has("debug");
}

export function readPtyDiagnostics(paneId: string): PtyPaneDiagnostics {
  return window.__tessera_diag?.panes[paneId] ?? { ...EMPTY };
}

export function updatePtyDiagnostics(
  paneId: string,
  update: Partial<PtyPaneDiagnostics> | ((current: PtyPaneDiagnostics) => Partial<PtyPaneDiagnostics>),
): void {
  if (!ptyDiagnosticsEnabled()) return;

  let diagnostics = window.__tessera_diag;
  if (!diagnostics) {
    diagnostics = { panes: {} };
    window.__tessera_diag = diagnostics;
  }
  const current = diagnostics.panes[paneId] ?? { ...EMPTY };
  const changes = typeof update === "function" ? update(current) : update;
  const next = { ...current, ...changes };
  diagnostics.panes[paneId] = next;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { paneId, diagnostics: next } }));
  console.debug("[tessera:pty]", paneId, next);
}

export function subscribePtyDiagnostics(
  listener: (paneId: string, diagnostics: PtyPaneDiagnostics) => void,
): () => void {
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<{ paneId: string; diagnostics: PtyPaneDiagnostics }>).detail;
    if (detail) listener(detail.paneId, detail.diagnostics);
  };
  window.addEventListener(EVENT, handle);
  return () => window.removeEventListener(EVENT, handle);
}
