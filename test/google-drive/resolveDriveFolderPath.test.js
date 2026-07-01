const assert = require('node:assert');
const test = require('node:test');

const { resolveDriveFolderPath } = require('../../services/google-drive-service');

test('resolveDriveFolderPath returns root for empty path', async () => {
  const fakeDrive = {};
  const id = await resolveDriveFolderPath(fakeDrive, '');
  assert.strictEqual(id, 'root');
});

test('resolveDriveFolderPath returns existing folder id', async () => {
  const fakeDrive = {
    files: {
      list: async (opts) => ({ data: { files: [{ id: 'fld-1', name: opts.q }] } }),
    },
  };

  const id = await resolveDriveFolderPath(fakeDrive, 'Foo');
  assert.strictEqual(id, 'fld-1');
});

test('resolveDriveFolderPath creates missing folder when requested', async () => {
  let created = false;
  const fakeDrive = {
    files: {
      list: async () => ({ data: { files: [] } }),
      create: async (opts) => {
        created = true;
        return { data: { id: 'new-folder' } };
      },
    },
  };

  const id = await resolveDriveFolderPath(fakeDrive, 'NewFolder', { createMissing: true });
  assert.strictEqual(created, true);
  assert.strictEqual(id, 'new-folder');
});
