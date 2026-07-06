const DEFAULT_API_BASE_URL = 'https://coda.io/apis/v1/';

/**
 * Brief Summary: Return the Coda API token from options or the environment.
 *
 * Parameters (Arguments):
 * - options (Object, optional): Options object.
 *   - apiToken (string, optional): Explicit API token to use. If omitted the
 *     function will fall back to the environment variable `CODA_API_TOKEN`.
 *
 * Returns: string - The API token to use, or an empty string if none found.
 *
 * Raises / Errors: None.
 *
 * Examples:
 * const token = getCodaApiToken({ apiToken: 'MY_TOKEN' });
 */
function getCodaApiToken(options = {}) {
	return options.apiToken || process.env.CODA_API_TOKEN || '';
}

/**
 * Brief Summary: Heuristically determine whether a value looks like a Coda ID.
 *
 * Parameters (Arguments):
 * - value (any): The value to test (typically a string).
 *
 * Returns: boolean - True when the value matches the expected Coda ID pattern.
 *
 * Raises / Errors: None.
 *
 * Examples:
 * isLikelyCodaId('doc-abc123'); // true
 */
function isLikelyCodaId(value) {
	return typeof value === 'string' && /^[a-z]+-[A-Za-z0-9_-]+$/.test(value);
}

/**
 * Brief Summary: Format a column reference for use in a Coda query string.
 *
 * Parameters (Arguments):
 * - columnReference (string): The column reference or name. Must be a non-empty string.
 *
 * Returns: string - If the value looks like a Coda ID it is returned as-is;
 * otherwise the value is JSON-stringified (so column names with spaces are quoted).
 *
 * Raises / Errors: Throws Error when `columnReference` is not a non-empty string.
 *
 * Examples:
 * formatColumnReferenceForQuery('colName'); // '"colName"' or col-id if Coda id
 */
function formatColumnReferenceForQuery(columnReference) {
	if (typeof columnReference !== 'string' || !columnReference.trim()) {
		throw new Error('Column reference is required.');
	}

	return isLikelyCodaId(columnReference) ? columnReference : JSON.stringify(columnReference);
}

/**
 * Brief Summary: Convert a value to a JSON string suitable for Coda query values.
 *
 * Parameters (Arguments):
 * - value (any): The value to format. Can be a string, number, boolean, object, etc.
 *
 * Returns: string - The JSON-stringified representation of the value.
 *
 * Raises / Errors: Any error thrown by `JSON.stringify` for unsupported values.
 *
 * Examples:
 * formatQueryValue('Alice'); // '"Alice"'
 */
function formatQueryValue(value) {
	return JSON.stringify(value);
}

/**
 * Brief Summary: Build an array of cell objects suitable for Coda row APIs.
 *
 * Parameters (Arguments):
 * - values (Object|Array, required): Either an object mapping column->value
 *   or an array of cell objects of the shape { column: <idOrName>, value: <any> }.
 *
 * Returns: Array<Object> - An array of cell objects: [{ column, value }, ...].
 *
 * Raises / Errors: Throws TypeError when `values` is null or not an object/array.
 *
 * Examples:
 * buildRowCells({ Name: 'Alice', Age: 30 });
 * buildRowCells([{ column: 'Name', value: 'Alice' }]);
 */
function buildRowCells(values) {
	if (Array.isArray(values)) {
		return values.map((cell) => ({
			column: cell.column,
			value: cell.value,
		}));
	}

	if (values === null || typeof values !== 'object') {
		throw new TypeError('Row values must be provided as an object or an array of cell objects.');
	}

	return Object.entries(values).map(([column, value]) => ({
		column,
		value,
	}));
}

/**
 * Brief Summary: Create a full URL (URL object) for a Coda API request.
 *
 * Parameters (Arguments):
 * - pathname (string|number, required): Path relative to the Coda API base (e.g. '/docs/ID').
 * - queryParams (Object, optional): A map of query parameter keys to values. Parameters
 *   with `undefined`, `null`, or empty-string values are omitted.
 *
 * Returns: URL - A URL object representing the full request URL (including query string).
 *
 * Raises / Errors: May throw if `new URL()` is given invalid input.
 *
 * Examples:
 * const url = createCodaRequestUrl('/docs/abc/tables/myTable/rows', { limit: 25 });
 */
