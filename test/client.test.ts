import assert from 'node:assert/strict';
import test from 'node:test';

import {
	allowedEntitySetsFromMetadata,
	buildEntityUrl,
	buildMutationUrl,
	parseODataPage,
	projectItem,
	requestCollection,
	requestMutation,
	requestSingle,
	resolveNextLink,
} from '../nodes/SapOdataGuard/client';
import { servicePolicyFor, validateGovernanceConfiguration } from '../nodes/SapOdataGuard/governance';
import { credentials } from './fixtures';

test('parses OData V2 and V4 page envelopes', () => {
	const v2 = parseODataPage({ d: { results: [{ ID: 1 }], __next: 'next' } });
	assert.deepEqual(v2.items, [{ ID: 1 }]);
	assert.equal(v2.nextLink, 'next');
	const v4 = parseODataPage({ value: [{ ID: 2 }], '@odata.nextLink': 'next4' });
	assert.deepEqual(v4.items, [{ ID: 2 }]);
	assert.equal(v4.nextLink, 'next4');
});

test('rejects cross-origin and cross-collection pagination links', () => {
	const creds = credentials();
	const collection = buildEntityUrl(
		creds,
		'/sap/opu/odata/sap/API_BUSINESS_PARTNER',
		'A_BusinessPartner',
		{ select: ['BusinessPartner'] },
	);
	assert.throws(
		() => resolveNextLink('https://evil.example/steal', collection, collection, creds),
		/outside the approved origin or entity collection/,
	);
	assert.throws(
		() =>
			resolveNextLink(
				'https://sap.example.com/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_Supplier?$skip=2',
				collection,
				collection,
				creds,
			),
		/outside the approved origin or entity collection/,
	);
});

test('preserves governed query parameters and rejects pagination tampering', () => {
	const creds = credentials();
	const governed = buildEntityUrl(
		creds,
		'/sap/opu/odata/sap/API_BUSINESS_PARTNER',
		'A_BusinessPartner',
		{
			select: ['BusinessPartner'],
			filter: "BusinessPartnerCategory eq '2'",
			orderBy: 'BusinessPartner asc',
			top: 50,
		},
	);
	const path = new URL(governed).pathname;
	const safe = resolveNextLink(
		`https://sap.example.com${path}?$skiptoken=opaque`,
		governed,
		governed,
		creds,
	);
	const safeUrl = new URL(safe);
	assert.equal(safeUrl.searchParams.get('$filter'), "BusinessPartnerCategory eq '2'");
	assert.equal(safeUrl.searchParams.get('$select'), 'BusinessPartner');
	assert.equal(safeUrl.searchParams.get('$top'), '50');
	assert.throws(
		() =>
			resolveNextLink(
				`https://sap.example.com${path}?$skiptoken=opaque&$filter=BusinessPartnerCategory%20eq%20'1'`,
				governed,
				governed,
				creds,
			),
		/attempted to change protected query parameter/,
	);
	assert.throws(
		() =>
			resolveNextLink(
				`https://sap.example.com${path}?$skiptoken=opaque&$expand=to_Address`,
				governed,
				governed,
				creds,
			),
		/unsupported query parameter/,
	);
});

test('follows bounded same-collection pagination and stops at row limit', async () => {
	const creds = credentials({ maxPages: 3 });
	const collection = buildEntityUrl(
		creds,
		'/sap/opu/odata/sap/API_BUSINESS_PARTNER',
		'A_BusinessPartner',
		{ select: ['BusinessPartner'] },
	);
	let calls = 0;
	const result = await requestCollection(
		async () => {
			calls += 1;
			return calls === 1
				? { d: { results: [{ ID: 1 }, { ID: 2 }], __next: `${collection}&$skiptoken=2` } }
				: { d: { results: [{ ID: 3 }, { ID: 4 }] } };
		},
		creds,
		collection,
		collection,
		3,
	);
	assert.equal(calls, 2);
	assert.deepEqual(result.items, [{ ID: 1 }, { ID: 2 }, { ID: 3 }]);
	assert.equal(result.truncated, true);
});

test('projects server responses again and intersects metadata with policy', () => {
	assert.deepEqual(projectItem({ ID: 1, Secret: 'hidden' }, ['ID']), { ID: 1 });
	const service = servicePolicyFor(
		'/sap/opu/odata/sap/API_BUSINESS_PARTNER',
		validateGovernanceConfiguration(credentials()),
	);
	const xml = '<Schema><EntityContainer><EntitySet Name="A_Supplier"/><EntitySet Name="A_BusinessPartner"/></EntityContainer></Schema>';
	assert.deepEqual(allowedEntitySetsFromMetadata(xml, service.entities), ['A_BusinessPartner']);
});

