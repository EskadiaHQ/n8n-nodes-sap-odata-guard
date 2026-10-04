import assert from 'node:assert/strict';
import test from 'node:test';
import type { IExecuteFunctions, IHttpRequestOptions } from 'n8n-workflow';
import { SapOdataGuard } from '../nodes/SapOdataGuard/SapOdataGuard.node';
import { readOnlyPolicyTemplateFromMetadata } from '../nodes/SapOdataGuard/catalog';
import { requestMetadata, requestMutation, requestSingle } from '../nodes/SapOdataGuard/client';
import { cachedDiscovery } from '../nodes/SapOdataGuard/discoveryCache';
import { SapODataRequestError } from '../nodes/SapOdataGuard/errors';
import {
	parseServicePolicies,
	validateGovernanceConfiguration,
	validateWritePayload,
} from '../nodes/SapOdataGuard/governance';
import { formatODataLiteral } from '../nodes/SapOdataGuard/query';
import { requestWithPolicy } from '../nodes/SapOdataGuard/resilience';
import { normalizeOutputDates, timeDuration } from '../nodes/SapOdataGuard/scalars';
import { credentials } from './fixtures';

const maximum = '9223372036854775807';
const minimum = '-9223372036854775808';
const url = 'https://sap.example.com/service/Things';
const request: IHttpRequestOptions = { method: 'GET', url, timeout: 30000 };
const busy = { statusCode: 503, response: { headers: { 'Retry-After': '0' } } };

test('Int64 literals preserve both boundaries and reject unsafe numeric input', () => {
	assert.equal(formatODataLiteral(maximum, 'int64', 'v2'), `${maximum}L`);
	assert.equal(formatODataLiteral(minimum, 'int64', 'v4'), minimum);
	for (const value of ['9223372036854775808', '-9223372036854775809', '1e3', Number(maximum)])
		assert.throws(() => formatODataLiteral(value, 'int64', 'v2'));
	assert.throws(() => formatODataLiteral(maximum, 'number', 'v2'), /precision/);
	assert.throws(() => formatODataLiteral(Number(maximum), 'decimal', 'v2'), /precision/);
	assert.equal(formatODataLiteral('00123', 'string', 'v2'), "'00123'");
});

test('new EDM date and time literals retain version and timezone semantics', () => {
	assert.equal(
		formatODataLiteral('2026-10-04T14:30:00', 'datetime-local', 'v2'),
		"datetime'2026-10-04T14:30:00'",
	);
	assert.equal(
		formatODataLiteral('2026-10-04T14:30:00+02:00', 'datetimeoffset', 'v2'),
		"datetimeoffset'2026-10-04T14:30:00+02:00'",
	);
	assert.equal(formatODataLiteral('PT0.5S', 'time', 'v2'), "time'PT00H00M00.5S'");
	assert.equal(formatODataLiteral('14:30:00.125', 'timeofday', 'v4'), '14:30:00.125');
	assert.equal(timeDuration('PT5M'), '00:05:00');
	for (const [value, type] of [
		['2026-02-30', 'date'],
		['2026-10-04T24:00:00', 'datetime-local'],
		['2026-10-04T14:30:00Z', 'datetime-local'],
		['2026-10-04T14:30:00+14:01', 'datetimeoffset'],
		['PT24H', 'time'],
	] as const)
		assert.throws(() => formatODataLiteral(value, type, 'v2'));
	// Existing policy type retains its previous behavior.
	assert.equal(
		formatODataLiteral('2026-10-04T14:30:00Z', 'datetime', 'v2'),
		"datetimeoffset'2026-10-04T14:30:00.000Z'",
	);
});

function writeEntity() {
	return parseServicePolicies(
		JSON.stringify({
			'/service': {
				version: 'v2',
				entities: {
					Things: {
						operations: ['create'],
						fields: ['ID'],
						createFields: {
							ID: 'int64',
							Amount: 'decimal',
							Local: 'datetime-local',
							Offset: 'datetimeoffset',
							Clock: 'time',
						},
					},
				},
			},
		}),
	)
		.get('/service')!
		.entities.get('Things')!;
}

