const assert = require('node:assert');
const test = require('node:test');

const { resolveDriveFileByPath } = require('../../services/google-drive-service');

test('resolveDriveFileByPath throws when path empty', async () => {
  const fakeDrive = {};
  await assert.rejects(() => resolveDriveFileByPath(fakeDrive, ''), { message: 'Drive file path is required.' });
});

test('resolveDriveFileByPath returns file when found', async () => {
  const fakeDrive = {
    files: {
      list: async (opts) => ({ data: { files: [{ id: 'f-1', name: opts.q }] } }),
      create: async () => ({ data: {} }),
    },
  };

  const file = await resolveDriveFileByPath(fakeDrive, 'Folder/File.txt');
  assert.strictEqual(file.id, 'f-1');
});
