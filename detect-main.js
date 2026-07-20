/**
 * detect-main.js
 *
 * Manual test runner for services/new-message-detector.js (Sprint 33 KR
 * "New-Message Detection Loop"). Connects using your .env credentials, starts the
 * hybrid IDLE + polling detector on INBOX, and logs each newly arrived unread message.
 *
 * Usage:
 *   node detect-main.js
 *
 * Then send an email to the mailbox in your .env and watch it get detected. Only mail
 * that arrives AFTER the detector starts is reported. Press Ctrl+C to exit.
 *
 * Optional env:
 *   DETECT_INTERVAL_MS  Polling safety-net interval in ms (default 30000).
 */

require('dotenv').config();

const {createImapService} = require('./services/imap-service');
const {createNewMessageDetector} = require('./services/new-message-detector');

async function main() {
  const imap = createImapService();

  try {
    await imap.connect();
  } catch (err) {
    console.error('Could not establish an IMAP connection:', err && err.message ? err.message : err);
    process.exitCode = 1;
    return;
  }

  const detector = createNewMessageDetector({
    getClient: () => imap.getClient(),
    intervalMs: Number(process.env.DETECT_INTERVAL_MS || 30000),
    onNewMessages: (messages) => {
      for (const message of messages) {
        const subject = message.envelope && message.envelope.subject ? message.envelope.subject : '(no subject)';
        const from =
          message.envelope && message.envelope.from && message.envelope.from[0]
            ? message.envelope.from[0].address
            : '(unknown sender)';
        console.log(`[detect-main] NEW unread message  uid=${message.uid}  from=${from}  subject="${subject}"`);
      }
    },
  });

  await detector.start();
  console.log('[detect-main] Detector running. Send an email to this mailbox to see it detected. Ctrl+C to exit.');

  process.on('SIGINT', async () => {
    console.log('\n[detect-main] Shutting down...');
    detector.stop();
    await imap.disconnect();
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[detect-main] Unexpected error:', err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}