test('redacts Basic and OAuth secrets from request errors', async () => {
	const creds = credentials({
		password: 'basic-secret-value',
		clientSecret: 'oauth-client-secret',
		oauthTokenData: { access_token: 'oauth-access-token' },
	});
	await assert.rejects(
		() =>
			requestSingle(
				async () => {
					throw new Error(
						'failed basic-secret-value oauth-client-secret oauth-access-token',
					);
				},
				creds,
				'https://sap.example.com/service/Things(1)',
			),
		(error: Error) => {
			assert.equal(error.message.includes('basic-secret-value'), false);
			assert.equal(error.message.includes('oauth-client-secret'), false);
			assert.equal(error.message.includes('oauth-access-token'), false);
			assert.match(error.message, /\[REDACTED\]/);
			return true;
		},
	);
});

test('fetches a CSRF token and session cookies before a governed Create', async () => {
	const creds = credentials();
	const calls: Array<Record<string, unknown>> = [];
	const result = await requestMutation(
		async (options) => {
			calls.push(options as unknown as Record<string, unknown>);
			if (calls.length === 1) {
				return {
					statusCode: 200,
					headers: {
						'x-csrf-token': 'csrf-token-value',
						'set-cookie': ['SAP_SESSIONID=abc; Path=/; HttpOnly', 'sap-usercontext=client=250; Path=/'],
					},
					body: '{}',
				};
			}
			return {
				statusCode: 201,
				headers: { etag: 'W/"created"' },
				body: JSON.stringify({ d: { ID: '1', Name: 'Created' } }),
			};
		},
		creds,
		'/sap/opu/odata/sap/API_BUSINESS_PARTNER',
		'POST',
		buildMutationUrl(
			creds,
			'/sap/opu/odata/sap/API_BUSINESS_PARTNER',
			'A_BusinessPartner',
		),
		{ Name: 'Created' },
	);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].method, 'GET');
	assert.equal((calls[0].headers as Record<string, string>)['X-CSRF-Token'], 'Fetch');
	assert.equal(calls[0].returnFullResponse, true);
	assert.equal(calls[1].method, 'POST');
	assert.equal((calls[1].headers as Record<string, string>)['X-CSRF-Token'], 'csrf-token-value');
	assert.equal(
		(calls[1].headers as Record<string, string>).Cookie,
		'SAP_SESSIONID=abc; sap-usercontext=client=250',
	);
	assert.equal(calls[1].body, JSON.stringify({ Name: 'Created' }));
	assert.deepEqual(result, {
		item: { ID: '1', Name: 'Created' },
		statusCode: 201,
		serializedBytes: 33,
		etag: 'W/"created"',
	});
});

test('sends PATCH concurrency control and accepts an empty DELETE response', async () => {
	const creds = credentials();
	const calls: Array<Record<string, unknown>> = [];
	const httpRequest = async (options: unknown) => {
		calls.push(options as Record<string, unknown>);
		if (calls.length % 2 === 1) {
			return {
				statusCode: 200,
				headers: { 'X-CSRF-Token': 'token', 'Set-Cookie': 'SESSION=one; Path=/' },
				body: '',
			};
		}
		return { statusCode: 204, headers: {}, body: '' };
	};
	const url = buildMutationUrl(
		creds,
		'/sap/opu/odata/sap/API_BUSINESS_PARTNER',
		'A_BusinessPartner',
		"'1'",
	);
	const patchResult = await requestMutation(
		httpRequest,
		creds,
		'/sap/opu/odata/sap/API_BUSINESS_PARTNER',
		'PATCH',
		url,
		{ Name: 'Updated' },
		'W/"current"',
	);
	assert.equal((calls[1].headers as Record<string, string>)['If-Match'], 'W/"current"');
	assert.equal(patchResult.statusCode, 204);
	const deleteResult = await requestMutation(
		httpRequest,
		creds,
		'/sap/opu/odata/sap/API_BUSINESS_PARTNER',
		'DELETE',
		url,
		undefined,
		'*',
	);
	assert.equal(calls[3].body, undefined);
	assert.equal((calls[3].headers as Record<string, string>).Prefer, 'return=minimal');
	assert.deepEqual(deleteResult, {
		item: undefined,
		statusCode: 204,
		serializedBytes: 0,
		etag: undefined,
	});
});

test('fails closed when the CSRF response is missing a token', async () => {
	await assert.rejects(
		() =>
			requestMutation(
				async () => ({ statusCode: 200, headers: {}, body: '' }),
				credentials(),
				'/sap/opu/odata/sap/API_BUSINESS_PARTNER',
				'POST',
				'https://sap.example.com/service/Things',
				{ Name: 'No token' },
			),
		/did not return a usable CSRF token/,
	);
});
