const assert = require("assert");
const {
  readVarint,
  encodeVarint,
  decodeEntries,
  encodeEntries,
  decodeFrames,
  encodeFrame,
  ProtobufTruncatedError,
  ProtobufMalformedError,
} = require("../lib/protobuf");

function runProtobufTests() {
  console.log("--- Running Protobuf Tests ---");
  let passed = 0;

  function test(name, fn) {
    try {
      fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.error(`  ✗ ${name}`);
      throw err;
    }
  }

  test("varint encoding and decoding round-trip", () => {
    const testValues = [
      0n,
      1n,
      127n,
      128n,
      300n,
      16384n,
      2147483647n,
      4294967295n,
      9007199254740991n,
      0x7fffffffffffffffn,
    ];

    for (const val of testValues) {
      const enc = encodeVarint(val);
      const dec = readVarint(enc, 0);
      assert.strictEqual(dec.value, val);
      assert.strictEqual(dec.nextOffset, enc.length);
    }
  });

  test("negative varint encodes to 64-bit two's complement", () => {
    const enc = encodeVarint(-1);
    const dec = readVarint(enc, 0);
    assert.strictEqual(dec.value, 0xffffffffffffffffn);
  });

  test("truncated varint at EOF throws ProtobufTruncatedError", () => {
    // 0x80 means more bytes follow, but buffer terminates
    const truncatedBuf = Buffer.from([0x80]);
    assert.throws(
      () => readVarint(truncatedBuf, 0),
      (err) => err instanceof ProtobufTruncatedError && /Unexpected EOF/.test(err.message)
    );
  });

  test("varint exceeding 64-bit bounds throws ProtobufMalformedError", () => {
    // 11 bytes all with MSB set
    const overflowBuf = Buffer.from([
      0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01,
    ]);
    assert.throws(
      () => readVarint(overflowBuf, 0),
      (err) => err instanceof ProtobufMalformedError && /exceeds 64-bit/.test(err.message)
    );
  });

  test("10-byte varint with 10th byte > 0x01 throws ProtobufMalformedError", () => {
    const bad10thByte = Buffer.from([
      0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x02,
    ]);
    assert.throws(
      () => readVarint(bad10thByte, 0),
      (err) => err instanceof ProtobufMalformedError && /exceeds 64-bit/.test(err.message)
    );
  });

  test("decodeEntries handles wire types 0, 1, 2, 5 correctly", () => {
    // Field 1 (varint, wt=0): 150 -> tag = (1 << 3) | 0 = 0x08, val = 0x96, 0x01
    // Field 2 (fixed64, wt=1): 8 bytes 0x11..0x18 -> tag = (2 << 3) | 1 = 0x11
    // Field 3 (length-delimited, wt=2): "hello" (5 bytes) -> tag = (3 << 3) | 2 = 0x1a
    // Field 4 (fixed32, wt=5): 4 bytes 0x01,0x02,0x03,0x04 -> tag = (4 << 3) | 5 = 0x25
    const f1Tag = encodeVarint((1n << 3n) | 0n);
    const f1Val = encodeVarint(150n);

    const f2Tag = encodeVarint((2n << 3n) | 1n);
    const f2Val = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);

    const f3Tag = encodeVarint((3n << 3n) | 2n);
    const f3Bytes = Buffer.from("hello", "utf8");
    const f3Len = encodeVarint(f3Bytes.length);

    const f4Tag = encodeVarint((4n << 3n) | 5n);
    const f4Val = Buffer.from([10, 20, 30, 40]);

    const fullBuf = Buffer.concat([
      f1Tag,
      f1Val,
      f2Tag,
      f2Val,
      f3Tag,
      f3Len,
      f3Bytes,
      f4Tag,
      f4Val,
    ]);

    const entries = decodeEntries(fullBuf);
    assert.strictEqual(entries.length, 4);

    assert.strictEqual(entries[0].fn, 1);
    assert.strictEqual(entries[0].wt, 0);
    assert.strictEqual(entries[0].val, 150n);

    assert.strictEqual(entries[1].fn, 2);
    assert.strictEqual(entries[1].wt, 1);
    assert.deepStrictEqual(entries[1].val, f2Val);

    assert.strictEqual(entries[2].fn, 3);
    assert.strictEqual(entries[2].wt, 2);
    assert.strictEqual(entries[2].val.toString("utf8"), "hello");

    assert.strictEqual(entries[3].fn, 4);
    assert.strictEqual(entries[3].wt, 5);
    assert.deepStrictEqual(entries[3].val, f4Val);
  });

  test("truncated length-delimited field throws ProtobufTruncatedError", () => {
    // Field 1, wire type 2, length declared as 20 bytes, but only 5 supplied
    const tag = encodeVarint((1n << 3n) | 2n);
    const len = encodeVarint(20);
    const payload = Buffer.from("short");
    const badBuf = Buffer.concat([tag, len, payload]);

    assert.throws(
      () => decodeEntries(badBuf),
      (err) => err instanceof ProtobufTruncatedError && /Truncated length-delimited/.test(err.message)
    );
  });

  test("truncated fixed32 and fixed64 throw ProtobufTruncatedError", () => {
    // wt=5 needs 4 bytes, provide only 2
    const f32Tag = encodeVarint((1n << 3n) | 5n);
    const shortF32 = Buffer.concat([f32Tag, Buffer.from([1, 2])]);
    assert.throws(
      () => decodeEntries(shortF32),
      (err) => err instanceof ProtobufTruncatedError && /Truncated 32-bit fixed/.test(err.message)
    );

    // wt=1 needs 8 bytes, provide only 4
    const f64Tag = encodeVarint((2n << 3n) | 1n);
    const shortF64 = Buffer.concat([f64Tag, Buffer.from([1, 2, 3, 4])]);
    assert.throws(
      () => decodeEntries(shortF64),
      (err) => err instanceof ProtobufTruncatedError && /Truncated 64-bit fixed/.test(err.message)
    );
  });

  test("field number 0 throws ProtobufMalformedError", () => {
    // fn=0, wt=0 -> tag = 0
    const badTag = Buffer.from([0x00, 0x01]);
    assert.throws(
      () => decodeEntries(badTag),
      (err) => err instanceof ProtobufMalformedError && /Invalid field number 0/.test(err.message)
    );
  });

  test("unsupported wire type throws ProtobufMalformedError", () => {
    // fn=1, wt=3 (deprecated start group) -> tag = (1 << 3) | 3 = 0x0b
    const badWireTypeBuf = Buffer.from([0x0b, 0x01]);
    assert.throws(
      () => decodeEntries(badWireTypeBuf),
      (err) => err instanceof ProtobufMalformedError && /Unsupported wire type 3/.test(err.message)
    );
  });

  test("encodeEntries preserves unknown fields byte-for-byte using rawBytes", () => {
    const unknownField99Tag = encodeVarint((99n << 3n) | 2n);
    const unknownPayload = Buffer.from("custom_secret_metadata_bytes");
    const unknownField99 = Buffer.concat([
      unknownField99Tag,
      encodeVarint(unknownPayload.length),
      unknownPayload,
    ]);

    const normalField1Tag = encodeVarint((1n << 3n) | 0n);
    const normalField1 = Buffer.concat([normalField1Tag, encodeVarint(42n)]);

    const originalBuf = Buffer.concat([normalField1, unknownField99]);

    const decoded = decodeEntries(originalBuf);
    assert.strictEqual(decoded.length, 2);
    assert.strictEqual(decoded[1].fn, 99);

    const reEncoded = encodeEntries(decoded);
    assert.deepStrictEqual(reEncoded, originalBuf);
  });

  test("decodeFrames and encodeFrame handle gRPC frames with bounds checking", () => {
    const payload1 = Buffer.from("frame_1_content");
    const payload2 = Buffer.from("frame_2_content_different_length");

    const f1 = encodeFrame(payload1, 0);
    const f2 = encodeFrame(payload2, 1);

    const combined = Buffer.concat([f1, f2]);
    const frames = decodeFrames(combined);

    assert.strictEqual(frames.length, 2);
    assert.strictEqual(frames[0].flag, 0);
    assert.strictEqual(frames[0].len, payload1.length);
    assert.deepStrictEqual(frames[0].payload, payload1);

    assert.strictEqual(frames[1].flag, 1);
    assert.strictEqual(frames[1].len, payload2.length);
    assert.deepStrictEqual(frames[1].payload, payload2);
  });

  test("decodeFrames throws ProtobufTruncatedError on partial frame", () => {
    // 3 bytes (header needs 5)
    assert.throws(
      () => decodeFrames(Buffer.from([0x00, 0x00, 0x01])),
      (err) => err instanceof ProtobufTruncatedError && /Truncated gRPC frame header/.test(err.message)
    );

    // Header says 100 bytes, but only 2 payload bytes exist
    const badFrame = Buffer.alloc(7);
    badFrame[0] = 0;
    badFrame.writeUInt32BE(100, 1);
    badFrame[5] = 1;
    badFrame[6] = 2;

    assert.throws(
      () => decodeFrames(badFrame),
      (err) => err instanceof ProtobufTruncatedError && /Truncated gRPC frame payload/.test(err.message)
    );
  });

  console.log(`Protobuf Suite Passed: ${passed} tests.\n`);
  return passed;
}

if (require.main === module) {
  runProtobufTests();
}

module.exports = { runProtobufTests };
