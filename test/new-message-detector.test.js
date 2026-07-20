const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs/promises');
const {EventEmitter} = require('node:events');
const MailComposer = require('nodemailer/lib/mail-composer');

const {
  findNewUnreadMessages,
  createNewMessageDetector,
  fetchMessageContent,
  loadProcessedUids,
  markProcessed,
  runListener,
} = require('../services/new-message-detector');

/**
 * Fake imapflow-like client backed by an in-memory message list.
 * Each message is {uid, seen, source?, envelope?}. `deliver()` simulates a new
 * arrival and fires 'exists'; `fetchOne` serves the raw source for messages that have one.
 */
function createFakeClient({uidNext = 1, messages = []} = {}) {
  const client = new EventEmitter();
  client.messages = messages.slice();
  client._uidNext = uidNext;
  client.mailbox = null;
  client.mailboxOpenCalls = [];

  client.mailboxOpen = async (mailbox) => {
    client.mailboxOpenCalls.push(mailbox);
    client.mailbox = {path: mailbox, exists: client.messages.length, uidNext: client._uidNext};
    return client.mailbox;
  };

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
        yield {uid: m.uid, envelope: m.envelope || {subject: `Subject ${m.uid}`, from: [{address: `sender${m.uid}@example.com`}]}};
      }
    }
  };

  client.fetchOne = async (uid) => {
    const found = client.messages.find((m) => m.uid === uid);
    if (!found) {
      return null;
    }
    return {uid, envelope: found.envelope, source: found.source};
  };

  client.deliver = (messageOrUid) => {
    const message = typeof messageOrUid === 'number' ? {uid: messageOrUid, seen: false} : {seen: false, ...messageOrUid};
    client._uidNext = Math.max(client._uidNext, message.uid + 1);
    client.messages.push(message);
    client.emit('exists', {path: 'INBOX', count: client.messages.length});
  };

  return client;
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/** Build a real raw RFC822 message buffer via nodemailer, for feeding into mailparser. */
function buildRawMessage({from, subject, text, html, attachments}) {
  const composer = new MailComposer({from, subject, text, html, attachments});
  return new Promise((resolve, reject) => {
    composer.compile().build((err, message) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
}

async function withTempStore(fn) {
  const storePath = `./.test-uids-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`;
  try {
    await fn(storePath);
  } finally {
    await fs.rm(storePath, {force: true});
    await fs.rm(`${storePath}.tmp`, {force: true});
  }
}

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

// --- KR 1.3 — full message fetch ---

test('fetchMessageContent returns sender, subject, body, and attachment buffers', async () => {
  const source = await buildRawMessage({
    from: 'ada@example.com',
    subject: 'Ada Lovelace - [SWE] Intern',
    text: 'plain body',
    html: '<p>html body</p>',
    attachments: [{filename: 'resume.pdf', content: Buffer.from('pdf-bytes'), contentType: 'application/pdf'}],
  });

  const client = createFakeClient({
    messages: [
      {
        uid: 101,
        envelope: {from: [{address: 'ada@example.com'}], subject: 'Ada Lovelace - [SWE] Intern'},
        source,
      },
    ],
  });

  const msg = await fetchMessageContent(client, 'INBOX', 101);

  assert.strictEqual(msg.uid, 101);
  assert.strictEqual(msg.sender, 'ada@example.com');
  assert.strictEqual(msg.subject, 'Ada Lovelace - [SWE] Intern');
  assert.strictEqual(msg.bodyText.trim(), 'plain body');
  assert.ok(msg.bodyHtml.includes('html body'));
  assert.strictEqual(msg.attachments.length, 1);
  assert.strictEqual(msg.attachments[0].filename, 'resume.pdf');
  assert.strictEqual(msg.attachments[0].mimeType, 'application/pdf');
  assert.ok(msg.attachments[0].content instanceof Buffer);
  assert.strictEqual(msg.attachments[0].content.toString(), 'pdf-bytes');
});

test('fetchMessageContent opens the mailbox first if it is not already selected', async () => {
  const source = await buildRawMessage({from: 'a@example.com', subject: 'A B - [X] Intern', text: 'hi'});
  const client = createFakeClient({
    messages: [{uid: 1, envelope: {from: [{address: 'a@example.com'}], subject: 'A B - [X] Intern'}, source}],
  });

  assert.strictEqual(client.mailboxOpenCalls.length, 0);
  await fetchMessageContent(client, 'INBOX', 1);
  assert.deepStrictEqual(client.mailboxOpenCalls, ['INBOX']);

  // A second fetch against the already-open mailbox should not reopen it.
  await fetchMessageContent(client, 'INBOX', 1);
  assert.deepStrictEqual(client.mailboxOpenCalls, ['INBOX']);
});

test('fetchMessageContent throws when the server has no message for the given uid', async () => {
  const client = createFakeClient({messages: []});
  await assert.rejects(() => fetchMessageContent(client, 'INBOX', 999));
});

// --- KR 1.4 — dedup ---

test('loadProcessedUids returns an empty set when the store is absent', async () => {
  await withTempStore(async (storePath) => {
    const set = await loadProcessedUids({storePath});
    assert.ok(set instanceof Set);
    assert.strictEqual(set.size, 0);
  });
});

test('markProcessed persists UIDs and is idempotent', async () => {
  await withTempStore(async (storePath) => {
    const inMemory = new Set();
    await markProcessed(101, {storePath, inMemory});
    await markProcessed(101, {storePath, inMemory});

    const reloaded = await loadProcessedUids({storePath});
    assert.deepStrictEqual([...reloaded], [101]);
    assert.deepStrictEqual([...inMemory], [101]);
  });
});

test('markProcessed does not leave a .tmp file behind', async () => {
  await withTempStore(async (storePath) => {
    await markProcessed(1, {storePath});
    await assert.rejects(() => fs.access(`${storePath}.tmp`));
  });
});

// --- KR 1.5 — listener integration ---

test('runListener connects, detects a new message, fetches its full content, and invokes the handler once', async () => {
  await withTempStore(async (storePath) => {
    const source = await buildRawMessage({
      from: 'ada@example.com',
      subject: 'Ada Lovelace - [SWE] Intern',
      text: 'hello',
      attachments: [{filename: 'resume.pdf', content: Buffer.from('pdf-bytes'), contentType: 'application/pdf'}],
    });
    const client = createFakeClient({uidNext: 101});

    let connectCalls = 0;
    const imapService = {
      connect: async () => { connectCalls += 1; },
      disconnect: async () => {},
      getClient: () => client,
    };

    const handled = [];
    const listener = await runListener(async (msg) => { handled.push(msg); }, {
      imapService,
      storePath,
      intervalMs: 100000,
    });

    assert.strictEqual(connectCalls, 1);

    client.deliver({uid: 101, source, envelope: {from: [{address: 'ada@example.com'}], subject: 'Ada Lovelace - [SWE] Intern'}});
    await tick();

    assert.strictEqual(handled.length, 1);
    assert.strictEqual(handled[0].sender, 'ada@example.com');
    assert.strictEqual(handled[0].attachments[0].filename, 'resume.pdf');

    const processed = await loadProcessedUids({storePath});
    assert.ok(processed.has(101));

    await listener.stop();
  });
});

test('runListener rejects when the initial connection fails', async () => {
  await withTempStore(async (storePath) => {
    const imapService = {
      connect: async () => { throw new Error('bad credentials'); },
      disconnect: async () => {},
      getClient: () => null,
    };

    await assert.rejects(
      () => runListener(async () => {}, {imapService, storePath}),
      /bad credentials/
    );
  });
});

test('runListener skips a uid that is already recorded in the persisted dedup store', async () => {
  await withTempStore(async (storePath) => {
    await markProcessed(5, {storePath});

    const source = await buildRawMessage({from: 'x@example.com', subject: 'X Y - [Z] Intern', text: 'hi'});
    const client = createFakeClient({uidNext: 1}); // uid 5 is not yet in the mailbox/backlog
    const imapService = {connect: async () => {}, disconnect: async () => {}, getClient: () => client};

    const handled = [];
    const listener = await runListener(async (msg) => { handled.push(msg); }, {
      imapService,
      storePath,
      intervalMs: 100000,
    });

    // Simulate this uid resurfacing via IDLE even though it was already processed in a prior run.
    client.deliver({uid: 5, source, envelope: {from: [{address: 'x@example.com'}], subject: 'X Y - [Z] Intern'}});
    await tick();

    assert.strictEqual(handled.length, 0, 'a uid already in the persisted store must not be handed to the handler again');

    await listener.stop();
  });
});

test('runListener.stop() stops the detector and disconnects the imap service', async () => {
  await withTempStore(async (storePath) => {
    const client = createFakeClient({uidNext: 1});
    let disconnectCalls = 0;
    const imapService = {
      connect: async () => {},
      disconnect: async () => { disconnectCalls += 1; },
      getClient: () => client,
    };

    const handled = [];
    const listener = await runListener(async (msg) => { handled.push(msg); }, {
      imapService,
      storePath,
      intervalMs: 100000,
    });

    await listener.stop();
    assert.strictEqual(disconnectCalls, 1);

    client.deliver(1);
    await tick();

    assert.strictEqual(handled.length, 0, 'no detection should occur after stop()');
  });
});
