/**
 * Robust low-level Protobuf binary parser & encoder.
 * Handles strict bounds checking, varint overflow protection,
 * wire types (0, 1, 2, 5), and round-trip preservation of unknown fields.
 */

class ProtobufError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtobufError";
  }
}

class ProtobufTruncatedError extends ProtobufError {
  constructor(message = "Protobuf buffer truncated") {
    super(message);
    this.name = "ProtobufTruncatedError";
  }
}

class ProtobufMalformedError extends ProtobufError {
  constructor(message = "Protobuf data malformed") {
    super(message);
    this.name = "ProtobufMalformedError";
  }
}

/**
 * Read unsigned varint (up to 64-bit) from buffer starting at offset i.
 * Returns { value: BigInt, nextOffset: number }
 */
function readVarint(buf, i = 0) {
  if (!Buffer.isBuffer(buf)) {
    throw new TypeError("Expected Buffer");
  }
  let res = 0n;
  let shift = 0n;
  let curr = i;

  while (true) {
    if (curr >= buf.length) {
      throw new ProtobufTruncatedError(`Unexpected EOF reading varint at offset ${curr}`);
    }
    const byte = BigInt(buf[curr++]);
    res |= (byte & 0x7fn) << shift;
    shift += 7n;
    if ((byte & 0x80n) === 0n) {
      break;
    }
    if (shift >= 70n) {
      throw new ProtobufMalformedError(`Varint exceeds 64-bit bounds at offset ${curr}`);
    }
  }

  return { value: res, nextOffset: curr };
}

/**
 * Encode a number or BigInt into a Protobuf varint Buffer.
 */
function encodeVarint(val) {
  let n = typeof val === "bigint" ? val : BigInt(Math.floor(val));
  if (n < 0n) {
    // Two's complement for negative numbers (64-bit)
    n = BigInt.asUintN(64, n);
  }
  const bytes = [];
  while (n > 127n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n & 0x7fn));
  return Buffer.from(bytes);
}

/**
 * Decode all top-level entries from a protobuf-encoded message buffer.
 * Throws ProtobufTruncatedError or ProtobufMalformedError if corrupted.
 */
function decodeEntries(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new TypeError("Expected Buffer");
  }
  const entries = [];
  let i = 0;

  while (i < buf.length) {
    const startTag = i;
    const { value: key, nextOffset: afterTag } = readVarint(buf, i);
    const fn = Number(key >> 3n);
    const wt = Number(key & 7n);
    i = afterTag;

    if (fn === 0) {
      throw new ProtobufMalformedError(`Invalid field number 0 at offset ${startTag}`);
    }

    let val = null;
    let valStart = i;

    if (wt === 0) {
      // Varint
      const { value: varintVal, nextOffset: afterVal } = readVarint(buf, i);
      val = varintVal;
      i = afterVal;
    } else if (wt === 1) {
      // 64-bit fixed
      if (i + 8 > buf.length) {
        throw new ProtobufTruncatedError(`Truncated 64-bit fixed field ${fn} at offset ${i}`);
      }
      val = buf.subarray(i, i + 8);
      i += 8;
    } else if (wt === 2) {
      // Length-delimited
      const { value: lenBig, nextOffset: afterLen } = readVarint(buf, i);
      const len = Number(lenBig);
      i = afterLen;
      if (len < 0 || i + len > buf.length) {
        throw new ProtobufTruncatedError(
          `Truncated length-delimited field ${fn} (len ${len}) at offset ${i}, buffer len ${buf.length}`
        );
      }
      val = buf.subarray(i, i + len);
      i += len;
    } else if (wt === 5) {
      // 32-bit fixed
      if (i + 4 > buf.length) {
        throw new ProtobufTruncatedError(`Truncated 32-bit fixed field ${fn} at offset ${i}`);
      }
      val = buf.subarray(i, i + 4);
      i += 4;
    } else {
      throw new ProtobufMalformedError(`Unsupported wire type ${wt} for field ${fn} at offset ${startTag}`);
    }

    const rawBytes = buf.subarray(startTag, i);
    entries.push({
      fn,
      wt,
      val,
      tagBytes: buf.subarray(startTag, valStart),
      rawBytes,
    });
  }

  return entries;
}

/**
 * Encode an array of entries back to a Buffer.
 * If an entry has rawBytes, it will be reused unless modified.
 */
function encodeEntries(entries) {
  const parts = [];
  for (const e of entries) {
    if (e.rawBytes) {
      parts.push(e.rawBytes);
      continue;
    }
    const key = (BigInt(e.fn) << 3n) | BigInt(e.wt);
    const tag = encodeVarint(key);
    parts.push(tag);
    if (e.wt === 0) {
      parts.push(encodeVarint(e.val));
    } else if (e.wt === 1 || e.wt === 5) {
      parts.push(e.val);
    } else if (e.wt === 2) {
      const len = encodeVarint(e.val.length);
      parts.push(len, e.val);
    } else {
      throw new ProtobufMalformedError(`Cannot encode wire type ${e.wt}`);
    }
  }
  return Buffer.concat(parts);
}

/**
 * Decode gRPC length-prefixed frames:
 * [1 byte flag] [4 bytes BE length] [payload]
 */
function decodeFrames(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new TypeError("Expected Buffer");
  }
  const frames = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 5 > buf.length) {
      throw new ProtobufTruncatedError(`Truncated gRPC frame header at offset ${i}`);
    }
    const flag = buf[i];
    const len = buf.readUInt32BE(i + 1);
    if (i + 5 + len > buf.length) {
      throw new ProtobufTruncatedError(
        `Truncated gRPC frame payload: needed ${len} bytes at ${i + 5}, available ${buf.length - (i + 5)}`
      );
    }
    const payload = buf.subarray(i + 5, i + 5 + len);
    frames.push({ flag, len, payload, rawFrame: buf.subarray(i, i + 5 + len) });
    i += 5 + len;
  }
  return frames;
}

/**
 * Encode a payload into a 5-byte length-prefixed gRPC frame.
 */
function encodeFrame(payload, flag = 0) {
  const buf = Buffer.alloc(5 + payload.length);
  buf[0] = flag;
  buf.writeUInt32BE(payload.length, 1);
  payload.copy(buf, 5);
  return buf;
}

module.exports = {
  ProtobufError,
  ProtobufTruncatedError,
  ProtobufMalformedError,
  readVarint,
  encodeVarint,
  decodeEntries,
  encodeEntries,
  decodeFrames,
  encodeFrame,
};
