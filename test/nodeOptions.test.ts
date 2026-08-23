import assert from 'node:assert/strict';
import test from 'node:test';

import { SapOdataGuard } from '../nodes/SapOdataGuard/SapOdataGuard.node';

function property(name: string) {
	const result = new SapOdataGuard().description.properties.find((entry) => entry.name === name);
	assert.ok(result, `Missing node property ${name}`);
	return result;
}

test('exposes credential-governed dynamic field selectors', () => {
	assert.equal(property('fields').type, 'multiOptions');
	assert.equal(property('fields').typeOptions?.loadOptionsMethod, 'getAllowedOutputFields');

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
