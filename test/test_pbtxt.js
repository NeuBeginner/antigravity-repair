const assert = require("assert");
const { tokenize, parsePbtxt, extractAnnotations, PbtxtParseError } = require("../lib/pbtxt");

function runPbtxtTests() {
  console.log("--- Running PBTXT Tests ---");
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

  test("empty input parses to empty object", () => {
    const res = parsePbtxt("");
    assert.deepStrictEqual(res, {});
    const whitespaceRes = parsePbtxt("   \n\t  \r\n");
    assert.deepStrictEqual(whitespaceRes, {});
  });

  test("comments are ignored", () => {
    const pbtxt = `
      # Comment at start
      title: "Hello World" # Inline comment
      # Middle comment
      archived: true
    `;
    const res = parsePbtxt(pbtxt);
    assert.strictEqual(res.title, "Hello World");
    assert.strictEqual(res.archived, true);
  });

  test("valid standard conversation annotations", () => {
    const pbtxt = `
      title: "Antigravity Chat"
      archived: true
      marked_as_unread: false
      last_user_view_time {
        seconds: 1731400000
        nanos: 500
      }
      archival_status_timestamp <
        seconds: 1731400050
      >
    `;
    const res = parsePbtxt(pbtxt);
    assert.strictEqual(res.title, "Antigravity Chat");
    assert.strictEqual(res.archived, true);
    assert.strictEqual(res.marked_as_unread, false);
    assert.strictEqual(res.last_user_view_time.seconds, 1731400000);
    assert.strictEqual(res.last_user_view_time.nanos, 500);
    assert.strictEqual(res.archival_status_timestamp.seconds, 1731400050);

    const extracted = extractAnnotations(res);
    assert.strictEqual(extracted.title, "Antigravity Chat");
    assert.strictEqual(extracted.archived, true);
    assert.strictEqual(extracted.marked_as_unread, false);
    assert.deepStrictEqual(extracted.last_user_view_time, { seconds: 1731400000, nanos: 500 });
    assert.deepStrictEqual(extracted.archival_status_timestamp, { seconds: 1731400050, nanos: 0 });
  });

  test("string escaping and multiline strings", () => {
    const pbtxt = 'title: "Line 1\\nLine 2\\t\\"quoted\\" and \\\\slash"';
    const res = parsePbtxt(pbtxt);
    assert.strictEqual(res.title, 'Line 1\nLine 2\t"quoted" and \\slash');
  });

  test("syntax without colons (protobuf shorthand)", () => {
    const pbtxt = `
      title "No Colon"
      archived false
      last_user_view_time {
        seconds 12345
      }
    `;
    const res = parsePbtxt(pbtxt);
    assert.strictEqual(res.title, "No Colon");
    assert.strictEqual(res.archived, false);
    assert.strictEqual(res.last_user_view_time.seconds, 12345);
  });

  test("repeated fields as array", () => {
    const pbtxt = `
      tags: "work"
      tags: "important"
      tags: "review"
    `;
    const res = parsePbtxt(pbtxt);
    assert.deepStrictEqual(res.tags, ["work", "important", "review"]);
  });

  test("malformed: unterminated string literal", () => {
    assert.throws(
      () => parsePbtxt('title: "Unterminated string'),
      (err) => err instanceof PbtxtParseError && /Unterminated string literal/.test(err.message)
    );
  });

  test("malformed: unclosed message brace", () => {
    assert.throws(
      () => parsePbtxt("last_user_view_time { seconds: 123"),
      (err) => err instanceof PbtxtParseError && /Missing closing '}'/.test(err.message)
    );
  });

  test("malformed: unexpected token in field position", () => {
    assert.throws(
      () => parsePbtxt("{ }"),
      (err) => err instanceof PbtxtParseError && /Expected field name identifier/.test(err.message)
    );
  });

  test("extractAnnotations handles partial and missing fields gracefully", () => {
    const partial = {
      title: "Solo Title",
    };
    const extracted = extractAnnotations(partial);
    assert.strictEqual(extracted.title, "Solo Title");
    assert.strictEqual(extracted.archived, undefined);
    assert.strictEqual(extracted.marked_as_unread, undefined);
    assert.strictEqual(extracted.last_user_view_time, undefined);
    assert.strictEqual(extracted.archival_status_timestamp, undefined);
  });

  test("extractAnnotations throws on non-object", () => {
    assert.throws(() => extractAnnotations(null), /Invalid pbtxt content/);
    assert.throws(() => extractAnnotations("invalid"), /Invalid pbtxt content/);
  });

  console.log(`PBTXT Suite Passed: ${passed} tests.\n`);
  return passed;
}

if (require.main === module) {
  runPbtxtTests();
}

module.exports = { runPbtxtTests };
