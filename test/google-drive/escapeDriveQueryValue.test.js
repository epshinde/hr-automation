const assert = require('node:assert');
const test = require('node:test');

const { escapeDriveQueryValue } = require('../../services/google-drive-service');

test('escapeDriveQueryValue escapes backslashes and single quotes', () => {
  const input = "O\\'Reilly\\Books";
  const out = escapeDriveQueryValue(input);
  assert.ok(out.includes("\\'"), 'should escape single quote');
  assert.ok(out.includes('\\\\'), 'should escape backslash');
});
