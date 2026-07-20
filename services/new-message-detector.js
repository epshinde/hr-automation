/**
 * new-message-detector.js
 *
 * Detects newly arrived unread messages in an already-open IMAP mailbox, fetches
 * their full content, and dedups/hands them off to a caller-supplied handler
 * (KR 1.2, 1.3, 1.4).
 *
 * Design (Sprint 33 KR "New-Message Detection Loop"):
 * - `findNewUnreadMessages` is the isolated, unit-testable detection core: given a
 *   connected client and a UID watermark, it returns the unseen messages that arrived
 *   after the watermark.
 * - `createNewMessageDetector` is the loop that drives it in a **hybrid** fashion:
 *   imapflow's IDLE `exists` event triggers an immediate check for near-instant
 *   detection, and a polling interval acts as a safety net.
 * - `fetchMessageContent` fetches the full content (body, attachments) of a single
 *   detected message.
 * - `loadProcessedUids` / `markProcessed` persist a dedup set across restarts.
 * - `runListener` is the top-level glue: connect, drive the detector, fetch each
 *   new message, and hand it to a caller-supplied handler.
 *
 * It consumes the connected client from services/imap-service.js (via a getClient
 * callback) rather than owning its own connection, so it inherits that service's
 * reconnect handling.
 */

const DEFAULT_INTERVAL_MS = 30000;
const DEFAULT_MAILBOX = 'INBOX';

/**
 * Brief Summary: Find unseen messages whose UID is greater than a watermark.
 *
 * This is the isolated detection logic. It assumes the target mailbox is already the
 * selected mailbox on the client (the loop opens it in `start()`), and performs a
 * single IMAP search.
 *
 * Parameters (Arguments):
 * - client (Object, required): A connected imapflow-compatible client exposing
 *   `search(query, options)` that resolves to an array of UIDs.
 * - options (Object, optional):
 *   - sinceUid (number, optional): Watermark. Only messages with a strictly greater
 *     UID are considered new (default: 0).
 *
 * Returns: Promise<{uids: number[], highestUid: number}> - The new unseen UIDs (sorted
 * ascending) and the highest UID seen (>= sinceUid), suitable as the next watermark.
 *
 * Raises / Errors: Propagates any error thrown by `client.search`.
 *
 * Examples:
 * const {uids, highestUid} = await findNewUnreadMessages(client, {sinceUid: 42});
 */
async function findNewUnreadMessages(client, {sinceUid = 0} = {}) {
  // `${sinceUid + 1}:*` asks the server for unseen UIDs above the watermark.
  const found = await client.search({seen: false, uid: `${sinceUid + 1}:*`}, {uid: true});

  // IMAP quirk: a `N:*` range where N is past the newest UID still matches the newest
  // message, so filter defensively to guarantee we only report genuinely new UIDs.
  const uids = (found || [])
    .filter((uid) => uid > sinceUid)
    .sort((a, b) => a - b);

  const highestUid = uids.reduce((max, uid) => Math.max(max, uid), sinceUid);

  return {uids, highestUid};
}

/**
 * Brief Summary: Fetch minimal envelope info (from/subject) for a set of UIDs.
 *
 * Used by the loop to enrich detected messages for logging/handoff. Kept separate from
 * the pure detection core so that core stays trivially testable.
 *
 * Parameters (Arguments):
 * - client (Object, required): imapflow-compatible client exposing an async-iterable
 *   `fetch(range, query, options)`.
 * - uids (number[], required): UIDs to fetch.
 *
 * Returns: Promise<Array<{uid: number, envelope: Object}>>
 *
 * Raises / Errors: Propagates any error thrown by `client.fetch`.
 */
async function fetchEnvelopes(client, uids) {
  const messages = [];

  for await (const message of client.fetch(uids, {envelope: true}, {uid: true})) {
    messages.push({uid: message.uid, envelope: message.envelope});
  }

  return messages;
}

