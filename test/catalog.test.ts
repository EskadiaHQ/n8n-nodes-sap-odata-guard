import assert from 'node:assert/strict';
import test from 'node:test';

import { readOnlyPolicyTemplateFromMetadata } from '../nodes/SapOdataGuard/catalog';
import { requestServiceCatalog } from '../nodes/SapOdataGuard/client';
import { credentials } from './fixtures';

test('catalog discovery is a separate credential opt-in', async () => {
	await assert.rejects(
		() => requestServiceCatalog(async () => ({ d: { results: [] } }), credentials()),
		/discovery is disabled/,
	);
});

test('parses and bounds SAP Gateway catalog services', async () => {
	const result = await requestServiceCatalog(
		async () => ({
			d: {
				results: [
					{
						ID: 'API_BUSINESS_PARTNER',
						Title: 'Business Partner API',
						TechnicalServiceName: 'API_BUSINESS_PARTNER',
						TechnicalServiceVersion: '1',
						ServiceUrl: 'https://sap.example.com/sap/opu/odata/sap/API_BUSINESS_PARTNER/',
					},
					{
						ID: 'API_SALES_ORDER_SRV',
						Title: 'Sales Order API',
						TechnicalServiceName: 'API_SALES_ORDER_SRV',
						TechnicalServiceVersion: '2',
					},
				],
			},
		}),
		credentials({ allowServiceDiscovery: true, maxCatalogServices: 2 }),
	);
	assert.equal(result.services.length, 2);
	assert.deepEqual(
		result.services.map((service) => service.servicePath),
		[
			'/sap/opu/odata/sap/API_BUSINESS_PARTNER',
			'/sap/opu/odata/sap/API_SALES_ORDER_SRV;v=2',
		],
	);
});

test('generates a reviewable read-only policy template from metadata', () => {
	const xml = `
		<Schema Namespace="Demo">
			<EntityType Name="SalesOrder">
				<Key><PropertyRef Name="SalesOrder" /></Key>
				<Property Name="SalesOrder" Type="Edm.String" Nullable="false" />
				<Property Name="TotalNetAmount" Type="Edm.Decimal" />
				<Property Name="CreationDate" Type="Edm.DateTime" />
				<NavigationProperty Name="to_Item" Type="Collection(Demo.Item)" />
			</EntityType>
			<EntityContainer Name="Container">
				<EntitySet Name="A_SalesOrder" EntityType="Demo.SalesOrder" />
			</EntityContainer>
		</Schema>`;
	const result = readOnlyPolicyTemplateFromMetadata(
		'/sap/opu/odata/sap/API_SALES_ORDER_SRV',
		'v2',
		xml,
	);
	assert.equal(result.entityCount, 1);
	assert.equal(result.fieldCount, 3);
	assert.deepEqual(result.policy, {
		'/sap/opu/odata/sap/API_SALES_ORDER_SRV': {
			version: 'v2',
			allowMetadata: true,
			entities: {
				A_SalesOrder: {
					operations: ['get', 'getMany'],
					fields: ['SalesOrder', 'TotalNetAmount', 'CreationDate'],
					keyFields: { SalesOrder: 'string' },
					filterFields: {
						SalesOrder: 'string',
						TotalNetAmount: 'decimal',
						CreationDate: 'datetime',
					},
					orderByFields: ['SalesOrder', 'TotalNetAmount', 'CreationDate'],
					requiredFilters: [],
				},
			},
		},
	});
});
