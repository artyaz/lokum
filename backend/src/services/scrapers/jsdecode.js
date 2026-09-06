// Decode a JS string literal's inner content (the bytes between the surrounding
// double quotes) into the actual string value.
//
// JS string escapes: \' \" \\ \/ \b \f \n \r \t \uXXXX \xXX (and some non-standard
// like \< \> \' outside JSON). We convert all of these to their actual characters.
//
// Equivalent to Python's codecs.decode(s, 'unicode_escape') but UTF-8 aware.

/**
 * @param {string} s - The inner content of a JS string literal (without surrounding quotes).
 * @returns {string} The decoded string.
 */
export function codecsDecodeJsString(s) {
  // The fastest robust approach: build a new JS string that's a valid JSON
  // string, then JSON.parse it.
  //
  // Strategy:
  // - For each char:
  //   - If it's a backslash:
  //     - Look at next char.
  //     - If next is one of: " \ / b f n r t  -> keep both (valid JSON escape)
  //     - If next is 'u' followed by 4 hex digits -> keep both (valid JSON escape)
  //     - If next is 'x' followed by 2 hex digits -> convert to \u00XX
  //     - Otherwise -> drop the backslash, emit the next char literally
  //     - (Special: also need to escape any unescaped " inside the string, but
  //        by the time we got here the input is the inner content, so any " we
  //        see is from \\" which became \\" — wait, no, we receive raw inner
  //        content which still has \" for escaped quotes. So just preserve them.)
  //   - Otherwise emit the char (but if it's a literal " or \, escape it for JSON)
  //
  // Actually, the input is the *raw inner content* of the JS string. So:
  //   - `\"` in the input means an escaped quote → we want output `"` → for JSON, write `\"`
  //   - `\\` in the input means an escaped backslash → we want output `\` → for JSON, write `\\`
  //   - `\n` in the input means newline → we want output newline char → for JSON, write `\n`
  //   - `\<` in the input means literal `<` (non-standard JS escape) → we want output `<` → for JSON, write `<`
  //
  // Simplest: just walk and emit characters (decoding escapes), then re-escape
  // for JSON. But that's wasteful. Let's just emit a JSON-valid version directly.

  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      const nxt = s[i + 1];
      if (nxt === undefined) {
        // Trailing backslash — drop it
        continue;
      }
      if (nxt === '"' || nxt === '\\' || nxt === '/' ||
          nxt === 'b' || nxt === 'f' || nxt === 'n' || nxt === 'r' || nxt === 't') {
        // Valid JSON escape — keep both chars
        out += '\\' + nxt;
        i += 1;
      } else if (nxt === 'u') {
        const hex = s.slice(i + 2, i + 6);
        if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
          out += '\\u' + hex;
          i += 5;
        } else {
          // Invalid \u escape — emit 'u' literally
          out += 'u';
          i += 1;
        }
      } else if (nxt === 'x') {
        const hex = s.slice(i + 2, i + 4);
        if (hex.length === 2 && /^[0-9a-fA-F]{2}$/.test(hex)) {
          out += '\\u00' + hex;
          i += 3;
        } else {
          out += 'x';
          i += 1;
        }
      } else {
        // Non-standard escape like \' \< \> \. etc.
        // Emit the next char literally — and if it's a " or \, escape it for JSON.
        if (nxt === '"') out += '\\"';
        else if (nxt === '\\') out += '\\\\';
        else out += nxt;
        i += 1;
      }
    } else if (c === '"') {
      // Unescaped " in the input — shouldn't happen in well-formed input, but escape it.
      out += '\\"';
    } else if (c === '\\') {
      // Already handled above
      out += '\\\\';
    } else if (c === '\n') {
      out += '\\n';
    } else if (c === '\r') {
      out += '\\r';
    } else if (c === '\t') {
      out += '\\t';
    } else {
      out += c;
    }
  }
  out += '"';
  return JSON.parse(out);
}
