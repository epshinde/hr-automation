const {ImapFlow} = require('imapflow');
require('dotenv').config();

/**
 * Brief Summary: Resolve and validate IMAP connection settings from overrides or the environment.
 *
 * Parameters (Arguments):
 * - overrides (Object, optional): Explicit settings that take precedence over env vars.
 *   - host (string, optional): IMAP host. Falls back to IMAP_HOST, then 'imap.gmail.com'.
 *   - port (number|string, optional): IMAP port. Falls back to IMAP_PORT, then 993.
 *   - user (string, optional): Login user. Falls back to IMAP_USER.
 *   - pass (string, optional): Login password / app password. Falls back to IMAP_PASS.
 *   - secure (boolean, optional): Use implicit TLS. Falls back to IMAP_TLS, then (port === 993).
 *
 * Returns: Object - { host, port, user, pass, secure } ready to hand to the client factory.
 *
 * Raises / Errors: Throws Error when no user or password can be resolved.
 *
 * Examples:
 * const config = getImapConfig();                 // all from env
 * const config = getImapConfig({host: 'imap.titan.email'});
 */
function getImapConfig(overrides = {}) {
  const host = overrides.host || process.env.IMAP_HOST || 'imap.gmail.com';
  const port = Number(overrides.port || process.env.IMAP_PORT || 993);
  const user = overrides.user || process.env.IMAP_USER;
  const pass = overrides.pass || process.env.IMAP_PASS;

  let secure;
  if (overrides.secure !== undefined) {
    secure = overrides.secure;
  } else if (process.env.IMAP_TLS !== undefined) {
    secure = process.env.IMAP_TLS !== 'false';
  } else {
    secure = port === 993;
  }

  if (!user) {
    throw new Error('An IMAP user is required. Set IMAP_USER in your environment or pass it explicitly.');
  }

  if (!pass) {
    throw new Error('An IMAP password is required. Set IMAP_PASS in your environment or pass it explicitly.');
  }

  return {host, port, user, pass, secure};
}

/**
 * Brief Summary: Compute an exponential-backoff delay (in ms) for a given reconnect attempt.
 *
 * Parameters (Arguments):
 * - attempt (number, required): 1-based attempt number (1 for the first retry).
 * - options (Object, optional):
 *   - baseMs (number, optional): Delay for the first attempt (default: 1000).
 *   - maxMs (number, optional): Upper cap on the delay (default: 30000).
 *
 * Returns: number - Delay in milliseconds, capped at maxMs.
 *
 * Raises / Errors: None.
 *
 * Examples:
 * computeBackoffDelay(1); // 1000
 * computeBackoffDelay(4); // 8000
 */
function computeBackoffDelay(attempt, {baseMs = 1000, maxMs = 30000} = {}) {
  const delay = baseMs * 2 ** (attempt - 1);
  return Math.min(delay, maxMs);
}

/**
 * Brief Summary: Default client factory — builds a real ImapFlow client from a resolved config.
 *
 * Parameters (Arguments):
 * - config (Object, required): The object returned by getImapConfig.
 *
 * Returns: ImapFlow - An unconnected ImapFlow client instance.
 *
 * Raises / Errors: None (construction only; connection happens later).
 */
function defaultClientFactory(config) {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {user: config.user, pass: config.pass},
    logger: false,
  });
}

/**
 * Brief Summary: Create a self-healing IMAP service that connects, authenticates, logs errors,
 * and automatically reconnects (with exponential backoff) when the connection drops.
 *
 * Parameters (Arguments):
 * - options (Object, optional):
 *   - config (Object, optional): Overrides passed to getImapConfig (host/port/user/pass/secure).
 *   - clientFactory (function, optional): (config) => client. Injected for testing so no real
 *     server is required. Defaults to defaultClientFactory (real ImapFlow).
 *   - maxReconnectAttempts (number, optional): Give up after this many consecutive failed
 *     reconnects (default: 5). Use Infinity to retry forever.
 *   - baseDelayMs (number, optional): First backoff delay in ms (default: 1000).
 *   - maxDelayMs (number, optional): Backoff cap in ms (default: 30000).
 *
 * Returns: Object - { connect, disconnect, getClient }.
 *   - connect(): Promise<client> - Resolves once connected and authenticated.
 *   - disconnect(): Promise<void> - Intentional shutdown; disables auto-reconnect and logs out.
 *   - getClient(): client|null - The current underlying client, or null before connect.
 *
 * Raises / Errors: connect() rejects (after logging) when the initial connect/auth fails.
 * Asynchronous drops are handled by auto-reconnect rather than by throwing.
 *
 * Examples:
 * const imap = createImapService();
 * await imap.connect();
 * // ... use imap.getClient() ...
 * await imap.disconnect();
 */
