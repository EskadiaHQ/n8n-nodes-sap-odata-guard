#!/usr/bin/env node

import { randomUUID } from 'node:crypto';

const origin = String(process.env.N8N_API_URL || '').replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
const apiKey = process.env.N8N_API_KEY;
if (!origin || !apiKey) throw new Error('N8N_API_URL and N8N_API_KEY are required.');

const apiHeaders = {
	'content-type': 'application/json',
	'X-N8N-API-KEY': apiKey,
};
if (process.env.CF_ACCESS_CLIENT_ID) {
	apiHeaders['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
}
if (process.env.CF_ACCESS_CLIENT_SECRET) {
	apiHeaders['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
}

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
	if (!response.ok) {
		throw new Error(`n8n API ${options.method || 'GET'} ${path}: ${response.status} ${String(text).slice(0, 300)}`);
	}
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

const sourceCases = [
	{
		sourceId: '5Jo7nzj8agsAhZ2l',
		label: 'business-partners',
		fields: 'BusinessPartner,BusinessPartnerCategory,BusinessPartnerFullName',
		orderField: 'BusinessPartner',
	},
	{
		sourceId: 'Mu68W1FUMj6L14PY',
		label: 'purchase-orders',
		fields: 'PurchaseOrder,CompanyCode,Supplier,PurchaseOrderDate,DocumentCurrency',
		orderField: 'PurchaseOrder',
	},
	{
		sourceId: 'Dm0GRXlR0jpXauog',
		label: 'sales-orders',
		fields: 'SalesOrder,SalesOrganization,SoldToParty,TotalNetAmount,TransactionCurrency',
		orderField: 'SalesOrder',
	},
	{
		sourceId: 'S0Wel8DhfcgOErMe',
		label: 'billing-documents',
		fields: 'BillingDocument,CompanyCode,PayerParty,TotalNetAmount,TransactionCurrency',
		orderField: 'BillingDocument',
	},
	{
		sourceId: 'WdaLdEOPv6OxrJDF',
		label: 'products',
		fields: 'Product,ProductType,ProductGroup,BaseUnit,IsMarkedForDeletion',
		orderField: 'Product',
	},
];

const credential = {
	sapOdataGuardApi: {
		id: 'ODataGuardAcc001',
		name: 'Logali SAP OData Guard - Acceptance Read Only',
	},
};

const valueOf = (value) => (value && typeof value === 'object' && 'value' in value ? value.value : value);
const baseNode = ({ name, servicePath, entitySet, fields, orderField, limit = 5 }) => ({
	parameters: {
		authentication: 'basicOrNone',
		resource: 'entity',
		operation: 'getMany',
		servicePath: String(servicePath).replace(/\/$/, ''),
		entitySet,
		fields,
		filters: {},
		filterLogic: 'and',
		orderBy: { values: [{ field: orderField, direction: 'asc' }] },
		returnAll: false,
		limit,
		pageSize: limit,
		includeMetadata: true,
	},
	id: randomUUID(),
	name,
	type: 'n8n-nodes-sap-odata-guard.sapOdataGuard',
	typeVersion: 1,
	position: [280, 0],
	credentials: credential,
});

const webhookNode = (path) => ({
	parameters: { httpMethod: 'GET', path, responseMode: 'lastNode', options: {} },
	id: randomUUID(),
	name: 'Acceptance Webhook',
	type: 'n8n-nodes-base.webhook',
	typeVersion: 2.1,
	position: [0, 0],
	webhookId: randomUUID(),
});

const makeWorkflow = (name, path, nodes) => ({
	name,
	nodes: [webhookNode(path), ...nodes],
	connections: {
		'Acceptance Webhook': {
			main: [[{ node: nodes[0].name, type: 'main', index: 0 }]],
		},
		...Object.fromEntries(
			nodes.slice(0, -1).map((node, index) => [
				node.name,
				{ main: [[{ node: nodes[index + 1].name, type: 'main', index: 0 }]] },
			]),
		),
	},
	settings: { executionOrder: 'v1' },
});

const specs = [];
for (const sourceCase of sourceCases) {
	const source = await request(`/workflows/${sourceCase.sourceId}`);
	const avanai = source.nodes.find((node) => node.type === 'n8n-nodes-sap-odata.sapOData');
	if (!avanai) throw new Error(`Source ${sourceCase.sourceId} has no Avanai SAP OData node.`);
	const sourceOperation = avanai.parameters.operation || 'getAll';
	if (['create', 'update', 'delete'].includes(sourceOperation)) {
		throw new Error(`Source ${sourceCase.sourceId} is a write workflow and cannot be cloned.`);
	}
	const servicePath = valueOf(avanai.parameters.servicePath);
	const entitySet = valueOf(avanai.parameters.entitySet);
	const path = `odata-guard-acceptance-010-${sourceCase.label}`;
	const node = baseNode({
		name: `Guard - ${sourceCase.label}`,
		servicePath,
		entitySet,
		fields: sourceCase.fields,
		orderField: sourceCase.orderField,
	});
	specs.push({
		kind: 'positive',
		path,
		sourceId: source.id,
		sourceName: source.name,
		expectedMaxRows: 5,
		workflow: makeWorkflow(`[ACCEPTANCE 0.1.0] Guard clone - ${source.name}`, path, [node]),
	});
}

const getMany = baseNode({
	name: 'Guard - Find One Business Partner',
	servicePath: '/sap/opu/odata/sap/API_BUSINESS_PARTNER',
	entitySet: 'A_BusinessPartner',
	fields: 'BusinessPartner',
	orderField: 'BusinessPartner',
	limit: 1,
});
const getOne = {
	...baseNode({
		name: 'Guard - Get Same Business Partner',
		servicePath: '/sap/opu/odata/sap/API_BUSINESS_PARTNER',
		entitySet: 'A_BusinessPartner',
		fields: 'BusinessPartner,BusinessPartnerFullName',
		orderField: 'BusinessPartner',
		limit: 1,
	}),
	parameters: {
		authentication: 'basicOrNone',
		resource: 'entity',
		operation: 'get',
		servicePath: '/sap/opu/odata/sap/API_BUSINESS_PARTNER',
		entitySet: 'A_BusinessPartner',
		keyJson: '={{ { "BusinessPartner": $json.BusinessPartner } }}',
		fields: 'BusinessPartner,BusinessPartnerFullName',
		includeMetadata: true,
	},
	position: [560, 0],
};
specs.push({
	kind: 'positive-get',
	path: 'odata-guard-acceptance-010-get-roundtrip',
	sourceId: '5Jo7nzj8agsAhZ2l',
	sourceName: 'SAP OData — Credential and First Connection',
	expectedMaxRows: 1,
	workflow: makeWorkflow(
		'[ACCEPTANCE 0.1.0] Guard clone - Get roundtrip',
		'odata-guard-acceptance-010-get-roundtrip',
		[getMany, getOne],
	),
});

const deniedEntity = baseNode({
	name: 'Guard - Denied Entity',
	servicePath: '/sap/opu/odata/sap/API_BUSINESS_PARTNER',
	entitySet: 'A_BusinessPartnerAddress',
	fields: 'BusinessPartner',
	orderField: 'BusinessPartner',
});
specs.push({
	kind: 'negative-entity',
	path: 'odata-guard-acceptance-010-denied-entity',
	sourceId: '5Jo7nzj8agsAhZ2l',
	sourceName: 'SAP OData — Credential and First Connection',
	workflow: makeWorkflow(
		'[ACCEPTANCE 0.1.0] Guard negative - denied entity',
		'odata-guard-acceptance-010-denied-entity',
		[deniedEntity],
	),
});

const deniedField = baseNode({
	name: 'Guard - Denied Field',
	servicePath: '/sap/opu/odata/sap/API_BUSINESS_PARTNER',
	entitySet: 'A_BusinessPartner',
	fields: 'BusinessPartner,SecretField',
	orderField: 'BusinessPartner',
});
specs.push({
	kind: 'negative-field',
	path: 'odata-guard-acceptance-010-denied-field',
	sourceId: '5Jo7nzj8agsAhZ2l',
	sourceName: 'SAP OData — Credential and First Connection',
	workflow: makeWorkflow(
		'[ACCEPTANCE 0.1.0] Guard negative - denied field',
		'odata-guard-acceptance-010-denied-field',
		[deniedField],
	),
});

const waitForExecution = async (workflowId, startedAfter) => {
	for (let attempt = 0; attempt < 20; attempt += 1) {
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

const result = [];
for (const spec of specs) {
	const prior = workflowList.find((workflow) => workflow.name === spec.workflow.name);
	const created = prior || (await request('/workflows', { method: 'POST', body: JSON.stringify(spec.workflow) }));
	let activated = false;
	try {
		await request(`/workflows/${created.id}/activate`, { method: 'POST' });
		activated = true;
		await new Promise((resolve) => setTimeout(resolve, 600));
		const startedAfter = Date.now();
		const webhook = await webhookRequest(spec.path);
		const execution = await waitForExecution(created.id, startedAfter);
		const errorMessage = execution.data?.resultData?.error?.message || null;
		const rows = Array.isArray(webhook.body) ? webhook.body : webhook.body ? [webhook.body] : [];
		const metadata = rows.find((row) => row && typeof row === 'object' && row._odata)?._odata || null;
		result.push({
			workflowId: created.id,
			workflowName: created.name,
			sourceId: spec.sourceId,
			sourceName: spec.sourceName,
			kind: spec.kind,
			webhookStatus: webhook.status,
			executionStatus: execution.status,
			rowCount: rows.length,
			policyApplied: metadata?.policyApplied === true,
			rowLimit: metadata?.rowLimit ?? null,
			error: errorMessage,
		});
	} finally {
		if (activated) await request(`/workflows/${created.id}/deactivate`, { method: 'POST' });
	}
}

const positives = result.filter((item) => item.kind.startsWith('positive'));
const negatives = result.filter((item) => item.kind.startsWith('negative'));
for (const item of positives) {
	if (item.webhookStatus !== 200 || item.executionStatus !== 'success' || item.rowCount < 1) {
		throw new Error(`Positive acceptance failed: ${JSON.stringify(item)}`);
	}
	if (!item.policyApplied) throw new Error(`Governance metadata missing: ${item.workflowId}`);
}
for (const item of negatives) {
	if (item.executionStatus !== 'error' || !/not allowed/i.test(item.error || '')) {
		throw new Error(`Negative acceptance failed: ${JSON.stringify(item)}`);
	}
}

console.log(JSON.stringify({ createdOrReused: result.length, allDeactivated: true, result }, null, 2));
