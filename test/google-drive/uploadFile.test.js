const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { uploadFile } = require('../../services/google-drive-service');

test('uploadFile uploads local file and returns metadata', async () => {
  const tmp = path.join(__dirname, 'tmp-upload.txt');
  fs.writeFileSync(tmp, 'hello');

  const fakeDrive = {
    files: {
      create: async (opts) => {
        // consume stream if present to avoid async file activity after test end
        if (opts.media && opts.media.body && typeof opts.media.body.on === 'function') {
          await new Promise((resolve, reject) => {
            const chunks = [];
            opts.media.body.on('data', (c) => chunks.push(c));
            opts.media.body.on('end', () => resolve(Buffer.concat(chunks)));
            opts.media.body.on('error', reject);
          });
        }

        return { data: { id: 'uploaded-1', name: opts.requestBody.name } };
      },
    },
  };

  const meta = await uploadFile(tmp, '', { fileName: 'my.txt' }, fakeDrive);
  assert.strictEqual(meta.id, 'uploaded-1');
  fs.unlinkSync(tmp);
});
