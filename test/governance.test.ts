import assert from 'node:assert/strict';
import test from 'node:test';

import {
	entityPolicyFor,
	normalizeHost,
	parseServicePolicies,
	servicePolicyFor,
	validateGovernanceConfiguration,
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
	assert.doesNotThrow(() => validateGovernanceConfiguration(normalCredential));
	assert.throws(
		() => validateGovernanceConfiguration({ ...normalCredential, allowAiTool: true }),
		/AI Tool Maximum Rows/,
	);
});
