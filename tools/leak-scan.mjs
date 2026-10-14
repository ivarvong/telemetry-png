// leak-scan.mjs — find known-sensitive values in text without the repository naming them.
// Values are listed as SHA-256 hashes. Text is split into tokens of [A-Za-z0-9._-];
// every run of up to 8 consecutive '.'/'-'/'_'-separated parts of a token is hashed,
// so a value is caught alone, quoted, inside a hostname or URL, or as a hyphenated UUID.
import crypto from 'node:crypto';

// Values from the capture that the sanitized fixture must never contain again.
export const LEAKED = new Set([
  '07cb8cd078684790a99de6f1b091ce2ffa03dcd3adbafef4679818e66d0ee6b1', // a Worker name
  'ed9e2416099fbb5696e97d2020f11bce4a946e6f8ce6ff35ff495c8459f70fd1', // an upstream host
  '686daa7b67b517dbca1e52f115f9f4826e407a6390056629b95de4cf20173112', // an object hash
  'bab2568536f061e5cc3a8531609162079944f7741a5b94ac2684049f7b338e69', // a version id
]);

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const MAX_PARTS = 8;

// -> the distinct hashes in `hashes` that occur in `text`.
export function findLeaks(text, hashes = LEAKED) {
  const found = new Set();
  for (const token of text.split(/[^A-Za-z0-9._-]+/)) {
    if (!token) continue;
    const parts = token.split(/(?<=[._-])|(?=[._-])/); // keep separators as their own parts
    for (let i = 0; i < parts.length; i++) {
      let s = '';
      for (let j = i; j < parts.length && j < i + 2 * MAX_PARTS; j++) {
        s += parts[j];
        const h = sha256(s);
        if (hashes.has(h)) found.add(h);
      }
    }
  }
  return [...found];
}
