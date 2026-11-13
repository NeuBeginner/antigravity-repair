/**
 * Robust Protobuf Text Format (.pbtxt) Tokenizer & Parser.
 * Correctly parses single-line and multi-line fields, with/without colons,
 * escaped strings, nested messages, booleans, and numbers.
 */

class PbtxtParseError extends Error {
  constructor(message, line, col) {
    super(`${message} at line ${line}, col ${col}`);
    this.name = "PbtxtParseError";
    this.line = line;
    this.col = col;
  }
}

function tokenize(input) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;

  while (i < input.length) {
    const ch = input[i];

    // Newline tracking
    if (ch === "\n") {
      i++;
      line++;
      col = 1;
      continue;
    }

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\r") {
      i++;
      col++;
      continue;
    }

    // Comments
    if (ch === "#") {
      while (i < input.length && input[i] !== "\n") {
        i++;
      }
      continue;
    }

    // Symbols
    if (ch === "{" || ch === "}" || ch === ":" || ch === "<" || ch === ">" || ch === "," || ch === ";") {
      tokens.push({ type: ch, line, col, value: ch });
      i++;
      col++;
      continue;
    }

    // Strings
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const startLine = line;
      const startCol = col;
      i++;
      col++;
      const byteArray = [];
      let closed = false;

      while (i < input.length) {
        const c = input[i];
        if (c === "\n") {
          line++;
          col = 1;
        } else {
          col++;
        }
        i++;

        if (c === "\\") {
          if (i >= input.length) break;
          const escLine = line;
          const escCol = col;
          const nextC = input[i++];
          col++;
          if (nextC === "n") byteArray.push(0x0a);
          else if (nextC === "r") byteArray.push(0x0d);
          else if (nextC === "t") byteArray.push(0x09);
          else if (nextC === "v") byteArray.push(0x0b);
          else if (nextC === "f") byteArray.push(0x0c);
          else if (nextC === "a") byteArray.push(0x07);
          else if (nextC === "b") byteArray.push(0x08);
          else if (nextC === "?") byteArray.push(0x3f);
          else if (nextC === '"') byteArray.push(0x22);
          else if (nextC === "'") byteArray.push(0x27);
          else if (nextC === "\\") byteArray.push(0x5c);
          else if (nextC >= "0" && nextC <= "7") {
            let octalStr = nextC;
            for (let k = 0; k < 2 && i < input.length; k++) {
              const d = input[i];
              if (d >= "0" && d <= "7") {
                octalStr += d;
                i++;
                col++;
              } else {
                break;
              }
            }
            byteArray.push(parseInt(octalStr, 8) & 0xff);
          } else if (nextC === "x") {
            let hexStr = "";
            for (let k = 0; k < 2 && i < input.length; k++) {
              const d = input[i];
              if (/[0-9a-fA-F]/.test(d)) {
                hexStr += d;
                i++;
                col++;
              } else {
                break;
              }
            }
            if (hexStr.length === 0) {
              throw new PbtxtParseError("Invalid hex escape sequence \\x", escLine, escCol);
            }
            byteArray.push(parseInt(hexStr, 16) & 0xff);
          } else if (nextC === "u" || nextC === "U") {
            const needed = nextC === "u" ? 4 : 8;
            let hexStr = "";
            for (let k = 0; k < needed && i < input.length; k++) {
              const d = input[i];
              if (/[0-9a-fA-F]/.test(d)) {
                hexStr += d;
                i++;
                col++;
              } else {
                break;
              }
            }
            if (hexStr.length !== needed) {
              throw new PbtxtParseError(`Invalid unicode escape sequence \\${nextC}`, escLine, escCol);
            }
            const cp = parseInt(hexStr, 16);
            if (cp > 0x10ffff) {
              throw new PbtxtParseError(`Unicode code point out of range: \\${nextC}${hexStr}`, escLine, escCol);
            }
            byteArray.push(...Buffer.from(String.fromCodePoint(cp), "utf8"));
          } else {
            throw new PbtxtParseError(`Invalid escape sequence \\${nextC}`, escLine, escCol);
          }
        } else if (c === quote) {
          closed = true;
          break;
        } else {
          byteArray.push(...Buffer.from(c, "utf8"));
        }
      }

      if (!closed) {
        throw new PbtxtParseError("Unterminated string literal", startLine, startCol);
      }

      const strVal = Buffer.from(byteArray).toString("utf8");
      tokens.push({ type: "STRING", line: startLine, col: startCol, value: strVal });
      continue;
    }

    // Numbers / Identifiers
    const startLine = line;
    const startCol = col;
    let word = "";
    while (
      i < input.length &&
      !/[\s\{\}\:\<\>\,\;\#\"\'\n\r]/.test(input[i])
    ) {
      word += input[i];
      i++;
      col++;
    }

    if (word.length > 0) {
      if (/^-?\d+$/.test(word)) {
        tokens.push({ type: "INT", line: startLine, col: startCol, value: parseInt(word, 10) });
      } else if (word === "true" || word === "false") {
        tokens.push({ type: "BOOL", line: startLine, col: startCol, value: word === "true" });
      } else {
        tokens.push({ type: "IDENT", line: startLine, col: startCol, value: word });
      }
    }
  }

  return tokens;
}

