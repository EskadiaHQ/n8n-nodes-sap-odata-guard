#!/usr/bin/env node

import { randomUUID } from 'node:crypto';

const origin = String(process.env.N8N_API_URL || '').replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
const apiKey = process.env.N8N_API_KEY;
if (!origin || !apiKey) throw new Error('N8N_API_URL and N8N_API_KEY are required.');

const apiHeaders = {
	'content-type': 'application/json',
	'X-N8N-API-KEY': apiKey,
};
if (process.env.CF_ACCESS_CLIENT_ID) apiHeaders['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
if (process.env.CF_ACCESS_CLIENT_SECRET) apiHeaders['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;

const request = async (path, options = {}) => {
	const response = await fetch(`${origin}/api/v1${path}`, {
		...options,
		headers: { ...apiHeaders, ...(options.headers || {}) },
		redirect: 'manual',
	});
	const text = await response.text();
	let body;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	if (!response.ok) throw new Error(`n8n API ${options.method || 'GET'} ${path}: HTTP ${response.status}`);
	return body;
};

const webhookRequest = async (path) => {
	const response = await fetch(`${origin}/webhook/${path}`, {
		headers: Object.fromEntries(
			Object.entries(apiHeaders).filter(([key]) => key.toLowerCase() !== 'content-type'),
		),
		redirect: 'manual',
	});
	const text = await response.text();
	let body;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	return { status: response.status, body };
};

const workflowList = [];
let cursor;
do {
	const query = new URLSearchParams({ limit: '250' });
	if (cursor) query.set('cursor', cursor);
	const page = await request(`/workflows?${query}`);
	workflowList.push(...(page.data || []));
	cursor = page.nextCursor;
} while (cursor);

const credential = {
	sapOdataGuardApi: {
		id: 'ODataGuardAcc001',
		name: 'Logali SAP OData Guard - Acceptance Governed CRUD',
	},
};
const servicePath = '/sap/opu/odata/sap/API_SALES_ORDER_SRV';
const entitySet = 'A_SalesOrder';
const marker = `N8N-GUARD-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
const updatedMarker = `${marker}-U`;
const createPayload = {
	SalesOrderType: 'OR1',
	SalesOrganization: '1710',
	DistributionChannel: '10',
	OrganizationDivision: '00',
	SoldToParty: '17100023',
	PurchaseOrderByCustomer: marker,
	TransactionCurrency: 'USD',
	to_Item: {
		results: [
			{
				Material: 'NS0002',
				RequestedQuantity: '1',
				RequestedQuantityUnit: 'PC',
			},
		],
	},
};

const webhookNode = (path) => ({
	parameters: { httpMethod: 'GET', path, responseMode: 'lastNode', options: {} },
	id: randomUUID(),
	name: 'Acceptance Webhook',
	type: 'n8n-nodes-base.webhook',
	typeVersion: 2.1,
	position: [0, 0],
	webhookId: randomUUID(),
});

const guardNode = (name, operation, parameters) => ({
	parameters: {
		authentication: 'basicOrNone',
		resource: 'entity',
		operation,
		servicePath,
		entitySet,
		includeMetadata: true,
		...parameters,
	},
	id: randomUUID(),
	name,
	type: 'n8n-nodes-sap-odata-guard.sapOdataGuard',
	typeVersion: 1,
	position: [280, 0],
	credentials: credential,
});

const workflowBody = (name, path, node) => ({
	name,
	nodes: [webhookNode(path), node],
	connections: {
		'Acceptance Webhook': { main: [[{ node: node.name, type: 'main', index: 0 }]] },
	},
	settings: { executionOrder: 'v1' },
});

const upsertWorkflow = async (body) => {
	const prior = workflowList.find((workflow) => workflow.name === body.name);
	if (!prior) {
		const created = await request('/workflows', { method: 'POST', body: JSON.stringify(body) });
		workflowList.push(created);
		return created;
	}
	if (prior.active) await request(`/workflows/${prior.id}/deactivate`, { method: 'POST' });
	return await request(`/workflows/${prior.id}`, { method: 'PUT', body: JSON.stringify(body) });
};

const waitForExecution = async (workflowId, startedAfter) => {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const executions = await request(`/executions?workflowId=${workflowId}&limit=10`);
		const match = (executions.data || []).find(
			(execution) => Date.parse(execution.startedAt || 0) >= startedAfter - 2000,
		);
		if (match && !['new', 'running', 'waiting'].includes(match.status)) {
			return await request(`/executions/${match.id}?includeData=true`);
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`Execution did not finish for workflow ${workflowId}.`);
};

const runWorkflow = async (body, path) => {
	const workflow = await upsertWorkflow(body);
	let activated = false;
	try {
		await request(`/workflows/${workflow.id}/activate`, { method: 'POST' });
		activated = true;
		await new Promise((resolve) => setTimeout(resolve, 600));
		const startedAfter = Date.now();
		const webhook = await webhookRequest(path);
		const execution = await waitForExecution(workflow.id, startedAfter);
		return {
			workflowId: workflow.id,
			workflowName: workflow.name,
			executionId: execution.id,
			status: execution.status,
			webhookStatus: webhook.status,
			body: webhook.body,
			error: execution.data?.resultData?.error?.message || null,
		};
	} finally {
		if (activated) await request(`/workflows/${workflow.id}/deactivate`, { method: 'POST' });
	}
};

const scalarBody = (body) => (Array.isArray(body) ? body[0] : body);
const results = [];
let salesOrder;
let currentEtag;
let deleted = false;

const getSpec = (key) => {
	const path = 'odata-guard-acceptance-020-write-get';
	return {
		path,
		body: workflowBody(
			'[ACCEPTANCE 0.2.0] Guard write - Get Sales Order',
			path,
			guardNode('Guard - Get Sales Order', 'get', {
				keyJson: { SalesOrder: key },
				fields: 'SalesOrder,PurchaseOrderByCustomer',
			}),
		),
	};
};

const deleteSpec = (key, etag, suffix = '') => {
	const path = `odata-guard-acceptance-020-write-delete${suffix}`;
	return {
		path,
		body: workflowBody(
			`[ACCEPTANCE 0.2.0] Guard write - Delete Sales Order${suffix ? ' Cleanup' : ''}`,
			path,
			guardNode('Guard - Delete Sales Order', 'delete', {
				keyJson: { SalesOrder: key },
				ifMatch: etag,
			}),
		),
	};
};

try {
	const createPath = 'odata-guard-acceptance-020-write-create';
	const create = await runWorkflow(
		workflowBody(
			'[ACCEPTANCE 0.2.0] Guard write - Create Sales Order',
			createPath,
			guardNode('Guard - Create Sales Order', 'create', { dataJson: createPayload }),
		),
		createPath,
	);
	results.push({ ...create, body: undefined });
	if (create.status !== 'success' || create.webhookStatus !== 200) {
		throw new Error(`Create failed: ${create.error || create.webhookStatus}`);
	}
	const created = scalarBody(create.body);
	salesOrder = String(created?.SalesOrder || '');
	currentEtag = created?._odata?.etag;
	if (!salesOrder) throw new Error('Create did not return SalesOrder.');

	if (!currentEtag) {
		const spec = getSpec(salesOrder);
		const getAfterCreate = await runWorkflow(spec.body, spec.path);
		results.push({ ...getAfterCreate, body: undefined });
		const fetched = scalarBody(getAfterCreate.body);
		currentEtag = fetched?._odata?.etag;
	}
	if (!currentEtag) throw new Error('No exact ETag was available after Create.');

	const updatePath = 'odata-guard-acceptance-020-write-update';
	const update = await runWorkflow(
		workflowBody(
			'[ACCEPTANCE 0.2.0] Guard write - Update Sales Order',
			updatePath,
			guardNode('Guard - Update Sales Order', 'update', {
				keyJson: { SalesOrder: salesOrder },
				dataJson: { PurchaseOrderByCustomer: updatedMarker },
				ifMatch: currentEtag,
			}),
		),
		updatePath,
	);
	results.push({ ...update, body: undefined });
	if (update.status !== 'success' || update.webhookStatus !== 200) {
		throw new Error(`Update failed: ${update.error || update.webhookStatus}`);
	}
	currentEtag = scalarBody(update.body)?._odata?.etag || currentEtag;

	const get = getSpec(salesOrder);
	const getAfterUpdate = await runWorkflow(get.body, get.path);
	results.push({ ...getAfterUpdate, body: undefined });
	if (getAfterUpdate.status !== 'success' || getAfterUpdate.webhookStatus !== 200) {
		throw new Error(`Get after Update failed: ${getAfterUpdate.error || getAfterUpdate.webhookStatus}`);
	}
	const fetched = scalarBody(getAfterUpdate.body);
	if (fetched?.PurchaseOrderByCustomer !== updatedMarker) {
		throw new Error('Get after Update did not return the updated marker.');
	}
	currentEtag = fetched?._odata?.etag || currentEtag;
	if (!currentEtag) throw new Error('Get after Update did not return an ETag.');

	const remove = deleteSpec(salesOrder, currentEtag);
	const deletedResult = await runWorkflow(remove.body, remove.path);
	results.push({ ...deletedResult, body: undefined });
	if (deletedResult.status !== 'success' || deletedResult.webhookStatus !== 200) {
		throw new Error(`Delete failed: ${deletedResult.error || deletedResult.webhookStatus}`);
	}
	deleted = true;

	const verifyDeleted = getSpec(salesOrder);
	const getAfterDelete = await runWorkflow(verifyDeleted.body, verifyDeleted.path);
	results.push({ ...getAfterDelete, body: undefined, verifiesDeletion: true });
	if (
		getAfterDelete.status !== 'error' ||
		!/(?:\b404\b|not found|does not exist|not exist)/i.test(getAfterDelete.error || '')
	) {
		throw new Error('Get after Delete did not prove that the Sales Order was removed.');
	}

	const deniedOperationPath = 'odata-guard-acceptance-020-denied-write-operation';
	const deniedOperation = await runWorkflow(
		workflowBody(
			'[ACCEPTANCE 0.2.0] Guard negative - denied write operation',
			deniedOperationPath,
			guardNode('Guard - Denied Business Partner Create', 'create', {
				servicePath: '/sap/opu/odata/sap/API_BUSINESS_PARTNER',
				entitySet: 'A_BusinessPartner',
				dataJson: { BusinessPartnerCategory: '2' },
			}),
		),
		deniedOperationPath,
	);
	results.push({ ...deniedOperation, body: undefined });
	if (deniedOperation.status !== 'error' || !/not allowed/i.test(deniedOperation.error || '')) {
		throw new Error('Denied write operation did not fail closed.');
	}

	const deniedFieldPath = 'odata-guard-acceptance-020-denied-write-field';
	const deniedField = await runWorkflow(
		workflowBody(
			'[ACCEPTANCE 0.2.0] Guard negative - denied write field',
			deniedFieldPath,
			guardNode('Guard - Denied Sales Order Field', 'create', {
				dataJson: { ...createPayload, SecretField: 'blocked' },
			}),
		),
		deniedFieldPath,
	);
	results.push({ ...deniedField, body: undefined });
	if (deniedField.status !== 'error' || !/not allowed/i.test(deniedField.error || '')) {
		throw new Error('Denied write field did not fail closed.');
	}
} finally {
	if (salesOrder && !deleted) {
		try {
			const get = getSpec(salesOrder);
			const fetchedResult = await runWorkflow(get.body, get.path);
			const fetched = scalarBody(fetchedResult.body);
			currentEtag = fetched?._odata?.etag || currentEtag;
		} catch {
			// The entity may already be deleted.
		}
		if (currentEtag) {
			const cleanup = deleteSpec(salesOrder, currentEtag, '-cleanup');
			const cleanupResult = await runWorkflow(cleanup.body, cleanup.path);
			deleted = cleanupResult.status === 'success';
			results.push({ ...cleanupResult, body: undefined, cleanup: true });
		}
	}
}

console.log(
	JSON.stringify({
		marker,
		updatedMarker,
		salesOrder,
		deleted,
		allDeactivated: true,
		results,
	}),
);
