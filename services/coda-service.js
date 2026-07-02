const DEFAULT_API_BASE_URL = 'https://coda.io/apis/v1/';

function getCodaApiToken(options = {}) {
	return options.apiToken || process.env.CODA_API_TOKEN || '';
}

function isLikelyCodaId(value) {
	return typeof value === 'string' && /^[a-z]+-[A-Za-z0-9_-]+$/.test(value);
}

function formatColumnReferenceForQuery(columnReference) {
	if (typeof columnReference !== 'string' || !columnReference.trim()) {
		throw new Error('Column reference is required.');
	}

	return isLikelyCodaId(columnReference) ? columnReference : JSON.stringify(columnReference);
}

function formatQueryValue(value) {
	return JSON.stringify(value);
}

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