test('writes preserve typed values and refuse V2 sub-millisecond truncation', () => {
	const entity = writeEntity();
	const payload = {
		ID: maximum,
		Amount: '12345678901234567890.250',
		Local: '1970-01-01T00:00:00',
		Offset: '1970-01-01T01:00:00+01:00',
		Clock: 'PT0.5S',
	};
	assert.deepEqual(validateWritePayload(payload, entity, 'create', 'v2', 4096), {
		...payload,
		Local: '/Date(0)/',
		Offset: '/Date(0+0000)/',
		Clock: 'PT00H00M00.5S',
	});
	assert.throws(
		() => validateWritePayload({ Local: '2026-10-04T00:00:00.1234' }, entity, 'create', 'v2', 4096),
		/sub-millisecond/,
	);
	assert.equal(
		validateWritePayload(
			{ Offset: '2026-10-04T00:00:00.1234567Z', ID: maximum, Amount: payload.Amount },
			entity,
			'create',
			'v4',
			4096,
		).Offset,
		'2026-10-04T00:00:00.1234567Z',
	);
});

test('metadata keeps namespace, scalar types, and complete composite keys', () => {
	const xml = `<Schema Namespace="First" Alias="F"><EntityType Name="Thing"><Key><PropertyRef Name="ID"/><PropertyRef Name="BinaryKey"/></Key><Property Name="ID" Type="Edm.Int64"/><Property Name="BinaryKey" Type="Edm.Binary"/><Property Name="Local" Type="Edm.DateTime"/><Property Name="Offset" Type="Edm.DateTimeOffset"/><Property Name="Clock" Type="Edm.Time"/><Property Name="Names" Type="Collection(Edm.String)"/></EntityType><EntitySet Name="FirstThings" EntityType="F.Thing"/></Schema><Schema Namespace="Second"><EntityType Name="Thing"><Key><PropertyRef Name="Code"/></Key><Property Name="Code" Type="Edm.String"/></EntityType><EntitySet Name="SecondThings" EntityType="Second.Thing"/></Schema>`;
	const policy = parseServicePolicies(
		JSON.stringify(readOnlyPolicyTemplateFromMetadata('/service', 'v2', xml).policy),
	);
	const first = policy.get('/service')!.entities.get('FirstThings')!;
	assert.deepEqual([...first.operations], ['getMany']);
	assert.equal(first.keyFields.size, 0);
	assert.equal(first.filterFields.get('ID'), 'int64');
	assert.equal(first.outputTypes.get('Local'), 'datetime-local');
	assert.equal(first.outputTypes.get('Offset'), 'datetimeoffset');
	assert.equal(first.outputTypes.get('Clock'), 'time');
	assert.equal(first.fields.includes('Names'), false);
	assert.deepEqual(policy.get('/service')!.entities.get('SecondThings')!.fields, ['Code']);
});

test('date output conversion is typed, non-mutating, and handles negative ticks', () => {
	const raw = {
		ID: '00123',
		Large: maximum,
		Created: '/Date(-1000)/',
		Local: '/Date(0)/',
		Day: '/Date(0)/',
		Clock: 'PT0.5S',
		Untyped: '/Date(0)/',
		Invalid: '/Date(999999999999999999999)/',
		Null: null,
	};
	const normalized = normalizeOutputDates(
		raw,
		new Map([
			['Created', 'datetimeoffset'],
			['Local', 'datetime-local'],
			['Day', 'date'],
			['Clock', 'time'],
			['Invalid', 'datetimeoffset'],
			['Null', 'datetimeoffset'],
		]),
	);
	assert.deepEqual(normalized, {
		...raw,
		Created: '1969-12-31T23:59:59.000Z',
		Local: '1970-01-01T00:00:00.000',
		Day: '1970-01-01',
		Clock: '00:00:00.5',
	});
	assert.equal(raw.Created, '/Date(-1000)/');
	assert.equal(
		normalizeOutputDates({ Created: '/Date(0+0060)/' }, new Map([['Created', 'datetimeoffset']]))
			.Created,
		'1970-01-01T00:00:00.000Z',
	);
});

