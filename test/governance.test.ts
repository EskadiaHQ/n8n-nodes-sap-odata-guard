import assert from 'node:assert/strict';
import test from 'node:test';

import {
	entityPolicyFor,
	normalizeHost,
	parseServicePolicies,
	servicePolicyFor,
	validateGovernanceConfiguration,
	validateIfMatch,
	validateWritePayload,
} from '../nodes/SapOdataGuard/governance';
import { credentials, policyObject } from './fixtures';

test('parses exact service, entity, operation, and field policies', () => {
	const policies = validateGovernanceConfiguration(credentials());
	const service = servicePolicyFor('/sap/opu/odata/sap/API_BUSINESS_PARTNER', policies);
	const entity = entityPolicyFor(service, 'A_BusinessPartner', 'getMany');
	assert.equal(service.version, 'v2');
	assert.deepEqual(entity.fields, [
		'BusinessPartner',
		'BusinessPartnerCategory',
		'BusinessPartnerFullName',
	]);
	assert.equal(entity.requiredFilters.length, 1);
});

test('denies absent services, entities, and operations', () => {
	const policies = parseServicePolicies(JSON.stringify(policyObject));
	assert.throws(() => servicePolicyFor('/sap/opu/odata/sap/UNKNOWN', policies), /not allowed/);
	const service = servicePolicyFor('/sap/opu/odata/sap/API_BUSINESS_PARTNER', policies);
	assert.throws(() => entityPolicyFor(service, 'A_Supplier', 'getMany'), /not allowed/);
	assert.throws(() => entityPolicyFor(service, 'A_BusinessPartner', 'get'), /not allowed/);
});

test('rejects direct Get when required row filters exist', () => {
	const invalid = structuredClone(policyObject);
	invalid['/sap/opu/odata/sap/API_BUSINESS_PARTNER'].entities.A_BusinessPartner.operations = [
		'get',
		'getMany',
	];
	assert.throws(() => parseServicePolicies(JSON.stringify(invalid)), /cannot allow Get/);
});

test('requires explicit key types before Get is enabled', () => {
	const getPolicy = {
		'/service': {
			version: 'v4',
			entities: {
				Things: {
					operations: ['get'],
					fields: ['ID'],
					keyFields: {},
					filterFields: {},
					orderByFields: [],
				},
			},
		},
	};
	assert.throws(() => parseServicePolicies(JSON.stringify(getPolicy)), /must define keyFields/);
});

test('rejects unsafe service paths and prototype keys', () => {
	assert.throws(
		() => parseServicePolicies('{"https://evil.example/svc":{"version":"v4","entities":{}}}'),
		/relative absolute paths/,
	);
	assert.throws(
		() =>
			parseServicePolicies(
				'{"/svc":{"version":"v4","entities":{"constructor":{"operations":["getMany"],"fields":["ID"]}}}}',
			),
		/forbidden property name/,
	);
});

test('requires explicit opt-ins for private literals and HTTP', () => {
	assert.throws(() => normalizeHost('https://127.0.0.1'), /Private-network hosts require/);
	assert.throws(() => normalizeHost('http://sap.example.com'), /must use HTTPS/);
	assert.equal(normalizeHost('http://127.0.0.1', true, true), 'http://127.0.0.1');
	assert.throws(
		() => normalizeHost('https://169.254.169.254', false, true),
		/metadata endpoints are never allowed/,
	);
});

test('does not require hidden AI limits when AI Tool use is disabled', () => {
	const normalCredential = credentials();
	delete normalCredential.aiToolMaxRows;
	delete normalCredential.aiToolMaxBytes;
	delete (normalCredential as { maxRequestBytes?: number }).maxRequestBytes;
	delete (normalCredential as { maxWrites?: number }).maxWrites;
	assert.doesNotThrow(() => validateGovernanceConfiguration(normalCredential));
	assert.equal(normalCredential.maxRequestBytes, 1048576);
	assert.equal(normalCredential.maxWrites, 100);
	assert.throws(
		() => validateGovernanceConfiguration({ ...normalCredential, allowAiTool: true }),
		/AI Tool Maximum Rows/,
	);
});

test('parses explicit Create, Update, and Delete policy without granting other fields', () => {
	const writePolicy = {
		'/service': {
			version: 'v2',
			entities: {
				Things: {
					operations: ['get', 'create', 'update', 'delete'],
					fields: ['ID', 'Name', 'ChangedAt'],
					keyFields: { ID: 'string' },
					filterFields: {},
					orderByFields: [],
					createFields: { Name: 'string', ChangedAt: 'datetime', Details: 'object' },
					updateFields: { Name: 'string', ChangedAt: 'datetime' },
					requiredCreateFields: ['Name'],
					nullableUpdateFields: ['Name'],
					allowWildcardIfMatch: true,
				},
			},
		},
	};
	const service = servicePolicyFor('/service', parseServicePolicies(JSON.stringify(writePolicy)));
	const entity = entityPolicyFor(service, 'Things', 'create');
	assert.deepEqual(
		validateWritePayload(
			{
				Name: 'Controlled',
				ChangedAt: '2026-08-22T12:00:00Z',
				Details: { results: [{ Code: 'A' }] },
			},
			entity,
			'create',
			'v2',
			4096,
		),
		{
			Name: 'Controlled',
			ChangedAt: '/Date(1787400000000)/',
			Details: { results: [{ Code: 'A' }] },
		},
	);
	assert.throws(
		() => validateWritePayload({ Name: 'x', Secret: 'no' }, entity, 'create', 'v2', 4096),
		/Secret is not allowed/,
	);
	assert.throws(
		() => validateWritePayload({ ChangedAt: '2026-08-22T12:00:00Z' }, entity, 'create', 'v2', 4096),
		/requires field Name/,
	);
	assert.equal(validateIfMatch('*', entity), '*');
});

test('write policies require keys, field maps, safe payloads, and explicit wildcard ETags', () => {
	const invalid = {
		'/service': {
			version: 'v4',
			entities: {
				Things: {
					operations: ['update'],
					fields: ['ID'],
					keyFields: {},
					filterFields: {},
					orderByFields: [],
					updateFields: {},
				},
			},
		},
	};
	assert.throws(() => parseServicePolicies(JSON.stringify(invalid)), /must define keyFields/);

	const allowed = structuredClone(invalid);
	allowed['/service'].entities.Things.keyFields = { ID: 'string' } as never;
	allowed['/service'].entities.Things.updateFields = { Name: 'string' } as never;
	const entity = entityPolicyFor(
		servicePolicyFor('/service', parseServicePolicies(JSON.stringify(allowed))),
		'Things',
		'update',
	);
	assert.throws(() => validateIfMatch('*', entity), /Wildcard If-Match is not allowed/);
	assert.throws(() => validateIfMatch('bad\r\nheader', entity), /invalid/);
	assert.throws(
		() =>
			validateWritePayload(
				{ Name: 'x'.repeat(500) },
				entity,
				'update',
				'v4',
				128,
			),
		/above the credential limit/,
	);
});
