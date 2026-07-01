const assert = require('node:assert');
const test = require('node:test');

const { getShareLink } = require('../../services/google-drive-service');

test('getShareLink sets permission and returns webViewLink when available', async () => {
  const fakeFile = { id: 'file-1' };

  const fakeDrive = {
    files: {
      list: async () => ({ data: { files: [fakeFile] } }),
      get: async () => ({ data: { webViewLink: 'https://view', webContentLink: 'https://content' } }),
    },
    permissions: {
      list: async () => ({ data: { permissions: [] } }),
      create: async () => ({ data: {} }),
    },
  };

  const link = await getShareLink('Some/Path.txt', fakeDrive);
  assert.strictEqual(link, 'https://view');
});
