/**
 * Core transformation, safety checks, and annotation merging logic.
 * Enforces strict preservation of unknown fields and explicit error handling.
 */

const {
  decodeEntries,
  encodeEntries,
  encodeVarint,
} = require("./protobuf");
const { parsePbtxt, extractAnnotations } = require("./pbtxt");

class SafetyCheckError extends Error {
  constructor(message, conversationId) {
    super(`Safety check failed for ${conversationId || "unknown"}: ${message}`);
    this.name = "SafetyCheckError";
    this.conversationId = conversationId;
  }
}

/**
 * Extracts last_modified_time (field 3) from CascadeTrajectorySummary entries.
 * Returns { sec: number, nano: number }
 */
function getLastModifiedTime(summaryEntries) {
  const f3 = summaryEntries.find((e) => e.fn === 3 && e.wt === 2);
  if (!f3) return { sec: 0, nano: 0 };

  try {
    const sub = decodeEntries(f3.val);
    const secEntry = sub.find((e) => e.fn === 1 && e.wt === 0);
    const nanoEntry = sub.find((e) => e.fn === 2 && e.wt === 0);
    return {
      sec: secEntry ? Number(secEntry.val) : 0,
      nano: nanoEntry ? Number(nanoEntry.val) : 0,
    };
  } catch (err) {
    return { sec: 0, nano: 0 };
  }
}

/**
 * Returns current source (field 20) as number, or 0 if absent.
 */
function getSource(summaryEntries) {
  const f20 = summaryEntries.find((e) => e.fn === 20 && e.wt === 0);
  return f20 ? Number(f20.val) : 0;
}

/**
 * Checks if summary currently has archived=true in its annotations.
 */
function isArchivedInAnnotations(summaryEntries) {
  const f15 = summaryEntries.find((e) => e.fn === 15 && e.wt === 2);
  if (!f15) return false;
  try {
    const sub = decodeEntries(f15.val);
    const f4 = sub.find((e) => e.fn === 4 && e.wt === 0);
    return f4 ? Number(f4.val) === 1 : false;
  } catch (err) {
    return false;
  }
}

/**
 * Checks if summary currently has marked_as_unread=true.
 */
function isMarkedAsUnread(summaryEntries) {
  const f15 = summaryEntries.find((e) => e.fn === 15 && e.wt === 2);
  if (!f15) return false;
  try {
    const sub = decodeEntries(f15.val);
    const f8 = sub.find((e) => e.fn === 8 && e.wt === 0);
    return f8 ? Number(f8.val) === 1 : false;
  } catch (err) {
    return false;
  }
}

/**
 * Builds or updates field 15 (ConversationAnnotations) while preserving all
 * unknown and unmodified subfields.
 */
function mergeAnnotations(existingF15Buffer, pbtxtContent, modTime, conversationId) {
  let existingSubEntries = [];
  if (existingF15Buffer && Buffer.isBuffer(existingF15Buffer)) {
    try {
      existingSubEntries = decodeEntries(existingF15Buffer);
    } catch (err) {
      throw new SafetyCheckError(`Existing field 15 annotations malformed: ${err.message}`, conversationId);
    }
  }

  // Parse pbtxt
  let parsedObj;
  try {
    parsedObj = parsePbtxt(pbtxtContent);
  } catch (err) {
    throw new SafetyCheckError(`Failed to parse pbtxt: ${err.message}`, conversationId);
  }

  const pbtxtAnn = extractAnnotations(parsedObj);

  // Preserve all sub-entries EXCEPT the ones we are explicitly updating
  // 1: title, 4: archived, 5: archival_status_timestamp, 7: last_user_view_time, 8: marked_as_unread
  const preservedEntries = existingSubEntries.filter(
    (e) => ![1, 4, 5, 7, 8].includes(e.fn)
  );

  const updatedEntries = [...preservedEntries];

  // 1: title
  if (pbtxtAnn.title !== undefined) {
    const tb = Buffer.from(pbtxtAnn.title, "utf8");
    updatedEntries.push({ fn: 1, wt: 2, val: tb });
  } else {
    const oldTitle = existingSubEntries.find((e) => e.fn === 1);
    if (oldTitle) updatedEntries.push(oldTitle);
  }

  // 4: archived (varint)
  if (pbtxtAnn.archived !== undefined) {
    if (pbtxtAnn.archived) {
      updatedEntries.push({ fn: 4, wt: 0, val: 1n });
    }
  } else {
    const oldArchived = existingSubEntries.find((e) => e.fn === 4);
    if (oldArchived) updatedEntries.push(oldArchived);
  }

  // 5: archival_status_timestamp
  if (pbtxtAnn.archival_status_timestamp) {
    const tsEntries = [
      { fn: 1, wt: 0, val: BigInt(pbtxtAnn.archival_status_timestamp.seconds) },
    ];
    if (pbtxtAnn.archival_status_timestamp.nanos > 0) {
      tsEntries.push({ fn: 2, wt: 0, val: BigInt(pbtxtAnn.archival_status_timestamp.nanos) });
    }
    updatedEntries.push({ fn: 5, wt: 2, val: encodeEntries(tsEntries) });
  } else {
    const oldArchTs = existingSubEntries.find((e) => e.fn === 5);
    if (oldArchTs) updatedEntries.push(oldArchTs);
  }

  // Determine if conversation is explicitly marked as unread
  const markedUnread =
    pbtxtAnn.marked_as_unread === true ||
    (pbtxtAnn.marked_as_unread === undefined && isMarkedAsUnread(existingF15Buffer ? [{ fn: 15, wt: 2, val: existingF15Buffer }] : []));

  // 8: marked_as_unread
  if (markedUnread) {
    updatedEntries.push({ fn: 8, wt: 0, val: 1n });
  }

  // 7: last_user_view_time
  let viewSec = pbtxtAnn.last_user_view_time?.seconds || 0;
  let viewNano = pbtxtAnn.last_user_view_time?.nanos || 0;

  if (!viewSec) {
    const oldView = existingSubEntries.find((e) => e.fn === 7 && e.wt === 2);
    if (oldView) {
      try {
        const sub = decodeEntries(oldView.val);
        const s = sub.find((e) => e.fn === 1 && e.wt === 0);
        const n = sub.find((e) => e.fn === 2 && e.wt === 0);
        if (s) viewSec = Number(s.val);
        if (n) viewNano = Number(n.val);
      } catch (err) {}
    }
  }

  // Do not modify view time if user explicitly marked as unread
  if (!markedUnread && modTime.sec > 0) {
    if (viewSec < modTime.sec) {
      viewSec = modTime.sec;
      viewNano = modTime.nano || 0;
    }
  }

  if (viewSec > 0) {
    const viewEntries = [{ fn: 1, wt: 0, val: BigInt(viewSec) }];
    if (viewNano > 0) {
      viewEntries.push({ fn: 2, wt: 0, val: BigInt(viewNano) });
    }
    updatedEntries.push({ fn: 7, wt: 2, val: encodeEntries(viewEntries) });
  }

  // Sort entries by field number for canonical protobuf representation
  updatedEntries.sort((a, b) => a.fn - b.fn);
  return encodeEntries(updatedEntries);
}

