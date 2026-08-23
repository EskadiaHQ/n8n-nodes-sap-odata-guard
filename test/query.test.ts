import assert from 'node:assert/strict';
import test from 'node:test';

import { servicePolicyFor, validateGovernanceConfiguration } from '../nodes/SapOdataGuard/governance';
import {
	buildFilter,
	buildKeyPredicate,
	buildOrderBy,
	formatODataLiteral,
	selectedFieldsFromInput,
	writePayloadFromUi,
} from '../nodes/SapOdataGuard/query';
import { credentials } from './fixtures';

function entityPolicy() {
	return servicePolicyFor(
		'/sap/opu/odata/sap/API_BUSINESS_PARTNER',
		validateGovernanceConfiguration(credentials()),
	).entities.get('A_BusinessPartner')!;
}

test('escapes string literals and emits version-specific GUID/date syntax', () => {
	assert.equal(formatODataLiteral("O'Brien", 'string', 'v4'), "'O''Brien'");
	assert.equal(
		formatODataLiteral('00112233-4455-4677-8899-aabbccddeeff', 'guid', 'v2'),
		"guid'00112233-4455-4677-8899-aabbccddeeff'",
	);
	assert.equal(formatODataLiteral('2026-08-22', 'date', 'v2'), "datetime'2026-08-22T00:00:00'");
});

test('joins required filters with AND around caller filter logic', () => {
	const filter = buildFilter(
		[
			{ field: 'BusinessPartner', operator: 'contains', value: "O'Brien" },
			{ field: 'BusinessPartner', operator: 'startsWith', value: '10' },
		],
		'or',
		entityPolicy(),
		'v2',
	);
	assert.equal(
		filter,
		"(BusinessPartnerCategory eq '2') and (substringof('O''Brien',BusinessPartner) or startswith(BusinessPartner,'10'))",
	);
});

test('defaults projection to approved fields and rejects unknown projection/sort fields', () => {
	const entity = entityPolicy();
	assert.deepEqual(selectedFieldsFromInput('', entity), entity.fields);
	assert.deepEqual(
		selectedFieldsFromInput(['BusinessPartner', 'BusinessPartnerFullName'], entity),
		['BusinessPartner', 'BusinessPartnerFullName'],
	);
	assert.throws(() => selectedFieldsFromInput('BusinessPartner,SecretField', entity), /not allowed/);
	assert.equal(
		buildOrderBy([{ field: 'BusinessPartner', direction: 'asc' }], entity),
		'BusinessPartner asc',
	);
	assert.throws(
		() => buildOrderBy([{ field: 'BusinessPartnerFullName', direction: 'asc' }], entity),
		/not allowed/,
	);
});

test('builds a write payload from governed field mapping values', () => {
	assert.deepEqual(
		writePayloadFromUi({
			values: [
				{ field: 'Name', valueJson: '"Ada"' },
				{ field: 'Amount', valueJson: '42.5' },
				{ field: 'Enabled', valueJson: 'true' },
				{ field: 'Details', valueJson: '{"source":"n8n"}' },
			],
		}),
		{ Name: 'Ada', Amount: 42.5, Enabled: true, Details: { source: 'n8n' } },
	);
	assert.throws(
		() =>
			writePayloadFromUi({
				values: [
					{ field: 'Name', valueJson: '"Ada"' },
					{ field: 'Name', valueJson: '"Grace"' },
				],
			}),
		/configured more than once/,
	);
	assert.throws(
		() => writePayloadFromUi({ values: [{ field: 'Name', valueJson: 'Ada' }] }),
		/must contain a valid JSON value/,
	);
});

test('requires exact structured keys and formats single/composite predicates', () => {
	const entity = entityPolicy();
	assert.equal(buildKeyPredicate('{"BusinessPartner":"1000"}', entity, 'v2'), "'1000'");
	assert.throws(
		() => buildKeyPredicate('{"BusinessPartner":"1000","Unexpected":"x"}', entity, 'v2'),
		/must contain exactly/,
	);
	entity.keyFields.set('BusinessPartnerCategory', 'string');
	assert.equal(
		buildKeyPredicate(
			'{"BusinessPartner":"1000","BusinessPartnerCategory":"2"}',
			entity,
			'v4',
		),
		"BusinessPartner='1000',BusinessPartnerCategory='2'",
	);
});
