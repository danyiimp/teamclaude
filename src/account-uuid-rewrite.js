// Rewrite the request body's account_uuid to match the account whose token we
// inject. Claude Code puts the logged-in account's UUID inside `metadata.user_id`
// (a stringified JSON) of /v1/messages; under rotation that would disagree with
// the injected token.
//
// This is a STREAMING, byte-exact JSON state machine — no regex, no whole-body
// buffering — so it handles arbitrarily large bodies fed in chunks. It tracks
// JSON structure (container stack, current key, in-string/escape) to find the
// `metadata.user_id` string value, and only inside that value does it look for
// the `account_uuid` field and overwrite its 36-char value with the new UUID
// (same length → no content-length/flow-control changes). A stray `account_uuid`
// elsewhere in the body (user content, tool results) is never touched.
//
// The same machine patches `device_id`, the other identity field in there: the
// 64-hex id of the Claude Code install that sent the request. It is only
// rewritten when the operator configured one for the serving account
// (`accounts[].deviceId`), for a setup that runs each account under its own
// Claude Code profile and resumes one conversation under another's.

import { rootKeyOffset, ROOT_OPEN } from './json-root-key.js';

// Byte sequence of `<field>":"` as it appears INSIDE the (escaped) user_id
// string: field \ " : \ "
/** @param {string} field */
const escapedKey = (field) => Buffer.from(`${field}\\":\\"`, 'latin1');

export class UserIdFieldPatcher {
  /**
   * @param {string} field  key inside metadata.user_id
   * @param {unknown} newValue  replacement of exactly `length` characters; anything else disables the patcher
   * @param {number} length
   */
  constructor(field, newValue, length) {
    this.prefix = escapedKey(field);
    // KMP fallback table: `device_id` repeats its first byte, so a failed
    // partial match may already hold the start of the real one.
    this.fallback = new Uint8Array(this.prefix.length);
    for (let i = 1, k = 0; i < this.prefix.length; i++) {
      while (k > 0 && this.prefix[i] !== this.prefix[k]) k = this.fallback[k - 1];
      if (this.prefix[i] === this.prefix[k]) k++;
      this.fallback[i] = k;
    }
    this.newValue = (typeof newValue === 'string' && newValue.length === length) ? Buffer.from(newValue, 'latin1') : null;
    /** @type {Array<{ container: 'obj'|'arr', name: string|null, key: string|null, awaitingKey: boolean }>} */
    this.frames = [];          // container stack
    this.inStr = false;
    this.esc = false;
    this.readingKey = false;
    /** @type {number[]} */
    this.keyBuf = [];
    this.target = false;       // inside the metadata.user_id string value
    this.matchPos = 0;         // prefix match progress (within target)
    this.valueRemaining = 0;   // value bytes left to overwrite
    this.done = false;         // patched the one field already
    this.changed = false;
  }

  /**
   * Feed a chunk; returns a same-length chunk (patched in place).
   *
   * @param {Buffer|Uint8Array} chunk
   */
  push(chunk) {
    if (!this.newValue || this.done) return chunk;
    const out = Buffer.from(chunk);
    for (let i = 0; i < out.length; i++) {
      out[i] = this.#byte(out[i]);
      if (this.done) break; // rest passes through unchanged
    }
    return out;
  }

  #top() { return this.frames[this.frames.length - 1]; }

  /**
   * @param {number} b
   */
  #byte(b) {
    if (this.target) return this.#targetByte(b);

