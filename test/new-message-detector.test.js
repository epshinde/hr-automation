const assert = require('node:assert');
const test = require('node:test');
const {EventEmitter} = require('node:events');

const {
  findNewUnreadMessages,
  createNewMessageDetector,
} = require('../services/new-message-detector');

/**
 * Fake imapflow-like client backed by an in-memory message list.
 * Each message is {uid, seen}. `deliver()` simulates a new arrival and fires 'exists'.
 */
function createFakeClient({uidNext = 1, messages = []} = {}) {
  const client = new EventEmitter();
  client.messages = messages.slice();
  client._uidNext = uidNext;

  client.mailboxOpen = async () => ({
    path: 'INBOX',
    exists: client.messages.length,
    uidNext: client._uidNext,
  });

  // Supports query {seen: false, uid: 'N:*'} and options {uid: true}.
  client.search = async (query = {}) => {
    let list = client.messages.slice();
    if (query.seen === false) {
      list = list.filter((m) => !m.seen);
    }
    if (query.uid) {
      const lower = parseInt(String(query.uid).split(':')[0], 10);
      list = list.filter((m) => m.uid >= lower);
    }
    return list.map((m) => m.uid);
  };

  client.fetch = async function* fetchGen(uids) {
    const wanted = new Set(uids);
    for (const m of client.messages) {
      if (wanted.has(m.uid)) {
        yield {uid: m.uid, envelope: {subject: `Subject ${m.uid}`, from: [{address: `sender${m.uid}@example.com`}]}};
      }
    }
  };

  client.deliver = (uid) => {
    client._uidNext = Math.max(client._uidNext, uid + 1);
    client.messages.push({uid, seen: false});
    client.emit('exists', {path: 'INBOX', count: client.messages.length});
  };

  return client;
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Isolated detection core (the DoD's "testable function") ---

test('findNewUnreadMessages returns only unseen UIDs above the watermark', async () => {
  const client = createFakeClient({
    messages: [
      {uid: 1, seen: true},
      {uid: 2, seen: false},
      {uid: 3, seen: false},
    ],
  });

  const {uids, highestUid} = await findNewUnreadMessages(client, {sinceUid: 1});

  assert.deepStrictEqual(uids, [2, 3]);
  assert.strictEqual(highestUid, 3);
});

test('findNewUnreadMessages defends against the IMAP N:* quirk (uid <= watermark)', async () => {
  // Only message is uid 5, already below the watermark — must not be reported.
  const client = createFakeClient({messages: [{uid: 5, seen: false}]});

  const {uids, highestUid} = await findNewUnreadMessages(client, {sinceUid: 10});

  assert.deepStrictEqual(uids, []);
  assert.strictEqual(highestUid, 10);
});

test('findNewUnreadMessages returns empty when nothing new', async () => {
  const client = createFakeClient({messages: [{uid: 1, seen: true}]});

  const {uids, highestUid} = await findNewUnreadMessages(client, {sinceUid: 0});

  assert.deepStrictEqual(uids, []);
  assert.strictEqual(highestUid, 0);
});

// --- The hybrid loop ---

test('detector reports a message that arrives after start (via IDLE exists event)', async () => {
  const client = createFakeClient({uidNext: 5}); // existing mail up to uid 4
  const detected = [];

  const detector = createNewMessageDetector({
    getClient: () => client,
    intervalMs: 100000, // effectively rely on the exists event, not the poll
    onNewMessages: (messages) => {
      detected.push(...messages);
    },
  });

  await detector.start();

  client.deliver(5); // new arrival fires 'exists'
  await tick();

  assert.strictEqual(detected.length, 1);
  assert.strictEqual(detected[0].uid, 5);
  assert.strictEqual(detected[0].envelope.subject, 'Subject 5');

  detector.stop();
});

test('detector does not re-report an already-detected message', async () => {
  const client = createFakeClient({uidNext: 1});
  const detected = [];

  const detector = createNewMessageDetector({
    getClient: () => client,
    intervalMs: 100000,
    onNewMessages: (messages) => {
      detected.push(...messages);
    },
  });

  await detector.start();

  client.deliver(1);
  await tick();
  await detector.check(); // manual second pass — watermark should suppress re-detection
  await tick();

  assert.strictEqual(detected.length, 1, 'message should be reported exactly once');

  detector.stop();
});

test('detector ignores the pre-existing backlog at start', async () => {
  const client = createFakeClient({
    uidNext: 3,
    messages: [
      {uid: 1, seen: false},
      {uid: 2, seen: false},
    ],
  });
  const detected = [];

  const detector = createNewMessageDetector({
    getClient: () => client,
    intervalMs: 100000,
    onNewMessages: (messages) => {
      detected.push(...messages);
    },
  });

  await detector.start();
  await detector.check();
  await tick();

  assert.strictEqual(detected.length, 0, 'existing unread mail must not be reported as new');

  detector.stop();
});

test('stop() detaches the listener so later arrivals are not reported', async () => {
  const client = createFakeClient({uidNext: 1});
  const detected = [];

  const detector = createNewMessageDetector({
    getClient: () => client,
    intervalMs: 100000,
    onNewMessages: (messages) => {
      detected.push(...messages);
    },
  });

  await detector.start();
  detector.stop();

  client.deliver(1);
  await tick();

  assert.strictEqual(detected.length, 0, 'no detection should occur after stop()');
});
