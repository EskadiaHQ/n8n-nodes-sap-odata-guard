import assert from 'node:assert/strict';
import test from 'node:test';
import type {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	ICredentialTestFunctions,
	IHttpRequestOptions,
} from 'n8n-workflow';

import { SapOdataGuard } from '../nodes/SapOdataGuard/SapOdataGuard.node';
import { automaticServicePolicyFromMetadata } from '../nodes/SapOdataGuard/catalog';
import {
	hasServicePolicies,
	validateGovernanceConfiguration,
} from '../nodes/SapOdataGuard/governance';
import { resolveServicePolicy } from '../nodes/SapOdataGuard/policy';
import { commonCredentialProperties } from '../credentials/properties';
import { credentials } from './fixtures';

const path = '/sap/opu/odata/sap/Z_SALES_ORDER_SRV';
function metadata(version = 'v2') {
	return `<edmx:Edmx Version="${version === 'v4' ? '4.0' : '1.0'}"><edmx:DataServices m:DataServiceVersion="${version === 'v4' ? '4.0' : '2.0'}"><Schema Namespace="Demo"><EntityType Name="Order"><Key><PropertyRef Name="ID"/></Key><Property Name="ID" Type="Edm.String" Nullable="false"/><Property Name="Name" Type="Edm.String"/><Property Name="Amount" Type="Edm.Decimal"/></EntityType><EntityContainer Name="Container"><EntitySet Name="Orders" EntityType="Demo.Order"/></EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`;
}

function context(
	parameters: Record<string, unknown>,
	request: (options: IHttpRequestOptions) => Promise<unknown>,
	policy: string | undefined = '',
) {
	const params: Record<string, unknown> = {
		authentication: 'basicOrNone',
		resource: 'entity',
		operation: 'getMany',
		servicePath: path,
		entitySet: 'Orders',
		...parameters,
	};
	const creds = credentials({ servicePoliciesJson: policy });
	return {
		getInputData: () => [{ json: {} }],
		getNode: () => ({
			type: 'n8n-nodes-sap-odata-guard.sapOdataGuard',
			typeVersion: 1.3,
			credentials: {},
		}),
		getCredentials: async () => creds,
		getNodeParameter: (name: string, _index: number, fallback?: unknown) =>
			params[name] ?? fallback,
		getCurrentNodeParameter: (name: string) => params[name],
		continueOnFail: () => false,
		helpers: {
			httpRequest: request,
			httpRequestWithAuthentication: async (_credential: string, options: IHttpRequestOptions) =>
				await request(options),
		},
	} as unknown as IExecuteFunctions & ILoadOptionsFunctions;
}

test('blank, whitespace and omitted policies are optional; configured malformed policies still fail', () => {
	assert.equal(
		commonCredentialProperties.find((property) => property.name === 'servicePoliciesJson')
			?.required,
		undefined,
	);
	for (const value of ['', ' \n\t', undefined]) {
		const creds = credentials({ servicePoliciesJson: value });
		assert.equal(hasServicePolicies(creds), false);
		assert.equal(validateGovernanceConfiguration(creds).size, 0);
	}
	for (const value of ['{', '{}', '[]', 'null'])
		assert.throws(() =>
			validateGovernanceConfiguration(credentials({ servicePoliciesJson: value })),
		);
	assert.throws(() =>
		validateGovernanceConfiguration(credentials({ servicePoliciesJson: '', maxRows: 0 })),
	);
});

test('automatic schema detects versions, keys, write types and nullable fields', () => {
	for (const version of ['v2', 'v4']) {
		const service = automaticServicePolicyFromMetadata(path, metadata(version));
		assert.equal(service.version, version);
		const entity = service.entities.get('Orders')!;
		assert.deepEqual([...entity.operations], ['get', 'getMany', 'create', 'update', 'delete']);
		assert.equal(entity.keyFields.get('ID'), 'string');
		assert.equal(entity.createFields.get('Amount'), 'decimal');
		assert.equal(entity.updateFields.has('ID'), false);
		assert.equal(entity.nullableCreateFields.has('Name'), true);
		assert.equal(entity.nullableCreateFields.has('ID'), false);
	}
	assert.throws(
		() => automaticServicePolicyFromMetadata(path, '<html>Login</html>'),
		/Cannot detect/,
	);
	assert.throws(
		() => automaticServicePolicyFromMetadata('https://other.example/service', metadata()),
		/relative absolute/,
	);
	const xml = metadata().replace(
		'Name="Orders" EntityType="Demo.Order"',
		'Name="Orders" EntityType="Demo.Order" sap:creatable="false" sap:updatable="false" sap:deletable="false"',
	);
	assert.deepEqual(
		[...automaticServicePolicyFromMetadata(path, xml).entities.get('Orders')!.operations],
		['get', 'getMany'],
	);
});

test('explicit policies still reject unlisted services before metadata access', async () => {
	let calls = 0;
	const creds = credentials();
	await assert.rejects(
		() =>
			resolveServicePolicy(creds, validateGovernanceConfiguration(creds), path, async () => {
				calls++;
				return metadata();
			}),
		/not allowed/,
	);
	assert.equal(calls, 0);
});

