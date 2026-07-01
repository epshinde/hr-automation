const assert = require('node:assert');
const test = require('node:test');

const { listMatchingDriveItems } = require('../../services/google-drive-service');

test('listMatchingDriveItems returns files from drive.files.list', async () => {
  const fakeDrive = {
    files: {
      list: async (opts) => ({ data: { files: [{ id: '1', name: opts.q } ] } }),
    },
  };

  const files = await listMatchingDriveItems(fakeDrive, { parentId: 'root', name: "a'b", mimeType: 'text/plain' });
  assert.strictEqual(Array.isArray(files), true);
  assert.strictEqual(files[0].id, '1');
});
