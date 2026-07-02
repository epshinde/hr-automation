const assert = require('node:assert');
const test = require('node:test');

const {
  addRowToTable,
  findUniqueRowByLookup,
  formatColumnReferenceForQuery,
  updateRowInTableByLookup,
} = require('../services/coda-service');

test('addRowToTable posts a row payload with column names', async () => {
  const requests = [];

  const fakeFetch = async (url, options) => {
    requests.push({url: String(url), options});

    return {
      ok: true,
      json: async () => ({requestId: 'req-1', addedRowIds: ['row-1']}),
      text: async () => '',
    };
  };

  const result = await addRowToTable('doc-1', 'table-1', {Name: 'Ava', Status: 'Active'}, {
    apiToken: 'token-1',
    fetchImpl: fakeFetch,
  });

  assert.deepStrictEqual(result, {requestId: 'req-1', addedRowIds: ['row-1']});
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].url, 'https://coda.io/apis/v1/docs/doc-1/tables/table-1/rows');
  assert.strictEqual(requests[0].options.method, 'POST');
  assert.strictEqual(requests[0].options.headers.Authorization, 'Bearer token-1');
  assert.deepStrictEqual(JSON.parse(requests[0].options.body), {
    rows: [
      {
        cells: [
          {column: 'Name', value: 'Ava'},
          {column: 'Status', value: 'Active'},
        ],
      },
    ],
  });
});

test('updateRowInTableByLookup finds one row and updates it', async () => {
  const requests = [];

  const fakeFetch = async (url, options = {}) => {
    requests.push({url: String(url), options});

    if (String(url).includes('/rows?')) {
      return {
        ok: true,
        json: async () => ({items: [{id: 'row-9', values: {Name: 'Ava'}}]}),
        text: async () => '',
      };
    }

    return {
      ok: true,
      json: async () => ({requestId: 'req-2', id: 'row-9'}),
      text: async () => '',
    };
  };

  const result = await updateRowInTableByLookup('doc-1', 'table-1', 'Name', 'Ava', {Status: 'Inactive'}, {
    apiToken: 'token-1',
    fetchImpl: fakeFetch,
    useColumnNames: true,
  });

  assert.deepStrictEqual(result, {requestId: 'req-2', id: 'row-9'});
  assert.strictEqual(requests.length, 2);
  assert.strictEqual(requests[0].url, 'https://coda.io/apis/v1/docs/doc-1/tables/table-1/rows?query=%22Name%22%3A%22Ava%22&limit=2&useColumnNames=true');
  assert.strictEqual(requests[0].options.method, 'GET');
  assert.strictEqual(requests[1].url, 'https://coda.io/apis/v1/docs/doc-1/tables/table-1/rows/row-9');
  assert.strictEqual(requests[1].options.method, 'PUT');
  assert.deepStrictEqual(JSON.parse(requests[1].options.body), {
    row: {
      cells: [{column: 'Status', value: 'Inactive'}],
    },
  });
});

test('findUniqueRowByLookup rejects ambiguous matches', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({items: [{id: 'row-1'}, {id: 'row-2'}]}),
    text: async () => '',
  });

  await assert.rejects(
    () => findUniqueRowByLookup('doc-1', 'table-1', 'Name', 'Ava', {apiToken: 'token-1', fetchImpl: fakeFetch}),
    /Multiple rows found/,
  );
});

test('formatColumnReferenceForQuery preserves ids and quotes names', () => {
  assert.strictEqual(formatColumnReferenceForQuery('c-tuVwxYz'), 'c-tuVwxYz');
  assert.strictEqual(formatColumnReferenceForQuery('Employee Name'), '"Employee Name"');
});