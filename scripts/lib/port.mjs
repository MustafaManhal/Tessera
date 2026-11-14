// Pure dev-port parsing, extracted from scripts/dev.mjs so it can be unit-tested. No side effects.

export const DEFAULT_DEV_PORT = 1420;

/**
 * Parse a TCP port from a raw environment value.
 * @param {string | undefined | null} input
 * @returns {number | undefined} the port, or undefined when the value is missing or not a port (1-65535)
 */
export function parseDevPort(input) {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  if (value < 1 || value > 65535) return undefined;
  return value;
}

/**
 * The dev port for this checkout: the parsed value, or the default when unset.
 * @param {string | undefined | null} input
 * @returns {number}
 * @throws {Error} when the value is set but is not a valid port
 */
export function resolveDevPort(input) {
  if (input === undefined || input === null || input.trim() === "") return DEFAULT_DEV_PORT;
  const port = parseDevPort(input);
  if (port === undefined) {
    throw new Error(`TESSERA_DEV_PORT must be a port number from 1 to 65535, got ${JSON.stringify(input)}`);
  }
  return port;
}