function createCodaRequestUrl(pathname, queryParams = {}) {
	const normalizedPathname = String(pathname).replace(/^\//, '');
	const url = new URL(normalizedPathname, DEFAULT_API_BASE_URL);

	for (const [key, value] of Object.entries(queryParams)) {
		if (value === undefined || value === null || value === '') {
			continue;
		}

		url.searchParams.set(key, String(value));
	}

	return url;
}

/**
 * Brief Summary: Send an HTTP request to the Coda API and return the parsed JSON.
 *
 * Parameters (Arguments):
 * - pathname (string, required): API path relative to the base (e.g. '/docs/ID/tables/...').
 * - options (Object, optional): Request options.
 *   - method (string, optional): HTTP method (default: 'GET').
 *   - apiToken (string, optional): API token to use; falls back to CODA_API_TOKEN.
 *   - fetchImpl (function, optional): Fetch-compatible implementation to perform the request.
 *     Defaults to `globalThis.fetch`. The function signature must be (input, init) => Promise<Response>.
 *   - body (any, optional): Request body (will be JSON-stringified when present).
 *   - queryParams (Object, optional): Query parameters to include in the URL.
 *
 * Returns: Promise<any> - Resolves to the parsed JSON response body.
 *
 * Raises / Errors: Throws Error when:
 * - `fetchImpl` is not a function.
 * - No API token is available.
 * - The HTTP response has a non-OK status (response.ok === false). The thrown Error includes status and body.
 *
 * Examples:
 * // Using global fetch (browser or Node >= 18)
 * await sendCodaRequest('/docs/ID/tables/TABLE/rows', { apiToken: 'TOKEN' });
 *
 * // Using a provided fetch implementation (e.g. undici)
 * const { fetch } = require('undici');
 * await sendCodaRequest('/docs/ID', { fetchImpl: fetch, apiToken: 'TOKEN' });
 */
async function sendCodaRequest(pathname, {method = 'GET', apiToken, fetchImpl = globalThis.fetch, body, queryParams = {}} = {}) {
	if (typeof fetchImpl !== 'function') {
		throw new Error('A fetch implementation is required to call the Coda API.');
	}

	const token = getCodaApiToken({apiToken});

	if (!token) {
		throw new Error('A Coda API token is required. Set CODA_API_TOKEN or pass apiToken explicitly.');
	}

	const url = createCodaRequestUrl(pathname, queryParams);
	const response = await fetchImpl(url, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			...(body ? {'Content-Type': 'application/json'} : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Coda API request failed with status ${response.status}${errorBody ? `: ${errorBody}` : ''}`);
	}

	return response.json();
}

/**
 * Brief Summary: List rows from a table in a Coda document.
 *
 * Parameters (Arguments):
 * - docId (string, required): The ID of the Coda document.
 * - tableIdOrName (string, required): The table ID or table name.
 * - options (Object, optional): Additional options.
 *   - apiToken (string, optional): API token to use for the request.
 *   - fetchImpl (function, optional): Fetch-compatible implementation to use.
 *   - query (string, optional): A Coda query string to filter rows.
 *   - limit (number, optional): Maximum number of rows to return.
 *   - useColumnNames (boolean, optional): Return rows using column names rather than IDs.
 *   - valueFormat (string, optional): Value format to request from the API.
 *   - visibleOnly (boolean, optional): Whether to include only visible rows.
 *
 * Returns: Promise<Object> - The parsed JSON response from the Coda API (usually contains items array).
 *
 * Raises / Errors: Throws Error when `docId` or `tableIdOrName` are not provided, or when
 * the underlying request fails (see sendCodaRequest errors).
 *
 * Examples:
 * await listTableRows('docId', 'Table 1', { limit: 50 });
 */
async function listTableRows(docId, tableIdOrName, options = {}) {
	if (!docId) {
		throw new Error('Coda doc ID is required.');
	}

	if (!tableIdOrName) {
		throw new Error('Coda table ID or name is required.');
	}

	return sendCodaRequest(`/docs/${docId}/tables/${tableIdOrName}/rows`, {
		method: 'GET',
		apiToken: options.apiToken,
		fetchImpl: options.fetchImpl,
		queryParams: {
			query: options.query,
			limit: options.limit,
			useColumnNames: options.useColumnNames,
			valueFormat: options.valueFormat,
			visibleOnly: options.visibleOnly,
		},
	});
}

/**
 * Brief Summary: Add a new row to a table in a Coda document.
 *
 * Parameters (Arguments):
 * - docId (string, required): The ID of the Coda document.
 * - tableIdOrName (string, required): The table ID or table name.
 * - values (Object|Array, required): Row values as an object mapping column->value
 *   or as an array of cell objects. See buildRowCells for accepted shapes.
 * - options (Object, optional): Additional request options.
 *   - apiToken (string, optional): API token to use for the request.
 *   - fetchImpl (function, optional): Fetch-compatible implementation to use.
 *   - disableParsing (boolean, optional): Query param passed to Coda to disable parsing.
 *   - keyColumns (Array<string>, optional): Key columns to identify rows when upserting.
 *
 * Returns: Promise<any> - The parsed JSON response from the Coda API for the created row(s).
 *
 * Raises / Errors: Errors from sendCodaRequest or buildRowCells (TypeError for invalid values).
 *
 * Examples:
 * await addRowToTable('docId', 'Table 1', { Name: 'Bob', Age: 25 });
 */
async function addRowToTable(docId, tableIdOrName, values, options = {}) {
	return sendCodaRequest(`/docs/${docId}/tables/${tableIdOrName}/rows`, {
		method: 'POST',
		apiToken: options.apiToken,
		fetchImpl: options.fetchImpl,
		queryParams: {
			disableParsing: options.disableParsing,
		},
		body: {
			rows: [{cells: buildRowCells(values)}],
			...(options.keyColumns && options.keyColumns.length ? {keyColumns: options.keyColumns} : {}),
		},
	});
}

/**
 * Brief Summary: Find a single unique row by looking up a column/value pair.
 *
 * Parameters (Arguments):
 * - docId (string, required): The ID of the Coda document.
 * - tableIdOrName (string, required): The table ID or table name.
 * - matchColumn (string, required): Column reference or name to match against.
 * - matchValue (any, required): Value to match in the column.
 * - options (Object, optional): Additional options forwarded to listTableRows.
 *
 * Returns: Promise<Object> - The single matching row object when found.
 *
 * Raises / Errors: Throws Error when no rows match or when multiple rows match.
 * Also propagates any errors from listTableRows/sendCodaRequest.
 *
 * Examples:
 * await findUniqueRowByLookup('docId', 'Table 1', 'Email', 'a@example.com');
 */
async function findUniqueRowByLookup(docId, tableIdOrName, matchColumn, matchValue, options = {}) {
	const query = `${formatColumnReferenceForQuery(matchColumn)}:${formatQueryValue(matchValue)}`;
	const result = await listTableRows(docId, tableIdOrName, {
		...options,
		query,
		limit: 2,
		useColumnNames: options.useColumnNames,
	});
	const rows = result.items || [];

	if (rows.length === 0) {
		throw new Error(`No row found in table ${tableIdOrName} where ${String(matchColumn)} matches ${String(matchValue)}.`);
	}

	if (rows.length > 1) {
		throw new Error(`Multiple rows found in table ${tableIdOrName} where ${String(matchColumn)} matches ${String(matchValue)}.`);
	}

	return rows[0];
}

/**
 * Brief Summary: Update a row found by a column/value lookup in a table.
 *
 * Parameters (Arguments):
 * - docId (string, required): The ID of the Coda document.
 * - tableIdOrName (string, required): The table ID or table name.
 * - matchColumn (string, required): Column reference or name to match against.
 * - matchValue (any, required): Value to match in the column.
 * - values (Object|Array, required): New cell values for the row (object or array form accepted).
 * - options (Object, optional): Additional options forwarded to requests.
 *   - apiToken (string, optional)
 *   - fetchImpl (function, optional)
 *   - disableParsing (boolean, optional)
 *
 * Returns: Promise<any> - The parsed JSON response from the Coda API for the updated row.
 *
 * Raises / Errors: Throws if the lookup yields no rows or multiple rows (see findUniqueRowByLookup),
 * or if the underlying request fails.
 *
 * Examples:
 * await updateRowInTableByLookup('docId', 'Table 1', 'Email', 'a@example.com', { Name: 'Updated' });
 */
async function updateRowInTableByLookup(docId, tableIdOrName, matchColumn, matchValue, values, options = {}) {
	const matchedRow = await findUniqueRowByLookup(docId, tableIdOrName, matchColumn, matchValue, options);

	return sendCodaRequest(`/docs/${docId}/tables/${tableIdOrName}/rows/${matchedRow.id}`, {
		method: 'PUT',
		apiToken: options.apiToken,
		fetchImpl: options.fetchImpl,
		queryParams: {
			disableParsing: options.disableParsing,
		},
		body: {
			row: {
				cells: buildRowCells(values),
			},
		},
	});
}

module.exports = {
	addRowToTable,
	buildRowCells,
	findUniqueRowByLookup,
	formatColumnReferenceForQuery,
	formatQueryValue,
	isLikelyCodaId,
	listTableRows,
	sendCodaRequest,
	updateRowInTableByLookup,
};

if (require.main === module) {
	console.log('Coda service loaded. Import addRowToTable or updateRowInTableByLookup from this module.');
}
