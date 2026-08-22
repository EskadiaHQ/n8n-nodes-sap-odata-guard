#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const credentialFile = process.argv[2];
if (!credentialFile) throw new Error('Usage: inspect-write-capabilities.mjs <decrypted-export.json>');

const [row] = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
const credential = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
const servicePaths = [
	'/sap/opu/odata/sap/API_BUSINESS_PARTNER',
	'/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV',
	'/sap/opu/odata/sap/API_SALES_ORDER_SRV',
	'/sap/opu/odata/sap/API_BILLING_DOCUMENT_SRV',
	'/sap/opu/odata/sap/API_PRODUCT_SRV',
];
const targetEntitySets = new Set([
	'A_BusinessPartner',
	'A_PurchaseOrder',
	'A_PurchaseOrderItem',
	'A_SalesOrder',
	'A_SalesOrderItem',
	'A_BillingDocument',
	'A_Product',
]);

const headers = {
	accept: 'application/xml',
	authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`,
};
if (credential.sapClient) headers['sap-client'] = credential.sapClient;
if (credential.sapLanguage) headers['sap-language'] = credential.sapLanguage;

const attribute = (source, name) => {
	const match = new RegExp(`(?:\\w+:)?${name}=["']([^"']*)["']`, 'i').exec(source);
	return match?.[1];
};
const escapeRegex = (value) => value.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
const result = [];

const requestText = (url) =>
	new Promise((resolve, reject) => {
		const transport = url.protocol === 'https:' ? https : http;
		const request = transport.request(
			url,
			{
				headers,
				rejectUnauthorized: credential.allowUnauthorizedCerts !== true,
			},
			(response) => {
				const chunks = [];
				response.on('data', (chunk) => chunks.push(chunk));
				response.on('end', () =>
					resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
				);
			},
		);
		request.on('error', reject);
		request.end();
	});

for (const servicePath of servicePaths) {
	const response = await requestText(new URL(`${servicePath}/$metadata`, credential.host));
	const xml = response.text;
	if (response.status < 200 || response.status >= 300) {
		result.push({ servicePath, status: response.status, error: 'metadata request failed' });
		continue;
	}
	const entitySets = [];
	for (const match of xml.matchAll(/<EntitySet\b([^>]*)\/?\s*>/gi)) {
		const attributes = match[1];
		const name = attribute(attributes, 'Name');
		const entityType = attribute(attributes, 'EntityType');
		if (!name || !entityType) continue;
		const creatable = attribute(attributes, 'creatable');
		const updatable = attribute(attributes, 'updatable');
		const deletable = attribute(attributes, 'deletable');
		if (
			!targetEntitySets.has(name) &&
			![creatable, updatable, deletable].some((value) => value?.toLowerCase() === 'true')
		) {
			continue;
		}
		const typeName = entityType.split('.').pop();
		const typeMatch = new RegExp(
			`<EntityType\\b[^>]*\\bName=["']${escapeRegex(typeName ?? '')}["'][^>]*>([\\s\\S]*?)<\\/EntityType>`,
			'i',
		).exec(xml);
		const block = typeMatch?.[1] ?? '';
		const keys = [...block.matchAll(/<PropertyRef\b[^>]*\bName=["']([^"']+)["']/gi)].map(
			(entry) => entry[1],
		);
		const requiredProperties = [...block.matchAll(/<Property\b([^>]*)\/?\s*>/gi)]
			.map((entry) => ({
				name: attribute(entry[1], 'Name'),
				type: attribute(entry[1], 'Type'),
				nullable: attribute(entry[1], 'Nullable') !== 'false',
				creatable: attribute(entry[1], 'creatable'),
				updatable: attribute(entry[1], 'updatable'),
			}))
			.filter((property) => property.name && (!property.nullable || property.creatable === 'true'));
		const navigationProperties = [
			...block.matchAll(/<NavigationProperty\b[^>]*\bName=["']([^"']+)["']/gi),
		].map((entry) => entry[1]);
		entitySets.push({
			name,
			entityType,
			creatable,
			updatable,
			deletable,
			keys,
			requiredProperties,
			navigationProperties,
		});
	}
	result.push({ servicePath, status: response.status, entitySets });
}

console.log(JSON.stringify(result));
