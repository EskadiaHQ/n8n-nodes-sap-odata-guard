#!/usr/bin/env node

import fs from 'node:fs';

const credentialFile = process.argv[2];
if (!credentialFile) throw new Error('Usage: inspect-live-metadata.mjs <decrypted-export.json>');

const [row] = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
const credential = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
const targets = [
	['/sap/opu/odata/sap/API_BUSINESS_PARTNER/', 'A_BusinessPartner'],
	['/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV/', 'A_PurchaseOrder'],
	['/sap/opu/odata/sap/API_SALES_ORDER_SRV/', 'A_SalesOrder'],
	['/sap/opu/odata/sap/API_BILLING_DOCUMENT_SRV/', 'A_BillingDocument'],
	['/sap/opu/odata/sap/API_PRODUCT_SRV/', 'A_Product'],
];

let customHeaders = {};
try {
	customHeaders = JSON.parse(credential.customHeaders || '{}');
} catch {
	// The source Avanai credential has no custom headers in this acceptance environment.
}

const headers = {
	...customHeaders,
	accept: 'application/xml',
	authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`,
};
if (credential.sapClient) headers['sap-client'] = credential.sapClient;
if (credential.sapLanguage) headers['sap-language'] = credential.sapLanguage;

const escapeRegex = (value) => value.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
const result = [];

for (const [servicePath, entitySet] of targets) {
	const response = await fetch(new URL(`${servicePath}$metadata`, credential.host), { headers });
	const xml = await response.text();
	if (!response.ok) {
		result.push({ servicePath, entitySet, status: response.status, error: 'metadata request failed' });
		continue;
	}

	const setMatch = new RegExp(
		`<EntitySet\\b[^>]*\\bName=["']${escapeRegex(entitySet)}["'][^>]*\\bEntityType=["']([^"']+)["'][^>]*/?>`,
		'i',
	).exec(xml);
	const typeName = (setMatch?.[1] ?? '').split('.').pop();
	const typeMatch = new RegExp(
		`<EntityType\\b[^>]*\\bName=["']${escapeRegex(typeName ?? '')}["'][^>]*>([\\s\\S]*?)<\\/EntityType>`,
		'i',
	).exec(xml);
	const block = typeMatch?.[1] ?? '';
	const keys = [...block.matchAll(/<PropertyRef\b[^>]*\bName=["']([^"']+)["']/gi)].map(
		(match) => match[1],
	);
	const properties = [
		...block.matchAll(
			/<Property\b[^>]*\bName=["']([^"']+)["'][^>]*\bType=["']([^"']+)["'][^>]*\/?>/gi,
		),
	].map((match) => ({ name: match[1], type: match[2] }));

	result.push({
		servicePath: servicePath.replace(/\/$/, ''),
		entitySet,
		status: response.status,
		metadataBytes: Buffer.byteLength(xml),
		typeName,
		keys,
		propertyCount: properties.length,
		properties,
	});
}

console.log(JSON.stringify(result));
