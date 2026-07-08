/**
 * coda-main.js
 *
 * Example CLI script demonstrating how to use the services/coda-service.js helpers.
 * Insert your Coda document ID, table ID (or name), and API token in the placeholders
 * below or set `CODA_API_TOKEN` in your environment.
 *
 * Usage:
 *   node coda-main.js
 */

// Load environment variables from a .env file when available (optional).
// This is safe if `dotenv` is not installed — it will be ignored.
try {
  require('dotenv').config();
} catch (e) {
  // dotenv not installed; continue without failing.
}

const {
  listTableRows,
  addRowToTable,
  findUniqueRowByLookup,
  updateRowInTableByLookup,
} = require('./services/coda-service');

// === INSERT VALUES HERE ===
// Replace the placeholder strings with your real values, or set CODA_API_TOKEN env var.
const DOC_ID = 'znHlnY8bOW'; // <-- insert your Coda document id here
const TABLE_ID = 'grid-A-Yqj5FV19'; // <-- insert your table id or table name here
const API_TOKEN = process.env.CODA_API_TOKEN || 'REPLACE_WITH_YOUR_API_TOKEN'; // <-- insert your API token here or set CODA_API_TOKEN
// ===========================

async function main() {
  if (!DOC_ID || DOC_ID.includes('REPLACE')) {
    console.error('Please set DOC_ID at the top of this file.');
    process.exitCode = 2;
    return;
  }

  if (!TABLE_ID || TABLE_ID.includes('REPLACE')) {
    console.error('Please set TABLE_ID at the top of this file.');
    process.exitCode = 2;
    return;
  }

  if (!API_TOKEN || API_TOKEN.includes('REPLACE')) {
    console.error('Please set API_TOKEN (or export CODA_API_TOKEN) before running.');
    process.exitCode = 2;
    return;
  }

  try {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));

    // Prepare 10 rows with columns: Name, Role, Skills, Resume
    const rowsToAdd = Array.from({length: 10}, (_, i) => {
      const n = i + 1;
      return {
        Name: `Candidate ${n}`,
        Role: `Role ${((n - 1) % 4) + 1}`,
        Skills: ['JavaScript', 'Node.js', 'APIs'].slice(0, (n % 3) + 1).join(', '),
        Resume: `https://example.com/resume/candidate-${n}`,
      };
    });

    // Add ten rows, waiting 2s between each call
    console.log('Adding 10 rows...');
    for (const rowValues of rowsToAdd) {
      const res = await addRowToTable(DOC_ID, TABLE_ID, rowValues, { apiToken: API_TOKEN });
      console.log('Added:', JSON.stringify(res));
      await wait(2000);
    }

    // List all rows (request a generous limit)
    console.log('\nListing rows...');
    const listRes = await listTableRows(DOC_ID, TABLE_ID, { apiToken: API_TOKEN, limit: 100, useColumnNames: true });
    console.log(JSON.stringify(listRes, null, 2));
    await wait(2000);

    // Use findUniqueRowByLookup for Candidate 3 (by Name)
    console.log('\nLooking up Candidate 3 by Name...');
    const found = await findUniqueRowByLookup(DOC_ID, TABLE_ID, 'Name', 'Candidate 3', { apiToken: API_TOKEN, useColumnNames: true });
    console.log('Found row:', JSON.stringify(found, null, 2));
    await wait(2000);

    // Update Candidate 5 (different from Candidate 3) by Name
    console.log('\nUpdating Candidate 5 by Name...');
    const updated = await updateRowInTableByLookup(DOC_ID, TABLE_ID, 'Name', 'Candidate 5', { Role: 'Lead Engineer', Skills: 'Node.js, AWS' }, { apiToken: API_TOKEN });
    console.log('Update response:', JSON.stringify(updated, null, 2));
    await wait(2000);

    console.log('\nDone.');
  } catch (err) {
    console.error('Coda request error:', err);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