test('SAP errors retain bounded business details and redact credentials and session data', () => {
	const secret = 'secret/password';
	const creds = credentials({ password: secret, oauthTokenData: { access_token: 'oauth-value' } });
	const error = new SapODataRequestError(
		{
			response: {
				status: 412,
				data: {
					error: {
						code: 'BUSINESS/001',
						message: { value: `Rejected ${encodeURIComponent(secret)}` },
						innererror: {
							stack: 'private-stack',
							errordetails: Array.from({ length: 12 }, () => ({
								code: 'DETAIL',
								message: 'oauth-value csrf-value session-value',
								target: 'ID',
							})),
						},
					},
				},
			},
		},
		creds,
		['csrf-value', 'session-value'],
	);
	const json = JSON.stringify(error.toJSON());
	assert.equal(error.statusCode, 412);
	assert.equal(error.sapCode, 'BUSINESS/001');
	assert.equal(error.details.length, 8);
	assert.match(error.hint!, /ETag/);
	for (const sensitive of [
		secret,
		encodeURIComponent(secret),
		'oauth-value',
		'csrf-value',
		'session-value',
		'private-stack',
	])
		assert.equal(json.includes(sensitive), false);
	assert.match(json, /REDACTED/);
});

test('read retries honor Retry-After, stop on authorization errors, and default off', async () => {
	let calls = 0;
	assert.equal(
		await requestWithPolicy(
			async () => {
				if (++calls < 3) throw busy;
				return 'ok';
			},
			request,
			credentials({ readRetryAttempts: 2 }),
		),
		'ok',
	);
	assert.equal(calls, 3);
	for (const status of [401, 403, 404, 500]) {
		calls = 0;
		await assert.rejects(() =>
			requestWithPolicy(
				async () => {
					calls++;
					throw { statusCode: status };
				},
				request,
				credentials({ readRetryAttempts: 3 }),
			),
		);
		assert.equal(calls, 1);
	}
	calls = 0;
	await assert.rejects(() =>
		requestWithPolicy(
			async () => {
				calls++;
				throw busy;
			},
			request,
			credentials(),
		),
	);
	assert.equal(calls, 1);
});

test('POST, PATCH, and DELETE are never retried even with GET retries enabled', async () => {
	for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
		let writes = 0;
		await assert.rejects(() =>
			requestMutation(
				async (options) => {
					if (options.method === 'GET')
						return {
							statusCode: 200,
							headers: { 'x-csrf-token': 'token', 'set-cookie': 'SESSION=one' },
							body: '',
						};
					writes++;
					throw busy;
				},
				credentials({ readRetryAttempts: 3 }),
				'/service',
				method,
				url,
				method === 'DELETE' ? undefined : { ID: maximum },
				'*',
			),
		);
		assert.equal(writes, 1);
	}
});

test('mutation errors redact individual cookie values as well as the Cookie header', async () => {
	await assert.rejects(
		() =>
			requestMutation(
				async (options) => {
					if (options.method === 'GET')
						return {
							statusCode: 200,
							headers: {
								'x-csrf-token': 'csrf-value',
								'set-cookie': ['SESSION=first-cookie; Path=/', 'OTHER=second-cookie; Path=/'],
							},
							body: '',
						};
					throw {
						statusCode: 503,
						body: {
							error: {
								code: 'WRITE_FAILURE',
								message: 'csrf-value first-cookie second-cookie',
								details: [{ code: 'DETAIL', message: 'first-cookie second-cookie' }],
							},
						},
					};
				},
				credentials(),
				'/service',
				'POST',
				url,
				{ ID: maximum },
			),
		(error: SapODataRequestError) => {
			const json = JSON.stringify(error.toJSON());
			assert.equal(error.statusCode, 503);
			for (const secret of ['csrf-value', 'first-cookie', 'second-cookie'])
				assert.equal(json.includes(secret), false);
			return true;
		},
	);
});