function createImapService(options = {}) {
  const config = getImapConfig(options.config || {});
  const clientFactory = options.clientFactory || defaultClientFactory;
  const maxReconnectAttempts = options.maxReconnectAttempts === undefined ? 5 : options.maxReconnectAttempts;
  const baseDelayMs = options.baseDelayMs || 1000;
  const maxDelayMs = options.maxDelayMs || 30000;

  let currentClient = null;
  let intentionalDisconnect = false;
  let reconnecting = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let connectedAtLeastOnce = false;

  /**
   * Build a client, wire up its error/close handlers, and connect + authenticate.
   * Throws (after logging) when the connect/auth call fails.
   */
  async function establishConnection() {
    const client = clientFactory(config);

    // Long-lived connections surface problems as async events, not just a rejected connect().
    client.on('error', (err) => {
      console.error('[imap-service] Client error:', err && err.message ? err.message : err);
    });

    client.on('close', () => {
      // Only auto-reconnect after at least one successful connection. A failed
      // initial connect is surfaced to the caller instead of looping forever
      // (e.g. a bad password would otherwise retry indefinitely).
      if (intentionalDisconnect || !connectedAtLeastOnce) {
        return;
      }
      console.error('[imap-service] Connection closed unexpectedly; attempting to reconnect.');
      scheduleReconnect();
    });

    try {
      await client.connect();
    } catch (err) {
      console.error('[imap-service] Failed to connect/authenticate:', err && err.message ? err.message : err);
      throw err;
    }

    currentClient = client;
    reconnectAttempts = 0;
    connectedAtLeastOnce = true;
    console.log(`[imap-service] Connected to ${config.host}:${config.port} as ${config.user}.`);
    return client;
  }

  /**
   * Schedule a single backoff-delayed reconnect. Idempotent: overlapping calls (e.g. both
   * 'error' and 'close' firing for one drop) collapse into one in-flight reconnect.
   */
  function scheduleReconnect() {
    if (reconnecting) {
      return;
    }
    reconnecting = true;
    reconnectAttempts += 1;

    if (maxReconnectAttempts !== Infinity && reconnectAttempts > maxReconnectAttempts) {
      console.error(`[imap-service] Giving up after ${maxReconnectAttempts} reconnect attempts.`);
      reconnecting = false;
      return;
    }

    const delay = computeBackoffDelay(reconnectAttempts, {baseMs: baseDelayMs, maxMs: maxDelayMs});
    console.log(`[imap-service] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}).`);

    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try {
        await establishConnection();
        reconnecting = false;
      } catch (err) {
        // establishConnection already logged the cause; back off and try again.
        reconnecting = false;
        scheduleReconnect();
      }
    }, delay);

    // Don't let a pending reconnect timer keep the process alive on its own.
    if (reconnectTimer && typeof reconnectTimer.unref === 'function') {
      reconnectTimer.unref();
    }
  }

  async function connect() {
    intentionalDisconnect = false;
    reconnectAttempts = 0;
    connectedAtLeastOnce = false;
    return establishConnection();
  }

  async function disconnect() {
    intentionalDisconnect = true;
    reconnecting = false;

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (currentClient) {
      try {
        await currentClient.logout();
      } catch (err) {
        console.error('[imap-service] Error during logout:', err && err.message ? err.message : err);
      }
    }
  }

  function getClient() {
    return currentClient;
  }

  return {connect, disconnect, getClient};
}

/**
 * Public API exposed by this module.
 */
module.exports = {
  // public API
  createImapService,
  getImapConfig,
  // helpers (exported for testing)
  computeBackoffDelay,
  defaultClientFactory,
};

if (require.main === module) {
  console.log('IMAP service loaded. Import createImapService from this module.');
}
