// Loopback-only, synthetic OData fixture. Run in the DEV n8n container; stop after acceptance.
const http = require('node:http');
const fs = require('node:fs');
const port = Number(process.env.ODATA_FIXTURE_PORT || 18784);
const service = '/sap/opu/odata/sap/Z_GUARD_FIXTURE';
const pidFile = process.env.ODATA_FIXTURE_PID_FILE;
let counts = {};
const xml =
	'<Schema Namespace="Fixture"><EntityType Name="Thing"><Key><PropertyRef Name="ID"/></Key><Property Name="ID" Type="Edm.Int64"/><Property Name="CreatedAt" Type="Edm.DateTimeOffset"/><Property Name="Clock" Type="Edm.Time"/></EntityType><EntityContainer><EntitySet Name="Things" EntityType="Fixture.Thing"/></EntityContainer></Schema>';
const server = http.createServer((req, res) => {
	const url = new URL(req.url, `http://127.0.0.1:${port}`);
	url.pathname = url.pathname.replace(/\/$/, '');
	const reply = (status, body, headers = {}) => {
		res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
		res.end(typeof body === 'string' ? body : JSON.stringify(body));
	};
	if (url.pathname === '/reset' && req.method === 'POST') {
		counts = {};
		return reply(200, { reset: true });
	}
	if (url.pathname === '/stats') return reply(200, counts);
	const key = `${req.method} ${url.pathname}`;
	counts[key] = (counts[key] || 0) + 1;
	if (url.pathname === `${service}/$metadata`)
		return reply(200, xml, { 'Content-Type': 'application/xml' });
	if (url.pathname === service)
		return reply(
			200,
			{},
			{ 'X-CSRF-Token': 'fixture-csrf', 'Set-Cookie': 'SESSION=fixture-cookie; Path=/; HttpOnly' },
		);
	if (req.method === 'GET' && url.pathname === `${service}/Things`) {
		if (counts[key] <= 2)
			return reply(
				503,
				{ error: { code: 'TEMPORARY', message: 'Retry this GET' } },
				{ 'Retry-After': '0' },
			);
		if (!/^\(?ID ge -9223372036854775808L\)?$/.test(url.searchParams.get('$filter') || ''))
			return reply(400, {
				error: { code: 'BAD_INT64_LITERAL', message: 'Expected precise V2 Int64 literal' },
			});
		const second = url.searchParams.has('$skiptoken');
		return reply(200, {
			d: {
				results: [
					{
						ID: second ? '-9223372036854775808' : '9223372036854775807',
						CreatedAt: second ? '/Date(0+0000)/' : '/Date(-1000+0000)/',
						Clock: 'PT0.5S',
						SecretField: 'must-be-projected-out',
					},
				],
				...(second ? {} : { __next: `${service}/Things?$skiptoken=second` }),
			},
		});
	}
	if (req.method === 'GET' && url.pathname === `${service}/Errors`)
		return reply(403, {
			error: {
				code: 'FIXTURE/DENIED',
				message: { value: 'No business authorization' },
				innererror: {
					errordetails: [{ code: 'AUTH/001', message: 'Missing role', target: 'ID' }],
					stack: 'must-not-be-output',
				},
			},
		});
	if (
		['POST', 'PATCH', 'DELETE'].includes(req.method) &&
		url.pathname.startsWith(`${service}/Things`)
	) {
		let body = '';
		req.on('data', (chunk) => {
			body += chunk;
		});
		req.on('end', () => {
			counts[`${req.method} csrf-cookie-valid`] = Number(
				req.headers['x-csrf-token'] === 'fixture-csrf' &&
					req.headers.cookie === 'SESSION=fixture-cookie',
			);
			if (body) {
				try {
					const data = JSON.parse(body);
					counts[`${req.method} int64-string`] = Number(
						!data.ID || data.ID === '9223372036854775807',
					);
				} catch {
					return reply(400, { error: { code: 'INVALID_JSON', message: 'Invalid JSON' } });
				}
			}
			// Simulate a failure after accepting a mutation: retrying would duplicate it.
			reply(
				503,
				{
					error: {
						code: 'FIXTURE/WRITE_FAILURE',
						message: { value: 'Write uncertain fixture-csrf fixture-cookie' },
						details: [{ code: 'DETAIL', message: 'fixture-csrf fixture-cookie' }],
					},
				},
				{ 'Retry-After': '0' },
			);
		});
		return;
	}
	if (req.method === 'GET' && url.pathname === '/v4/Things') {
		counts['V4 ieee754-request'] = Number(
			req.headers.accept === 'application/json;IEEE754Compatible=true',
		);
		return reply(
			200,
			{ value: [{ ID: '9223372036854775807', Amount: '12345678901234567890.250' }] },
			{ 'Content-Type': 'application/json;IEEE754Compatible=true' },
		);
	}
	reply(404, { error: { code: 'NOT_FOUND', message: 'No fixture route' } });
});
server.listen(port, '127.0.0.1', () => {
	if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
	console.log(`fixture_listening=127.0.0.1:${port}`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
