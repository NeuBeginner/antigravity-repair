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
      let strVal = "";
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
          const nextC = input[i++];
          col++;
          if (nextC === "n") strVal += "\n";
          else if (nextC === "r") strVal += "\r";
          else if (nextC === "t") strVal += "\t";
          else if (nextC === '"') strVal += '"';
          else if (nextC === "'") strVal += "'";
          else if (nextC === "\\") strVal += "\\";
          else strVal += nextC;
        } else if (c === quote) {
          closed = true;
          break;
        } else {
          strVal += c;
        }
      }

      if (!closed) {
        throw new PbtxtParseError("Unterminated string literal", startLine, startCol);
      }

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
      if (endChar && (tok.type === endChar || (endChar === "}" && tok.type === ">"))) {
        next();
        return obj;
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
      } else if (valTok.type === "STRING" || valTok.type === "INT" || valTok.type === "BOOL" || valTok.type === "IDENT") {
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
function extractAnnotations(parsed) {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid pbtxt content: expected object");
  }

  const res = {
    title: typeof parsed.title === "string" ? parsed.title : undefined,
    archived: typeof parsed.archived === "boolean" ? parsed.archived : undefined,
    marked_as_unread: typeof parsed.marked_as_unread === "boolean" ? parsed.marked_as_unread : undefined,
    last_user_view_time: undefined,
    archival_status_timestamp: undefined,
  };

  if (parsed.last_user_view_time && typeof parsed.last_user_view_time === "object") {
    const sec = parsed.last_user_view_time.seconds;
    const nano = parsed.last_user_view_time.nanos;
    if (typeof sec === "number") {
      res.last_user_view_time = {
        seconds: sec,
        nanos: typeof nano === "number" ? nano : 0,
      };
    }
  }

  if (parsed.archival_status_timestamp && typeof parsed.archival_status_timestamp === "object") {
    const sec = parsed.archival_status_timestamp.seconds;
    const nano = parsed.archival_status_timestamp.nanos;
    if (typeof sec === "number") {
      res.archival_status_timestamp = {
        seconds: sec,
        nanos: typeof nano === "number" ? nano : 0,
      };
    }
  }

  return res;
}

module.exports = {
  PbtxtParseError,
  tokenize,
  parsePbtxt,
  extractAnnotations,
};