test('elapsed time and call budgets bound Retry-After and subsequent pages', async () => {
	let calls = 0;
	await assert.rejects(() =>
		requestWithPolicy(
			async () => {
				calls++;
				throw { statusCode: 429, headers: { 'Retry-After': '120' } };
			},
			request,
			credentials({ readRetryAttempts: 3, maxReadElapsedMs: 1000 }),
		),
	);
	assert.equal(calls, 1);
	const creds = credentials({ maxHttpRequests: 2 });
	await requestWithPolicy(async () => 'ok', request, creds);
	await requestWithPolicy(async () => 'ok', request, creds);
	await assert.rejects(
		() =>
			requestWithPolicy(
				async () => {
					throw Error('must not run');
				},
				request,
				creds,
			),
		/request-count budget/,
	);
});

test('request pacing is shared by dependent requests within an item', async () => {
	const creds = credentials({ minRequestIntervalMs: 25 });
	const timestamps: number[] = [];
	const http = async () => {
		timestamps.push(Date.now());
		return 'ok';
	};
	await requestWithPolicy(http, request, creds);
	await requestWithPolicy(http, request, creds);
	assert.ok(timestamps[1] - timestamps[0] >= 24);
});

test('V4 JSON negotiates string Int64 and Decimal serialization', async () => {
	const creds = credentials({
		servicePoliciesJson: JSON.stringify({ '/service': { version: 'v4', entities: {} } }),
	});
	await requestSingle(
		async (options) => {
			assert.equal(options.headers!.Accept, 'application/json;IEEE754Compatible=true');
			return { ID: maximum };
		},
		creds,
		url,
	);
	await requestMutation(
		async (options) => {
			if (options.method === 'GET')
				return {
					statusCode: 200,
					headers: { 'x-csrf-token': 'token', 'set-cookie': 'SESSION=one' },
					body: '',
				};
			assert.equal(options.headers!['Content-Type'], 'application/json;IEEE754Compatible=true');
			assert.equal(options.body, JSON.stringify({ ID: maximum, Amount: '1.250' }));
			return { statusCode: 201, headers: {}, body: '{}' };
		},
		creds,
		'/service',
		'POST',
		url,
		{ ID: maximum, Amount: '1.250' },
	);
});

test('discovery cache is opt-in, isolates credentials and returns independent copies', async () => {
	let calls = 0;
	const load = async () => ({ fields: [++calls] });
	const creds = credentials({ allowDiscoveryCache: true, cacheIdentity: 'cache-isolation' });
	const a = await cachedDiscovery(creds, 'metadata', load);
	a.fields.push(999);
	assert.deepEqual(await cachedDiscovery({ ...creds }, 'metadata', load), { fields: [1] });
	await cachedDiscovery({ ...creds, password: 'changed' }, 'metadata', load);
	await cachedDiscovery({ ...creds, cacheIdentity: 'different' }, 'metadata', load);
	await cachedDiscovery({ ...creds, cacheIdentity: undefined }, 'metadata', load);
	await cachedDiscovery({ ...creds, cacheIdentity: undefined }, 'metadata', load);
	await cachedDiscovery({ ...creds, allowDiscoveryCache: false }, 'metadata', load);
	assert.equal(calls, 6);
});

test('fresh metadata bypasses cache and failed loads never poison it', async () => {
	const creds = credentials({ allowDiscoveryCache: true, cacheIdentity: 'metadata-fresh' });
	let calls = 0;
	const load = async () => `<Schema value="${++calls}"/>`;
	await requestMetadata(load, creds, '/service');
	await requestMetadata(load, { ...creds }, '/service');
	assert.equal(calls, 1);
	await requestMetadata(load, creds, '/service', true);
	await requestMetadata(load, creds, '/service');
	assert.equal(calls, 3);
	await assert.rejects(() =>
		cachedDiscovery(creds, 'failures', async () => {
			throw Error('failed');
		}),
	);
	assert.equal(await cachedDiscovery(creds, 'failures', async () => 'recovered'), 'recovered');
});

