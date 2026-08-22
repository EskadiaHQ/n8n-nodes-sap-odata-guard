#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const credentialFile = process.argv[2];
if (!credentialFile) throw new Error('Usage: inspect-write-fixture.mjs <decrypted-export.json>');

const [row] = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
const credential = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
const headers = {
	accept: 'application/json',
	authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`,
};
if (credential.sapClient) headers['sap-client'] = credential.sapClient;
if (credential.sapLanguage) headers['sap-language'] = credential.sapLanguage;

const requestJson = (url) =>
	new Promise((resolve, reject) => {
		const transport = url.protocol === 'https:' ? https : http;
		const request = transport.request(
			url,
			{ headers, rejectUnauthorized: credential.allowUnauthorizedCerts !== true },
			(response) => {
				const chunks = [];
				response.on('data', (chunk) => chunks.push(chunk));
				response.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8');
					if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
						reject(
							new Error(
								`OData fixture request failed for ${url.pathname} with HTTP ${response.statusCode}`,
							),
						);
						return;
					}
					resolve(JSON.parse(text));
				});
			},
		);
		request.on('error', reject);
		request.end();
	});

const service = '/sap/opu/odata/sap/API_SALES_ORDER_SRV';
const headerUrl = new URL(`${service}/A_SalesOrder`, credential.host);
headerUrl.searchParams.set(
	'$select',
	'SalesOrder,SalesOrderType,SalesOrganization,DistributionChannel,OrganizationDivision,SoldToParty,PurchaseOrderByCustomer,SalesOrderDate,TransactionCurrency,to_Item',
);
headerUrl.searchParams.set('$expand', 'to_Item');
headerUrl.searchParams.set('$orderby', 'SalesOrder desc');
headerUrl.searchParams.set('$top', '1');
const headerPayload = await requestJson(headerUrl);
const salesOrder = headerPayload?.d?.results?.[0];
if (!salesOrder?.SalesOrder) throw new Error('No sales order fixture is available.');
const items = (salesOrder.to_Item?.results ?? []).slice(0, 5).map((item) => ({
	SalesOrder: item.SalesOrder,
	SalesOrderItem: item.SalesOrderItem,
	Material: item.Material,
	RequestedQuantity: item.RequestedQuantity,
	RequestedQuantityUnit: item.RequestedQuantityUnit,
	Plant: item.Plant,
}));
delete salesOrder.to_Item;
delete salesOrder.__metadata;

console.log(
	JSON.stringify({
		header: salesOrder,
		items,
	}),
);