/**
 * Plans and builds a transformed CascadeTrajectorySummary buffer.
 * Preserves ALL unknown fields and validates the transformation.
 */
function transformSummary(rawSummaryBuffer, pbtxtContent, conversationId, options = {}) {
  if (!Buffer.isBuffer(rawSummaryBuffer)) {
    throw new TypeError("Expected rawSummaryBuffer to be Buffer");
  }

  const entries = decodeEntries(rawSummaryBuffer);
  const modTime = getLastModifiedTime(entries);
  const currentSrc = getSource(entries);

  // Require pbtxt if safety check requires it
  if (!pbtxtContent && options.requirePbtxt) {
    throw new SafetyCheckError("Missing pbtxt file and requirePbtxt is set", conversationId);
  }

  const existingF15 = entries.find((e) => e.fn === 15 && e.wt === 2);

  let newF15Buffer = null;
  if (pbtxtContent) {
    newF15Buffer = mergeAnnotations(
      existingF15 ? existingF15.val : null,
      pbtxtContent,
      modTime,
      conversationId
    );
  } else if (existingF15) {
    // Keep existing annotations untouched
    newF15Buffer = existingF15.val;
  } else if (options.allowDefaultViewTime && modTime.sec > 0) {
    // Safe fallback: synthesize lastUserViewTime = modTime so it doesn't show as unread
    const viewEntries = [{ fn: 1, wt: 0, val: BigInt(modTime.sec) }];
    if (modTime.nano > 0) viewEntries.push({ fn: 2, wt: 0, val: BigInt(modTime.nano) });
    newF15Buffer = encodeEntries([{ fn: 7, wt: 2, val: encodeEntries(viewEntries) }]);
  } else {
    throw new SafetyCheckError(
      "No existing annotations and no pbtxt available to safely build annotations",
      conversationId
    );
  }

  // Rebuild summary preserving all non-20, non-15 fields
  const preservedSummaryEntries = entries.filter((e) => e.fn !== 20 && e.fn !== 15);

  const finalEntries = [
    ...preservedSummaryEntries,
    { fn: 15, wt: 2, val: newF15Buffer },
    { fn: 20, wt: 0, val: 0n }, // source = 0 (LOCAL)
  ];

  finalEntries.sort((a, b) => a.fn - b.fn);
  const transformedBuffer = encodeEntries(finalEntries);

  return {
    transformedBuffer,
    changes: {
      source: { from: currentSrc, to: 0 },
      hadAnnotationsBefore: !!existingF15,
      hasAnnotationsAfter: true,
      lastModified: modTime,
    },
  };
}

/**
 * Verify transformed buffer has expected fields:
 * - source === 0
 * - annotations present and parseable
 */
function verifyTransformedSummary(buffer, expected = {}) {
  const entries = decodeEntries(buffer);
  const src = getSource(entries);
  if (src !== 0) {
    throw new Error(`Verification failed: expected source 0, got ${src}`);
  }

  const f15 = entries.find((e) => e.fn === 15 && e.wt === 2);
  if (!f15) {
    throw new Error("Verification failed: missing field 15 annotations");
  }

  const annSub = decodeEntries(f15.val);
  if (expected.archived !== undefined) {
    const f4 = annSub.find((e) => e.fn === 4 && e.wt === 0);
    const isArch = f4 ? Number(f4.val) === 1 : false;
    if (isArch !== expected.archived) {
      throw new Error(`Verification failed: expected archived=${expected.archived}, got ${isArch}`);
    }
  }

  if (expected.title !== undefined) {
    const f1 = annSub.find((e) => e.fn === 1 && e.wt === 2);
    const title = f1 ? f1.val.toString("utf8") : "";
    if (title !== expected.title) {
      throw new Error(`Verification failed: expected title="${expected.title}", got "${title}"`);
    }
  }

  return true;
}

module.exports = {
  SafetyCheckError,
  getLastModifiedTime,
  getSource,
  isArchivedInAnnotations,
  isMarkedAsUnread,
  mergeAnnotations,
  transformSummary,
  verifyTransformedSummary,
};
