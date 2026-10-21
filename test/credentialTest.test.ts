import assert from 'node:assert/strict';
import test from 'node:test';
import type { ICredentialTestFunctions, ICredentialsDecrypted } from 'n8n-workflow';

import { SapOdataGuard } from '../nodes/SapOdataGuard/SapOdataGuard.node';
import { credentials } from './fixtures';
import type { ODataGuardCredentials } from '../nodes/SapOdataGuard/types';

function testCredential(
	request: (options: Record<string, unknown>) => Promise<unknown>,
	data: ODataGuardCredentials = credentials({ servicePoliciesJson: '' }),
) {
	return new SapOdataGuard().methods.credentialTest.sapOdataGuardConnectionTest.call(
		{ helpers: { request } } as unknown as ICredentialTestFunctions,
		{ id: 'host-probe-regression', data } as unknown as ICredentialsDecrypted,
	);
}

test('an SAP root 404 passes only the host check and keeps SAP context, auth and TLS validation', async () => {
	let calls = 0;
	const result = await testCredential(
		async (options) => {
			calls++;
			const url = new URL(String(options.uri));
			assert.equal(url.pathname, '/');
			assert.equal(url.searchParams.get('sap-client'), '250');
			assert.equal(url.searchParams.get('sap-language'), 'EN');
			assert.deepEqual(options.auth, {
				username: 'reader',
				password: 'secret',
			});
			assert.equal(options.rejectUnauthorized, true);
			throw Object.assign(new Error('Not found'), { statusCode: 404 });
		},
		credentials({
			servicePoliciesJson: ' \n\t',
			sapClient: '250',
			sapLanguage: 'EN',
		}),
	);
	assert.equal(calls, 1);
	assert.equal(result.status, 'OK');
	assert.match(result.message, /HTTP 404 at the root URL/);
	assert.match(result.message, /Authentication and OData service access are not verified/);
	assert.match(result.message, /Connection → Test Connection/);
});

test('host authentication, server, DNS, TCP and TLS failures still fail the credential check', async () => {
	const failures = [
		...([401, 403, 500, 503] as const).map((statusCode) =>
			Object.assign(new Error(`HTTP ${statusCode}`), { statusCode }),
		),
		...[
			'ECONNREFUSED',
			'ENOTFOUND',
			'ETIMEDOUT',
			'CERT_HAS_EXPIRED',
			'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
		].map((code) => Object.assign(new Error(code), { code })),
	];
	for (const error of failures) {
		const result = await testCredential(async () => {
			throw error;
		});
		assert.equal(result.status, 'Error', error.message);
		assert.match(result.message, /SAP OData request failed/);
	}
});

test('a configured service metadata 404 remains an error instead of a successful host probe', async () => {
	const result = await testCredential(async (options) => {
		assert.equal(
			new URL(String(options.uri)).pathname,
			'/sap/opu/odata/sap/API_BUSINESS_PARTNER/$metadata',
		);
		throw Object.assign(new Error('Service not found'), { statusCode: 404 });
	}, credentials());
	assert.equal(result.status, 'Error');
	assert.match(result.message, /HTTP 404/);
});

test('a configured policy still tests its exact service metadata', async () => {
	let calls = 0;
	const result = await testCredential(async (options) => {
		calls++;
		assert.equal(
			new URL(String(options.uri)).pathname,
			'/sap/opu/odata/sap/API_BUSINESS_PARTNER/$metadata',
		);
		return '<edmx:Edmx/>';
	}, credentials());
	assert.equal(calls, 1);
	assert.equal(result.status, 'OK');
	assert.match(
		result.message,
		/Connection successful for \/sap\/opu\/odata\/sap\/API_BUSINESS_PARTNER/,
	);
});

test('host-only success still enforces the credential response byte limit', async () => {
	const result = await testCredential(
		async () => 'x'.repeat(1025),
		credentials({ servicePoliciesJson: '', maxResponseBytes: 1024 }),
	);
	assert.equal(result.status, 'Error');
	assert.match(result.message, /byte limit/);
});