/**
 * Brief Summary: Create a hybrid (IDLE + polling) detector for new unread messages.
 *
 * Parameters (Arguments):
 * - options (Object, required):
 *   - getClient (function, required): Returns the current connected client (typically
 *     `() => imapService.getClient()`).
 *   - mailbox (string, optional): Mailbox to watch (default: 'INBOX').
 *   - intervalMs (number, optional): Polling safety-net interval (default: 30000).
 *   - onNewMessages (function, optional): Called with an array of detected messages
 *     (`[{uid, envelope?}]`) whenever new unread mail is found. May be async.
 *   - includeEnvelopes (boolean, optional): Fetch from/subject for detected messages
 *     before invoking the callback (default: true).
 *
 * Returns: Object - { start, stop, check }.
 *   - start(): Promise<void> - Opens the mailbox, sets the watermark to "now", and arms
 *     the IDLE listener + polling interval. Only messages arriving after start are reported.
 *   - stop(): void - Detaches the listener and clears the interval.
 *   - check(): Promise<void> - Runs one detection pass immediately (also used internally).
 *
 * Raises / Errors: start() throws if no client is available from getClient().
 */
function createNewMessageDetector({
  getClient,
  mailbox = DEFAULT_MAILBOX,
  intervalMs = DEFAULT_INTERVAL_MS,
  onNewMessages,
  includeEnvelopes = true,
} = {}) {
  if (typeof getClient !== 'function') {
    throw new Error('createNewMessageDetector requires a getClient() function.');
  }

  let lastSeenUid = 0;
  let running = false;
  let checking = false;
  let pollTimer = null;
  let existsHandler = null;
  let boundClient = null;

  async function check() {
    // Collapse overlapping checks: the IDLE 'exists' event and the poll timer can fire
    // close together, and we only need one search in flight at a time.
    if (checking) {
      return;
    }
    checking = true;

    try {
      const client = getClient();
      if (!client) {
        return;
      }

      const {uids, highestUid} = await findNewUnreadMessages(client, {sinceUid: lastSeenUid});
      if (uids.length === 0) {
        return;
      }

      // Advance the watermark before the callback so a slow handler can't cause re-detection.
      lastSeenUid = highestUid;

      let messages = uids.map((uid) => ({uid}));
      if (includeEnvelopes) {
        messages = await fetchEnvelopes(client, uids);
      }

      if (typeof onNewMessages === 'function') {
        await onNewMessages(messages);
      }
    } catch (err) {
      console.error('[new-message-detector] Detection check failed:', err && err.message ? err.message : err);
    } finally {
      checking = false;
    }
  }

  async function start() {
    if (running) {
      return;
    }

    const client = getClient();
    if (!client) {
      throw new Error('No IMAP client available. Call imapService.connect() before starting the detector.');
    }

    boundClient = client;
    const info = await client.mailboxOpen(mailbox);

    // Watermark = the newest existing UID, so we only report mail that arrives *after*
    // start (uidNext is the UID the next new message will receive).
    lastSeenUid = info && info.uidNext ? info.uidNext - 1 : 0;
    running = true;

    console.log(
      `[new-message-detector] Watching ${mailbox} (watermark uid=${lastSeenUid}); IDLE + polling every ${intervalMs}ms.`
    );

    // Hybrid part 1 — IDLE: imapflow emits 'exists' when the message count changes.
    existsHandler = () => {
      check();
    };
    boundClient.on('exists', existsHandler);

    // Hybrid part 2 — polling safety net.
    pollTimer = setInterval(() => {
      check();
    }, intervalMs);
    if (pollTimer && typeof pollTimer.unref === 'function') {
      pollTimer.unref();
    }
  }

  function stop() {
    running = false;

    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    if (boundClient && existsHandler) {
      boundClient.removeListener('exists', existsHandler);
      existsHandler = null;
    }
  }

  return {start, stop, check};
}

/**
 * Brief Summary: Fetch the full content of a single message by UID and return
 * a structured raw-message object.
 *
 * Parameters (Arguments):
 * - client (ImapFlow-like, required): A connected IMAP client.
 * - mailbox (string, required): Mailbox the message lives in.
 * - uid (number, required): UID of the message to fetch.
 *
 * Returns: Promise<{
 *   uid: number,
 *   sender: string,
 *   subject: string,
 *   bodyText: string,
 *   bodyHtml: string,
 *   attachments: Array<{ filename: string, mimeType: string, content: Buffer }>,
 * }>
 *
 * Raises / Errors: Rejects with an Error if the fetch call fails or the
 * server response is missing required fields.
 *
 * Examples:
 * const msg = await fetchMessageContent(client, 'INBOX', 12345);
 */