test('blank policy loads entity and field selectors from SAP metadata, including OAuth', async () => {
	const node = new SapOdataGuard();
	const ctx = context({ authentication: 'oauth2' }, async () => metadata());
	assert.deepEqual(
		(await node.methods.loadOptions.getAllowedEntities.call(ctx)).map((option) => option.value),
		['Orders'],
	);
	assert.deepEqual(
		(await node.methods.loadOptions.getAllowedOutputFields.call(ctx)).map((option) => option.value),
		['ID', 'Name', 'Amount'],
	);
	assert.deepEqual(
		(await node.methods.loadOptions.getAllowedFilterFields.call(ctx)).map((option) => option.value),
		['ID', 'Name', 'Amount'],
	);
	assert.deepEqual(
		(await node.methods.loadOptions.getAllowedOrderByFields.call(ctx)).map(
			(option) => option.value,
		),
		['ID', 'Name', 'Amount'],
	);
	const writes = context({ operation: 'update' }, async () => metadata());
	assert.deepEqual(
		(await node.methods.loadOptions.getAllowedWriteFields.call(writes)).map(
			(option) => option.value,
		),
		['Name', 'Amount'],
	);
});

test('blank-policy reads project metadata fields, preserve filters and mark policyApplied false', async () => {
	const calls: IHttpRequestOptions[] = [];
	const ctx = context(
		{ filters: { values: [{ field: 'ID', operator: 'eq', value: '00123' }] } },
		async (options) => {
			calls.push(options);
			return options.url.includes('$metadata')
				? metadata()
				: {
						d: {
							results: [
								{
									ID: '00123',
									Name: 'Order',
									Amount: '10.50',
									Other: 'ignored',
								},
							],
						},
					};
		},
	);
	const result = await new SapOdataGuard().execute.call(ctx);
	assert.equal(calls.length, 2);
	assert.equal(new URL(calls[1].url).searchParams.get('$filter'), "(ID eq '00123')");
	assert.equal(result[0][0].json.ID, '00123');
	assert.equal(result[0][0].json.Other, undefined);
	assert.equal((result[0][0].json._odata as Record<string, unknown>).policyApplied, false);
});

test('automatic V4 reads negotiate precise numbers and connection tests fetch metadata just once', async () => {
	const calls: IHttpRequestOptions[] = [];
	const request = async (options: IHttpRequestOptions) => {
		calls.push(options);
		return options.url.includes('$metadata')
			? metadata('v4')
			: { value: [{ ID: '1', Amount: '999999999999999.123' }] };
	};
	await new SapOdataGuard().execute.call(context({}, request));
	assert.equal(calls[1].headers?.Accept, 'application/json;IEEE754Compatible=true');
	calls.length = 0;
	const result = await new SapOdataGuard().execute.call(
		context({ resource: 'connection', operation: 'testConnection' }, request),
	);
	assert.equal(calls.length, 1);
	assert.equal(result[0][0].json.connected, true);
});

test('automatic writes keep typed payloads, CSRF and exact If-Match checks', async () => {
	for (const operation of ['create', 'update', 'delete']) {
		const calls: IHttpRequestOptions[] = [];
		const ctx = context(
			{
				operation,
				keyJson: { ID: '00123' },
				dataJson: { Name: null, Amount: '10.50' },
				ifMatch: 'W/"1"',
			},
			async (options) => {
				calls.push(options);
				if (options.url.includes('$metadata')) return metadata();
				if (options.method === 'GET')
					return {
						statusCode: 200,
						headers: { 'x-csrf-token': 'csrf' },
						body: '',
					};
				return { statusCode: 204, headers: {}, body: '' };
			},
		);
		await new SapOdataGuard().execute.call(ctx);
		assert.equal(calls.length, 3);
		assert.equal(
			calls[2].method,
			operation === 'create' ? 'POST' : operation === 'update' ? 'PATCH' : 'DELETE',
		);
		assert.equal(calls[2].headers?.['X-CSRF-Token'], 'csrf');
		if (operation !== 'create') assert.equal(calls[2].headers?.['If-Match'], 'W/"1"');
		if (operation !== 'delete')
			assert.deepEqual(JSON.parse(calls[2].body as string), {
				Name: null,
				Amount: '10.50',
			});
	}
	await assert.rejects(
		() =>
			new SapOdataGuard().execute.call(
				context({ operation: 'delete', keyJson: { ID: '1' }, ifMatch: '*' }, async () =>
					metadata(),
				),
			),
		/Wildcard If-Match/,
	);
});

test('automatic mode does not hide metadata connection failures', async () => {
	await assert.rejects(
		() =>
			new SapOdataGuard().execute.call(
				context({}, async () => {
					throw new Error('connect ECONNREFUSED');
				}),
			),
		/refused the connection/,
	);
});

test('credential test without policy probes the host and explicitly limits its success message', async () => {
	let calls = 0;
	const ctx = {
		helpers: {
			request: async (options: { uri: string }) => {
				calls++;
				assert.equal(options.uri, 'https://sap.example.com/');
				return 'SAP';
			},
		},
	} as unknown as ICredentialTestFunctions;
	const result = await new SapOdataGuard().methods.credentialTest.sapOdataGuardConnectionTest.call(
		ctx,
		{
			id: 'optional-policy',
			data: credentials({ servicePoliciesJson: '' }),
		} as never,
	);
	assert.equal(calls, 1);
	assert.equal(result.status, 'OK');
	assert.match(result.message, /verify the selected OData service/);
});
