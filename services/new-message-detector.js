/**
 * new-message-detector.js
 *
 * Detects newly arrived unread messages in an already-open IMAP mailbox.
 *
 * Design (Sprint 33 KR "New-Message Detection Loop"):
 * - `findNewUnreadMessages` is the isolated, unit-testable detection core: given a
 *   connected client and a UID watermark, it returns the unseen messages that arrived
 *   after the watermark.
 * - `createNewMessageDetector` is the loop that drives it in a **hybrid** fashion:
 *   imapflow's IDLE `exists` event triggers an immediate check for near-instant
 *   detection, and a polling interval acts as a safety net.
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

module.exports = {
  // public API
  createNewMessageDetector,
  // helpers (exported for testing)
  findNewUnreadMessages,
  fetchEnvelopes,
};

if (require.main === module) {
  console.log('New-message detector loaded. Import createNewMessageDetector from this module.');
}