async function fetchMessageContent(_client, _mailbox, _uid) {
  // TODO(KR 1.3): call client.mailboxOpen(mailbox, { readOnly: true }) if
  // not already open, then client.fetchOne(uid, { source: true, ... })
  // (or fetch a range that includes uid). Parse the parsed response into
  // the { uid, sender, subject, bodyText, bodyHtml, attachments } shape
  // documented in the JSDoc above. Attachment content must be returned as
  // Buffer objects.
}

/**
 * Brief Summary: Load the set of UIDs that have already been processed in
 * this run or in previous runs.
 *
 * Parameters (Arguments):
 * - options (Object, optional):
 *   - storePath (string, optional): Path to a JSON file used to persist UIDs
 *     across restarts (default: '.listener-processed-uids.json').
 *
 * Returns: Promise<Set<number>> - The set of UIDs considered already processed.
 *
 * Raises / Errors: Rejects with an Error if the persistence file exists but
 * cannot be read or parsed.
 *
 * Examples:
 * const seen = await loadProcessedUids();
 */
async function loadProcessedUids(_options = {}) {
  // TODO(KR 1.4): read options.storePath (default
  // '.listener-processed-uids.json') if it exists, JSON.parse it, and
  // return the resulting array as a Set<number>. Return an empty set when
  // the file is missing.
}

/**
 * Brief Summary: Persist a UID as processed so it is not re-fired on the
 * next poll cycle.
 *
 * Parameters (Arguments):
 * - uid (number, required): UID that was just handed off downstream.
 * - options (Object, optional):
 *   - storePath (string, optional): Path to a JSON file used to persist UIDs
 *     (default: '.listener-processed-uids.json').
 *   - inMemory (Set<number>, optional): The in-memory set returned by
 *     loadProcessedUids(). Mutated in place for fast dedup checks.
 *
 * Returns: Promise<void>
 *
 * Raises / Errors: Rejects with an Error if writing to the store fails.
 *
 * Examples:
 * await markProcessed(12345, { inMemory: seen });
 */
async function markProcessed(uid, _options = {}) {
  // TODO(KR 1.4): add uid to options.inMemory if provided, then merge
  // the in-memory set into options.storePath (default
  // '.listener-processed-uids.json') as a JSON array of numbers. Use an
  // atomic write (write to .tmp then rename) so a crash mid-write cannot
  // corrupt the store.
}

/**
 * Brief Summary: Top-level glue — connect, run the hybrid detection loop, and
 * hand each new message's full content to a caller-supplied handler.
 *
 * Parameters (Arguments):
 * - handler (Function, required): Async (rawMessage) => void invoked once
 *   per new message. The handler should throw to signal a non-recoverable
 *   processing error; transient errors should be caught inside the handler.
 * - options (Object, optional): Forwarded to createNewMessageDetector +
 *   markProcessed.
 *
 * Returns: Promise<void> - Resolves when options.signal is aborted.
 *
 * Raises / Errors: Rejects on the initial connection failure. Per-message
 * handler errors are logged and the message is not marked as processed.
 *
 * Examples:
 * await runListener(async (msg) => { await process(msg); });
 */
async function runListener(handler, _options = {}) {
  // TODO(KR 1.2, 1.3, 1.4): create an ImapService via createImapService(),
  // connect, then drive createNewMessageDetector() with an onNewMessages
  // callback that, per UID:
  //   1. skips UIDs already in loadProcessedUids()
  //   2. fetches the full content via fetchMessageContent()
  //   3. await handler(rawMessage)
  //   4. markProcessed(uid)
  // Tear down on signal abort.
}

module.exports = {
  // public API
  createNewMessageDetector,
  runListener,
  fetchMessageContent,
  loadProcessedUids,
  markProcessed,
  // helpers (exported for testing)
  findNewUnreadMessages,
  fetchEnvelopes,
};

if (require.main === module) {
  console.log('New-message detector loaded. Import createNewMessageDetector from this module.');
}
