/**
 * parser-service.js
 *
 * Pure-function email parser. Given a raw message object produced by
 * new-message-detector.js, extracts applicant metadata (name, position) from
 * the subject line (KR 2.1), validates the result and flags malformed
 * subjects (KR 2.2), validates attachments (KR 2.3), and combines the
 * pieces into a normalized JSON envelope (KR 2.4).
 *
 * All functions in this module are pure where possible so they can be
 * unit-tested without an IMAP client.
 */

const SUPPORTED_ATTACHMENT_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
]);

// "First Last - [Position] Intern". Names may contain unicode letters, hyphens, or apostrophes.
const SUBJECT_RE = /^\s*([\p{L}'-]+)\s+([\p{L}'-]+)\s*-\s*\[([^\]]+)\]\s+Intern\s*$/u;
const NAMES_PREFIX_RE = /^\s*([\p{L}'-]+)\s+([\p{L}'-]+)\s*-/u;
const INTERN_ANYWHERE_RE = /\bIntern\b/;
const INTERN_AT_END_RE = /\bIntern\s*$/;

/**
 * Brief Summary: Parse a subject line of the form "First Last - [Position] Intern"
 * and return the structured parts.
 *
 * Parameters (Arguments):
 * - subject (string, required): The raw subject line to parse.
 *
 * Returns: { firstName: string, lastName: string, position: string } - The
 * extracted fields. Position includes the trailing "Intern" keyword
 * (e.g. "Software Engineer Intern").
 *
 * Raises / Errors: Throws ParserError when the subject does not match the
 * expected shape (see parseSubjectOrThrow).
 *
 * Examples:
 * parseSubject('Ada Lovelace - [Software Engineer] Intern');
 * // { firstName: 'Ada', lastName: 'Lovelace', position: 'Software Engineer Intern' }
 */
function parseSubject(subject) {
  const match = typeof subject === 'string' ? subject.match(SUBJECT_RE) : null;

  if (!match) {
    throw new ParserError('unknown', `Subject does not match the expected format: "${subject}"`);
  }

  return {
    firstName: match[1],
    lastName: match[2],
    position: `${match[3].trim()} Intern`,
  };
}

/**
 * Brief Summary: Same as parseSubject but with a friendlier error and a
 * structured rejection reason. Used by the malformed-subject path (KR 2.2).
 *
 * Parameters (Arguments):
 * - subject (string, required): The raw subject line.
 *
 * Returns: { firstName: string, lastName: string, position: string }
 *
 * Raises / Errors: Throws ParserError { reason: string } where reason is
 * one of: 'empty', 'missing_name', 'missing_position', 'missing_intern_keyword',
 * 'extra_text', 'unknown'.
 *
 * Examples:
 * try { parseSubjectOrThrow(''); } catch (e) { e.reason === 'empty' }
 */
/**
 * Diagnose *why* a subject failed to match SUBJECT_RE, for a friendlier
 * ParserError reason than parseSubject's generic 'unknown'.
 */
function diagnoseMalformedSubject(subject) {
  const trimmed = subject.trim();
  const namesMatch = trimmed.match(NAMES_PREFIX_RE);

  if (!namesMatch) {
    return 'missing_name';
  }

  if (!INTERN_ANYWHERE_RE.test(trimmed)) {
    return 'missing_intern_keyword';
  }

  if (!INTERN_AT_END_RE.test(trimmed)) {
    return 'extra_text';
  }

  const afterNames = trimmed.slice(namesMatch[0].length);
  if (!/\[[^\]]+\]/.test(afterNames)) {
    return 'missing_position';
  }

  return 'extra_text';
}

function parseSubjectOrThrow(subject) {
  if (typeof subject !== 'string' || !subject.trim()) {
    console.error('ERROR: Subject is missing or empty.');
    throw new ParserError('empty', 'Subject is missing or empty.');
  }

  try {
    return parseSubject(subject);
  } catch (err) {
    if (!(err instanceof ParserError)) {
      throw err;
    }

    const reason = diagnoseMalformedSubject(subject);
    console.warn(`WARNING: Invalid subject format (${reason}): "${subject}"`);
    throw new ParserError(reason, `Malformed subject line: "${subject}"`);
  }
}

/**
 * Brief Summary: Pick the resume attachment out of a list of attachment
 * descriptors, or throw a structured error if there is none / the wrong type.
 *
 * Parameters (Arguments):
 * - attachments (Array<{ filename: string, mimeType: string, content: Buffer }>, required)
 *
 * Returns: { filename: string, mimeType: string, content: Buffer }
 *
 * Raises / Errors: Throws ParserError { reason: 'no_attachment' |
 * 'unsupported_type' | 'ambiguous' }.
 *
 * Examples:
 * pickResumeAttachment([{ filename: 'resume.pdf', mimeType: 'application/pdf', content }]);
 */
function pickResumeAttachment(attachments) {
  // TODO(KR 2.3): filter attachments to SUPPORTED_ATTACHMENT_MIME_TYPES,
  // return the only match, throw 'no_attachment' when empty, 'ambiguous'
  // when multiple resume-shaped attachments are present, and
  // 'unsupported_type' when the message has attachments but none are
  // PDF/DOCX.
}

/**
 * Brief Summary: Combine a parsed subject, message body, and validated
 * resume attachment into the normalized envelope consumed downstream.
 *
 * Parameters (Arguments):
 * - rawMessage (object, required): The raw message from new-message-detector.
 * - parsed (object, required): Output of parseSubjectOrThrow.
 * - attachment (object, required): Output of pickResumeAttachment.
 *
 * Returns: {
 *   senderEmail: string,
 *   firstName: string,
 *   lastName: string,
 *   position: string,
 *   body: string,
 *   attachment: { filename: string, mimeType: string, contentBase64: string }
 * }
 *
 * Raises / Errors: Throws TypeError when any required field is missing.
 *
 * Examples:
 * const normalized = buildNormalizedOutput(raw, parsed, attachment);
 */
function buildNormalizedOutput(rawMessage, parsed, attachment) {
  // TODO(KR 2.4): build the object documented in the JSDoc above. The
  // attachment content is included as a base64 string so the envelope can
  // be JSON-serialized for the repository_dispatch payload (see KR 3.2).
  // Strip any binary content from `body` if both text and html are present.
}

/**
 * Brief Summary: Convenience wrapper: parse + validate + build the
 * normalized envelope from a raw message in one call.
 *
 * Parameters (Arguments):
 * - rawMessage (object, required): The raw message from new-message-detector.
 *
 * Returns: Promise<NormalizedApplication> - The structured application.
 *
 * Raises / Errors: Rejects with ParserError for any recoverable issue so
 * the caller can flag the email for manual review.
 *
 * Examples:
 * const app = await parseEmail(rawMessage);
 */
async function parseEmail(rawMessage) {
  // TODO(KR 2.1–2.4): orchestrate parseSubjectOrThrow, pickResumeAttachment,
  // and buildNormalizedOutput. Catch ParserError and re-throw so the
  // listener logs the structured reason.
}

/**
 * Public API exposed by this module.
 */
class ParserError extends Error {
  constructor(reason, message) {
    super(message || `Parser rejected the email: ${reason}`);
    this.name = 'ParserError';
    this.reason = reason;
  }
}

module.exports = {
  buildNormalizedOutput,
  parseEmail,
  parseSubject,
  parseSubjectOrThrow,
  pickResumeAttachment,
  ParserError,
  SUPPORTED_ATTACHMENT_MIME_TYPES,
};

if (require.main === module) {
  console.log('Parser service loaded. Import parseEmail from this module.');
}