test('cache coalesces loads and a forced refresh invalidates older in-flight work', async () => {
	const creds = credentials({ allowDiscoveryCache: true, cacheIdentity: 'cache-race' });
	let finish!: (value: string) => void;
	const slow = new Promise<string>((resolve) => {
		finish = resolve;
	});
	const a = cachedDiscovery(creds, 'race', () => slow);
	const b = cachedDiscovery(creds, 'race', async () => {
		throw Error('duplicate load');
	});
	assert.equal(await cachedDiscovery(creds, 'race', async () => 'fresh', true), 'fresh');
	finish('stale');
	assert.equal(await a, 'stale');
	assert.equal(await b, 'stale');
	assert.equal(await cachedDiscovery(creds, 'race', async () => 'current'), 'current');
});

test('cache expiry and entry/size limits evict or bypass old discovery', async () => {
	const creds = credentials({
		allowDiscoveryCache: true,
		cacheIdentity: 'cache-limits',
		discoveryCacheTtlSeconds: 0.01,
	});
	await cachedDiscovery(creds, 'expiry', async () => 'old');
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(await cachedDiscovery(creds, 'expiry', async () => 'new'), 'new');
	for (let i = 0; i < 70; i++)
		await cachedDiscovery({ ...creds, discoveryCacheTtlSeconds: 60 }, `entry-${i}`, async () => i);
	assert.equal(
		await cachedDiscovery(
			{ ...creds, discoveryCacheTtlSeconds: 60 },
			'entry-0',
			async () => 'evicted',
		),
		'evicted',
	);
	const large = 'x'.repeat(8 * 1024 * 1024);
	await cachedDiscovery(creds, 'large', async () => large);
	assert.equal(await cachedDiscovery(creds, 'large', async () => 'not-cached'), 'not-cached');
});

test('credential defaults retain old workflows and validate new bounds', () => {
	assert.doesNotThrow(() => validateGovernanceConfiguration(credentials()));
	for (const overrides of [
		{ readRetryAttempts: 4 },
		{ discoveryCacheTtlSeconds: 301 },
		{ minRequestIntervalMs: -1 },
		{ maxHttpRequests: 1 },
		{ maxReadElapsedMs: 999 },
	])
		assert.throws(() => validateGovernanceConfiguration(credentials(overrides)));
	assert.throws(
		() =>
			parseServicePolicies(
				JSON.stringify({
					'/service': {
						version: 'v2',
						entities: {
							Things: { operations: ['getMany'], fields: ['ID'], outputTypes: { Secret: 'date' } },
						},
					},
				}),
			),
		/absent from approved fields/,
	);
});

test('connection checks always make a fresh request and Continue On Fail exposes safe details', async () => {
	const creds = credentials({ allowDiscoveryCache: true });
	let calls = 0;
	const context = {
		getInputData: () => [{ json: {} }],
		getNode: () => ({
			type: 'n8n-nodes-sap-odata-guard.sapOdataGuard',
			credentials: { sapOdataGuardApi: { id: 'connection-runtime' } },
		}),
		getCredentials: async () => creds,
		getNodeParameter: (name: string, _index: number, fallback?: unknown) =>
			(
				({
					authentication: 'basicOrNone',
					resource: 'connection',
					operation: 'test',
					servicePath: '/sap/opu/odata/sap/API_BUSINESS_PARTNER',
				}) as Record<string, unknown>
			)[name] ?? fallback,
		continueOnFail: () => true,
		helpers: {
			httpRequest: async () => {
				calls++;
				throw {
					statusCode: 403,
					body: { error: { code: 'DENIED', message: { value: 'No permission secret' } } },
				};
			},
		},
	} as unknown as IExecuteFunctions;
	const node = new SapOdataGuard();
	const output = await node.execute.call(context);
	await node.execute.call(context);
	assert.equal(calls, 2);
	assert.equal(output[0][0].json.statusCode, 403);
	assert.equal(output[0][0].json.sapCode, 'DENIED');
	assert.equal(JSON.stringify(output).includes('secret'), false);
});
