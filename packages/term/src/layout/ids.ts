// ULID-like ids (https://github.com/ulid/spec): 10 characters of millisecond time and 16 of randomness in Crockford
// base32, so ids sort by creation time and never collide in practice. Inject `now` and `random` in tests, or use
// `sequentialIds` for readable ids.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;

export type IdGenerator = () => string;

export interface IdSource {
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** Fills the array with random bytes. */
  random?: (bytes: Uint8Array<ArrayBuffer>) => void;
}

function defaultRandom(bytes: Uint8Array<ArrayBuffer>): void {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
    return;
  }
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
}

/** Returns a generator of 26-character ULID-like ids. */
export function createIdGenerator({ now = Date.now, random = defaultRandom }: IdSource = {}): IdGenerator {
  return () => {
    let time = Math.max(0, Math.floor(now()));
    let timePart = "";
    for (let i = 0; i < TIME_LENGTH; i++) {
      timePart = ALPHABET[time % 32] + timePart;
      time = Math.floor(time / 32);
    }
    const bytes = new Uint8Array(RANDOM_LENGTH);
    random(bytes);
    let randomPart = "";
    for (const byte of bytes) randomPart += ALPHABET[byte % 32];
    return timePart + randomPart;
  };
}

/** Readable ids for tests: `p1`, `p2`, … with the given prefix. */
export function sequentialIds(prefix = "id"): IdGenerator {
  let n = 0;
  return () => `${prefix}${++n}`;
}

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
