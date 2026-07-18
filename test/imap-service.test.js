const assert = require('node:assert');
const test = require('node:test');
const {EventEmitter} = require('node:events');

const {
  createImapService,
  getImapConfig,
  computeBackoffDelay,
} = require('../services/imap-service');

/**
 * Minimal stand-in for an ImapFlow client: an EventEmitter with connect()/logout().
 * `connectBehavior` lets a test make connect() resolve or reject.
 */
function createFakeClient(connectBehavior = async () => {}) {
  const client = new EventEmitter();
  client.connect = async () => connectBehavior(client);
  client.logout = async () => {
    client.emit('close');
  };
  return client;
}

const baseConfig = {host: 'imap.example.com', port: 993, user: 'intern@example.com', pass: 'app-password'};

test('getImapConfig throws a clear error when credentials are missing', () => {
  // Isolate from any ambient .env that dotenv may have loaded when the service
  // was imported, so this test does not depend on the developer's environment.
  const savedUser = process.env.IMAP_USER;
  const savedPass = process.env.IMAP_PASS;
  delete process.env.IMAP_USER;
  delete process.env.IMAP_PASS;

  try {
    assert.throws(() => getImapConfig({host: 'imap.example.com'}), /IMAP user is required/);
    assert.throws(() => getImapConfig({user: 'someone@example.com'}), /IMAP password is required/);
  } finally {
    if (savedUser === undefined) {
      delete process.env.IMAP_USER;
    } else {
      process.env.IMAP_USER = savedUser;
    }

    if (savedPass === undefined) {
      delete process.env.IMAP_PASS;
    } else {
      process.env.IMAP_PASS = savedPass;
    }
  }
});

test('computeBackoffDelay grows exponentially and is capped', () => {
  assert.strictEqual(computeBackoffDelay(1, {baseMs: 1000, maxMs: 30000}), 1000);
  assert.strictEqual(computeBackoffDelay(2, {baseMs: 1000, maxMs: 30000}), 2000);
  assert.strictEqual(computeBackoffDelay(4, {baseMs: 1000, maxMs: 30000}), 8000);
  assert.strictEqual(computeBackoffDelay(10, {baseMs: 1000, maxMs: 30000}), 30000);
});

// DoD #1: client connects successfully using injected/env credentials.
test('connect() authenticates and exposes the connected client', async () => {
  const created = [];
  const service = createImapService({
    config: baseConfig,
    clientFactory: () => {
      const client = createFakeClient();
      created.push(client);
      return client;
    },
  });

  const client = await service.connect();

  assert.strictEqual(created.length, 1);
  assert.strictEqual(service.getClient(), client);
  await service.disconnect();
});

// DoD #2: connection/auth errors are caught, logged, and surfaced (not swallowed).
test('connect() rejects when authentication fails', async () => {
  const service = createImapService({
    config: baseConfig,
    clientFactory: () => createFakeClient(async () => {
      throw new Error('Invalid credentials');
    }),
  });

  await assert.rejects(() => service.connect(), /Invalid credentials/);
  assert.strictEqual(service.getClient(), null);
});

// A failed *initial* connect must fail fast, not spin an auto-reconnect loop.
test('a failed initial connect does not trigger auto-reconnect', async () => {
  const created = [];
  const service = createImapService({
    config: baseConfig,
    baseDelayMs: 5,
    maxDelayMs: 5,
    clientFactory: () => {
      // Mimic imapflow: a failed connect both rejects and emits 'close'.
      const client = createFakeClient(async (c) => {
        c.emit('close');
        throw new Error('Invalid credentials');
      });
      created.push(client);
      return client;
    },
  });

  await assert.rejects(() => service.connect(), /Invalid credentials/);

  // Give any (incorrect) reconnect timer a chance to fire.
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.strictEqual(created.length, 1, 'no reconnect should be attempted after a failed initial connect');
});

// DoD #3: a dropped connection triggers a reconnect attempt.
test('an unexpected close triggers a reconnect', async () => {
  const created = [];
  const service = createImapService({
    config: baseConfig,
    baseDelayMs: 5, // keep the test fast
    maxDelayMs: 5,
    clientFactory: () => {
      const client = createFakeClient();
      created.push(client);
      return client;
    },
  });

  await service.connect();
  assert.strictEqual(created.length, 1);

  // Simulate the server dropping the connection.
  created[0].emit('close');

  // Wait past the backoff delay and let the reconnect happen.
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.strictEqual(created.length, 2, 'expected a new client to be created for the reconnect');
  await service.disconnect();
});

// disconnect() must be a clean shutdown: no reconnect after an intentional close.
test('disconnect() does not trigger a reconnect', async () => {
  const created = [];
  const service = createImapService({
    config: baseConfig,
    baseDelayMs: 5,
    maxDelayMs: 5,
    clientFactory: () => {
      const client = createFakeClient();
      created.push(client);
      return client;
    },
  });

  await service.connect();
  await service.disconnect(); // logout() emits 'close', but it was intentional

  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.strictEqual(created.length, 1, 'no reconnect should occur after an intentional disconnect');
});
