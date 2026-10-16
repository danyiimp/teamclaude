// Where a key of a JSON body's ROOT object starts, found without walking the
// body a byte at a time.
//
// The request-body machines (model.js finders, account-uuid-rewrite.js) walk
// the JSON structure one byte at a time from the first byte, and each of them
// only cares about one root key: `stream`, `output_config`, `tools`,
// `metadata`. Claude Code puts those after `messages`, so on a long
// conversation — a body of several megabytes — every machine walked the whole
// transcript to reach a few hundred bytes at the end, on the one thread that
// serves every other request.
//
// A machine fed `{` and then the body from that key's opening quote ends in
// the same state as one fed the whole body: at the key, either one is inside
// the root object, outside any string, about to read a key, and has seen
// nothing it was looking for — its target lies under that key. So the caller
// can start there, provided the offset is proven to be a ROOT key:
//
//   - The quoted key text is found with a native search from the end. Inside a
//     JSON string a quote is always escaped, so `"key"` followed by `:` is a
//     key token wherever it occurs; it is not a match inside conversation text.
//   - The tail from that quote must close exactly one container and be
//     followed by nothing but whitespace. A key nested deeper closes its own
//     object first and then more, so it fails; the next match back is tried.
//
// Anything not proven (an invalid body, a key spelled with escapes, a key too
// far from the end to be worth the tries) returns null and the caller scans
// the whole body as before. A body that repeats a root key reads the last one
// here and the first one in a full scan; JSON.parse also keeps the last.

const MAX_TRIES = 8;

/** @param {number} b */
const isWhitespace = (b) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;

/**
 * Offset of the opening quote of root key `key`; -1 when `"key"` occurs
 * nowhere in `buf` (so a machine that compares raw key bytes cannot find that
 * key either); null when it occurs but could not be proven to be a root key.
 *
 * @param {Buffer} buf
 * @param {string} key  plain key text, as Claude Code writes it
 * @returns {number|null}
 */
export function rootKeyOffset(buf, key) {
  const needle = Buffer.from(`"${key}"`, 'utf8');
  let pos = buf.lastIndexOf(needle);
  if (pos < 0) return -1;
  for (let tries = 0; tries < MAX_TRIES && pos >= 0; tries++, pos = pos > 0 ? buf.lastIndexOf(needle, pos - 1) : -1) {
    let j = pos + needle.length;
    while (j < buf.length && isWhitespace(buf[j])) j++;
    if (buf[j] !== 0x3a) continue;                                 // a value, not a key
    let k = pos - 1;
    while (k >= 0 && isWhitespace(buf[k])) k--;
    if (buf[k] !== 0x7b && buf[k] !== 0x2c) continue;              // { or , precedes every key
    if (closesRoot(buf, pos)) return pos;
  }
  return null;
}

/**
 * Do the bytes from `from` close exactly one container, with only whitespace
 * after? Strings are skipped with a native search for their closing quote.
 *
 * @param {Buffer} buf
 * @param {number} from
 */
function closesRoot(buf, from) {
  let depth = 1;
  for (let i = from; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x22) {
      i = stringEnd(buf, i);
      if (i < 0) return false;
    } else if (b === 0x7b || b === 0x5b) {
      depth++;
    } else if ((b === 0x7d || b === 0x5d) && --depth === 0) {
      for (i++; i < buf.length; i++) if (!isWhitespace(buf[i])) return false;
      return true;
    }
  }
  return false;
}

/**
 * Index of the quote closing the string opened at `open`, or -1. A quote
 * preceded by an odd run of backslashes is escaped.
 *
 * @param {Buffer} buf
 * @param {number} open
 */
function stringEnd(buf, open) {
  let q = open;
  for (;;) {
    q = buf.indexOf(0x22, q + 1);
    if (q < 0) return -1;
    let run = 0;
    while (buf[q - 1 - run] === 0x5c) run++;
    if (run % 2 === 0) return q;
  }
}

// What a machine is fed before the tail, so it stands where it would after the
// root object's opening brace.
export const ROOT_OPEN = Buffer.from('{', 'latin1');
