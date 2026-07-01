const assert = require('node:assert');
const test = require('node:test');

const { normalizeDrivePath } = require('../../services/google-drive-service');

test('normalizeDrivePath splits and trims path segments', () => {
  const input = " /foo\\bar/ baz //qux/ ";
  const out = normalizeDrivePath(input);
  assert.deepStrictEqual(out, ['foo', 'bar', 'baz', 'qux']);
});

test('normalizeDrivePath throws for non-string', () => {
  assert.throws(() => normalizeDrivePath(null), { name: 'TypeError' });
});