    if (this.inStr) {
      if (this.esc) { this.esc = false; if (this.readingKey) this.keyBuf.push(b); return b; }
      if (b === 0x5c) { this.esc = true; return b; }             // backslash
      if (b === 0x22) {                                          // end of string
        this.inStr = false;
        if (this.readingKey) { this.#top().key = Buffer.from(this.keyBuf).toString('latin1'); this.keyBuf = []; this.readingKey = false; }
        return b;
      }
      if (this.readingKey) this.keyBuf.push(b);
      return b;
    }

    const top = this.#top();
    switch (b) {
      case 0x7b: this.frames.push({ container: 'obj', name: top ? top.key : null, key: null, awaitingKey: true }); break; // {
      case 0x5b: this.frames.push({ container: 'arr', name: top ? top.key : null, key: null, awaitingKey: false }); break; // [
      case 0x7d: case 0x5d: this.frames.pop(); break;            // } ]
      case 0x3a: if (top) top.awaitingKey = false; break;        // : (key → value)
      case 0x2c: if (top && top.container === 'obj') top.awaitingKey = true; break; // ,
      case 0x22:                                                 // string start
        if (top && top.container === 'obj' && top.awaitingKey) {
          this.readingKey = true; this.keyBuf = []; this.inStr = true; this.esc = false;
        } else {
          this.inStr = true; this.esc = false; this.readingKey = false;
          if (top && top.container === 'obj' && top.name === 'metadata' && top.key === 'user_id' && this.frames.length === 2) {
            this.target = true; this.matchPos = 0; this.valueRemaining = 0;
          }
        }
        break;
      default: break; // scalars / whitespace
    }
    return b;
  }

  // Inside the metadata.user_id string value: stream-match the field's key
  // and overwrite its value. Detect the (unescaped) closing quote to exit.
  /**
   * @param {number} b
   */
  #targetByte(b) {
    if (this.valueRemaining > 0) {
      // `push` returns before any byte reaches here while `newValue` is null.
      const value = /** @type {Buffer} */ (this.newValue);
      const outByte = value[value.length - this.valueRemaining];
      this.valueRemaining--;
      if (outByte !== b) this.changed = true;
      if (this.valueRemaining === 0) this.done = true; // only one occurrence per body
      return outByte;
    }
    if (this.esc) { this.esc = false; this.#match(b); return b; }
    if (b === 0x5c) { this.esc = true; this.#match(b); return b; }
    if (b === 0x22) { this.target = false; this.matchPos = 0; return b; } // end of user_id value
    this.#match(b);
    return b;
  }

  /**
   * @param {number} b
   */
  #match(b) {
    const prefix = this.prefix;
    let m = this.matchPos;
    while (m > 0 && b !== prefix[m]) m = this.fallback[m - 1];
    if (b === prefix[m]) m++;
    if (m === prefix.length) { this.valueRemaining = /** @type {Buffer} */ (this.newValue).length; m = 0; }
    this.matchPos = m;
  }
}

export class AccountUuidPatcher extends UserIdFieldPatcher {
  /**
   * @param {unknown} newUuid  a 36-character account uuid; anything else disables the patcher
   */
  constructor(newUuid) {
    super('account_uuid', newUuid, 36);
  }
}

/**
 * The device id Claude Code sends is the 64-hex `userID` of its own install.
 */
export class DeviceIdPatcher extends UserIdFieldPatcher {
  /**
   * @param {unknown} newDeviceId  64 lowercase hex characters; anything else disables the patcher
   */
  constructor(newDeviceId) {
    super('device_id', typeof newDeviceId === 'string' && /^[0-9a-f]{64}$/.test(newDeviceId) ? newDeviceId : null, 64);
  }
}

/**
 * One-shot convenience (whole-buffer); returns the same instance if unchanged.
 *
 * @param {Buffer} buf
 * @param {unknown} newUuid
 */
export function patchAccountUuid(buf, newUuid) {
  return patchWith(new AccountUuidPatcher(newUuid), buf);
}

/**
 * Same as patchAccountUuid, for `device_id`.
 *
 * @param {Buffer} buf
 * @param {unknown} newDeviceId
 */
export function patchDeviceId(buf, newDeviceId) {
  return patchWith(new DeviceIdPatcher(newDeviceId), buf);
}

/**
 * @param {UserIdFieldPatcher} p
 * @param {Buffer} buf
 */
function patchWith(p, buf) {
  // Only the root `metadata` can hold the field, and Claude Code sends it near
  // the end: patch from there and keep the head as it is (see json-root-key.js).
  const at = rootKeyOffset(buf, 'metadata');
  if (at === -1) return buf;
  if (at !== null) {
    p.push(ROOT_OPEN);
    const tail = p.push(buf.subarray(at));
    return p.changed ? Buffer.concat([buf.subarray(0, at), tail]) : buf;
  }
  const out = p.push(buf);
  return p.changed ? out : buf;
}
