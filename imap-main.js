/**
 * imap-main.js
 *
 * Smoke-test runner for services/imap-service.js. Connects to the mailbox described
 * by your .env (IMAP_HOST/IMAP_PORT/IMAP_USER/IMAP_PASS), opens INBOX, prints a short
 * status line, then disconnects cleanly.
 *
 * Usage:
 *   node imap-main.js            Connect, report INBOX status, exit.
 *   node imap-main.js --watch    Stay connected until Ctrl+C. Useful for manually
 *                                testing reconnect-on-drop: disable your network for a
 *                                few seconds and watch the service reconnect on its own.
 *
 * For testing, point .env at a spare Gmail (see .env.example). Production will use
 * careers@qpulse.tech on Titan once credentials are available.
 */

require('dotenv').config();

const {createImapService} = require('./services/imap-service');

async function main() {
  const watch = process.argv.includes('--watch');

  let imap;
  try {
    imap = createImapService();
  } catch (err) {
    console.error(err.message);
    console.error('Set IMAP_USER and IMAP_PASS in your .env before running (see .env.example).');
    process.exitCode = 2;
    return;
  }

  try {
    await imap.connect();
  } catch (err) {
    console.error('Could not establish an IMAP connection:', err && err.message ? err.message : err);
    process.exitCode = 1;
    return;
  }

  const client = imap.getClient();

  try {
    const mailbox = await client.mailboxOpen('INBOX');
    console.log(`Opened INBOX successfully: ${mailbox.exists} message(s) present.`);
  } catch (err) {
    console.error('Connected, but failed to open INBOX:', err && err.message ? err.message : err);
  }

  if (watch) {
    console.log('Staying connected (--watch). Press Ctrl+C to exit.');
    console.log('Tip: drop your network for a few seconds to see reconnect-on-drop in action.');

    process.on('SIGINT', async () => {
      console.log('\nShutting down...');
      await imap.disconnect();
      process.exit(0);
    });

    return; // Keep the process alive; the service manages the connection.
  }

  await imap.disconnect();
  console.log('Done.');
}

if (require.main === module) {
  main();
}
