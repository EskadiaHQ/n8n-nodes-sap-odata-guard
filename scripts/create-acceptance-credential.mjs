#!/usr/bin/env node

import fs from 'node:fs';

const [sourceFile, policyFile, outputFile] = process.argv.slice(2);
if (!sourceFile || !policyFile || !outputFile) {
	throw new Error(
		'Usage: create-acceptance-credential.mjs <decrypted-source.json> <policy.json> <output.json>',
	);
}

const [source] = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
const sourceData = typeof source.data === 'string' ? JSON.parse(source.data) : source.data;
const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));

const credential = {
	id: 'ODataGuardAcc001',
	name: 'Logali SAP OData Guard - Acceptance Governed CRUD',
	type: 'sapOdataGuardApi',
	data: {
		host: sourceData.host,
		authMode: 'basicAuth',
		username: sourceData.username,
		password: sourceData.password,
		sapClient: sourceData.sapClient || '',
		sapLanguage: sourceData.sapLanguage || '',
		servicePoliciesJson: JSON.stringify(policy),
		allowPrivateNetwork: false,
		allowInsecureHttp: false,
		rejectUnauthorized: !sourceData.allowUnauthorizedCerts,
		maxRows: 25,
		maxPages: 3,
		maxUrlLength: 8192,
		maxResponseBytes: 1048576,
		maxRequestBytes: 131072,
		maxWrites: 10,
		requestTimeout: 30000,
		allowAiTool: false,
		allowAiMetadata: false,
		allowAiWrites: false,
		aiToolMaxRows: 10,
		aiToolMaxBytes: 131072,
		aiToolMaxWrites: 1
	},
	isManaged: false
};

fs.writeFileSync(outputFile, `${JSON.stringify([credential])}\n`, { mode: 0o600 });
console.log(JSON.stringify({ id: credential.id, name: credential.name, type: credential.type }));
