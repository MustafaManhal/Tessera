// The `tessera` CLI install contract (M6.3), mirroring the Rust IPC types.
export interface CliInstall {
  installed: boolean;
  /** Where the binary lives once installed; null before. */
  path: string | null;
  /** The folder the installer targets (`~/.local/bin` on macOS/Linux, `%LOCALAPPDATA%\Programs\Tessera` on Windows). */
  target: string;
  /** The install needs administrator rights (Windows machine-wide fallback). */
  needs_admin: boolean;
  /** The target folder is already on PATH. */
  on_path: boolean;
}
