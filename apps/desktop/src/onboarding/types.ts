// First-run onboarding and settings importers (M12.1, FR-66/FR-69). Mirrors import_commands.rs.

export interface ImportSource {
  /** ghostty | iterm2 | windowsterminal */
  id: string;
  name: string;
  path: string | null;
  available: boolean;
}

export type ImportValue = string | number;

export interface ImportItem {
  key: string;
  value: ImportValue;
  label: string;
}

export interface ImportMiss {
  item: string;
  reason: string;
}

export interface ImportPreview {
  applied: ImportItem[];
  failed: ImportMiss[];
}

export interface OnboardingState {
  done: boolean;
}
