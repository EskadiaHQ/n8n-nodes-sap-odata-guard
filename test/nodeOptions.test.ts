import assert from 'node:assert/strict';
import test from 'node:test';

import { SapOdataGuard } from '../nodes/SapOdataGuard/SapOdataGuard.node';

function property(name: string) {
	const result = new SapOdataGuard().description.properties.find((entry) => entry.name === name);
	assert.ok(result, `Missing node property ${name}`);
	return result;
}

test('exposes credential-governed dynamic field selectors', () => {
	assert.deepEqual(new SapOdataGuard().description.version, [1, 1.1, 1.2]);
	const fields = new SapOdataGuard().description.properties.filter((entry) => entry.name === 'fields');
	assert.equal(fields.length, 2);
	assert.equal(fields[0].type, 'string');
	assert.equal(fields[1].type, 'multiOptions');
	assert.equal(fields[1].typeOptions?.loadOptionsMethod, 'getAllowedOutputFields');

	const filters = property('filters');
	const filterField = filters.options?.[0]?.values?.find((entry) => entry.name === 'field');
	assert.equal(filterField?.typeOptions?.loadOptionsMethod, 'getAllowedFilterFields');

	const orderBy = property('orderBy');
	const orderField = orderBy.options?.[0]?.values?.find((entry) => entry.name === 'field');
	assert.equal(orderField?.typeOptions?.loadOptionsMethod, 'getAllowedOrderByFields');

	const dataFields = property('dataFields');
	const writeField = dataFields.options?.[0]?.values?.find((entry) => entry.name === 'field');
	assert.equal(writeField?.typeOptions?.loadOptionsMethod, 'getAllowedWriteFields');
});

test('exposes a separate SAP catalog resource without weakening entity policies', () => {
	const resource = property('resource');
	assert.ok(resource.options?.some((option) => option.value === 'catalog'));
	const catalogService = property('catalogServicePath');
	assert.equal(catalogService.typeOptions?.loadOptionsMethod, 'getDiscoveredServices');
	const governedService = property('servicePath');
	assert.equal(governedService.typeOptions?.loadOptionsMethod, 'getAllowedServices');
});