function parsePbtxt(input) {
  if (typeof input !== "string") {
    throw new TypeError("Expected string input");
  }
  const tokens = tokenize(input);
  let pos = 0;

  function peek() {
    return tokens[pos] || null;
  }

  function next() {
    return tokens[pos++] || null;
  }

  function expect(type) {
    const tok = next();
    if (!tok || tok.type !== type) {
      const line = tok ? tok.line : (tokens[tokens.length - 1]?.line || 1);
      const col = tok ? tok.col : (tokens[tokens.length - 1]?.col || 1);
      throw new PbtxtParseError(
        `Expected token '${type}' but got '${tok ? tok.type : "EOF"}'`,
        line,
        col
      );
    }
    return tok;
  }

  function parseMessage(endChar = null) {
    const obj = {};

    while (pos < tokens.length) {
      const tok = peek();
      if (!tok) break;
      if (endChar && tok.type === endChar) {
        next();
        return obj;
      }
      if (endChar && (tok.type === "}" || tok.type === ">")) {
        throw new PbtxtParseError(
          `Mismatched closing bracket: expected '${endChar}' but got '${tok.type}'`,
          tok.line,
          tok.col
        );
      }

      if (tok.type === ";" || tok.type === ",") {
        next();
        continue;
      }

      if (tok.type !== "IDENT") {
        throw new PbtxtParseError(`Expected field name identifier, got '${tok.type}'`, tok.line, tok.col);
      }

      const keyTok = next();
      const key = keyTok.value;

      // Optional colon
      if (peek() && peek().type === ":") {
        next();
      }

      const valTok = peek();
      if (!valTok) {
        throw new PbtxtParseError(`Unexpected EOF after field '${key}'`, keyTok.line, keyTok.col);
      }

      let val;
      if (valTok.type === "{" || valTok.type === "<") {
        const startBracket = next().type;
        const closeBracket = startBracket === "{" ? "}" : ">";
        val = parseMessage(closeBracket);
      } else if (valTok.type === "STRING") {
        val = next().value;
        while (peek() && peek().type === "STRING") {
          val += next().value;
        }
      } else if (valTok.type === "INT" || valTok.type === "BOOL" || valTok.type === "IDENT") {
        val = next().value;
      } else {
        throw new PbtxtParseError(`Unexpected value token '${valTok.type}' for field '${key}'`, valTok.line, valTok.col);
      }

      // Handle repeated fields
      if (key in obj) {
        if (!Array.isArray(obj[key])) {
          obj[key] = [obj[key]];
        }
        obj[key].push(val);
      } else {
        obj[key] = val;
      }
    }

    if (endChar) {
      throw new PbtxtParseError(`Missing closing '${endChar}' for message`, tokens[tokens.length - 1]?.line || 1, 1);
    }

    return obj;
  }

  return parseMessage();
}

/**
 * Validate and extract ConversationAnnotations fields from parsed pbtxt AST.
 */
function extractTimestamp(val, fieldName) {
  if (!val || typeof val !== "object" || Array.isArray(val)) {
    throw new PbtxtParseError(`Invalid or ambiguous '${fieldName}' field in pbtxt`, 1, 1);
  }
  const sec = val.seconds;
  const nano = val.nanos;
  if (!Number.isInteger(sec)) {
    throw new PbtxtParseError(`Invalid or missing 'seconds' in '${fieldName}'`, 1, 1);
  }
  if (nano !== undefined && !Number.isInteger(nano)) {
    throw new PbtxtParseError(`Invalid 'nanos' in '${fieldName}'`, 1, 1);
  }
  return {
    seconds: sec,
    nanos: nano !== undefined ? nano : 0,
  };
}

function extractAnnotations(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid pbtxt content: expected object");
  }

  if (parsed.title !== undefined && typeof parsed.title !== "string") {
    throw new PbtxtParseError("Invalid or ambiguous 'title' field in pbtxt", 1, 1);
  }
  if (parsed.archived !== undefined && typeof parsed.archived !== "boolean") {
    throw new PbtxtParseError("Invalid or ambiguous 'archived' field in pbtxt", 1, 1);
  }
  if (parsed.marked_as_unread !== undefined && typeof parsed.marked_as_unread !== "boolean") {
    throw new PbtxtParseError("Invalid or ambiguous 'marked_as_unread' field in pbtxt", 1, 1);
  }

  const res = {
    title: parsed.title,
    archived: parsed.archived,
    marked_as_unread: parsed.marked_as_unread,
    last_user_view_time: undefined,
    archival_status_timestamp: undefined,
  };

  if (parsed.last_user_view_time !== undefined) {
    res.last_user_view_time = extractTimestamp(parsed.last_user_view_time, "last_user_view_time");
  }

  if (parsed.archival_status_timestamp !== undefined) {
    res.archival_status_timestamp = extractTimestamp(parsed.archival_status_timestamp, "archival_status_timestamp");
  }

  return res;
}

module.exports = {
  PbtxtParseError,
  tokenize,
  parsePbtxt,
  extractAnnotations,
};
