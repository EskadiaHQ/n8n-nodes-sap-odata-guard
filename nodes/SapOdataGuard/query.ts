import { OperationalError } from 'n8n-workflow';

import { assertIdentifier, validateTypedValue } from './governance';
import type {
	EntityPolicy,
	FilterLogic,
	FilterOperator,
	ODataValueType,
	ODataVersion,
	UiFilter,
	UiOrderBy,
} from './types';

function collectionValues<T>(value: unknown): T[] {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
	const values = (value as { values?: unknown }).values;
	return Array.isArray(values) ? (values as T[]) : [];
}

export function normalizeUiFilters(value: unknown): UiFilter[] {
	return collectionValues<Record<string, unknown>>(value).map((entry, index) => {
		const field = assertIdentifier(entry.field, `Filter ${index + 1} field`);
		const operator = String(entry.operator ?? '') as FilterOperator;
		if (!['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'contains', 'startsWith', 'endsWith'].includes(operator)) {
			throw new OperationalError(`Filter ${index + 1} contains an unsupported operator.`);
		}
		return { field, operator, value: entry.value };
	});
}

export function normalizeUiOrderBy(value: unknown): UiOrderBy[] {
	return collectionValues<Record<string, unknown>>(value).map((entry, index) => {
		const field = assertIdentifier(entry.field, `Sort ${index + 1} field`);
		const direction = String(entry.direction ?? '').toLowerCase();
		if (direction !== 'asc' && direction !== 'desc') {
			throw new OperationalError(`Sort ${index + 1} direction must be asc or desc.`);
		}
		return { field, direction };
	});
}

export function selectedFieldsFromInput(value: unknown, policy: EntityPolicy): string[] {
	const requested = String(value ?? '')
		.split(',')
		.map((field) => field.trim())
		.filter(Boolean)
		.map((field) => assertIdentifier(field, 'Selected field'));
	const selected = requested.length === 0 ? [...policy.fields] : [...new Set(requested)];
	for (const field of selected) {
		if (!policy.fields.includes(field)) {
			throw new OperationalError(`Field ${field} is not allowed for entity ${policy.name}.`);
		}
	}
	return selected;
}

function stringLiteral(value: unknown): string {
	return `'${String(value).replace(/'/g, "''")}'`;
}

export function formatODataLiteral(
	value: unknown,
	type: ODataValueType,
	version: ODataVersion,
): string {
	validateTypedValue(value, type, 'OData value');
	if (type === 'string') return stringLiteral(value);
	if (type === 'number') return String(Number(value));
	if (type === 'boolean') return String(value).toLowerCase();
	if (type === 'guid') return version === 'v2' ? `guid'${String(value)}'` : String(value);
	if (type === 'date') {
		return version === 'v2' ? `datetime'${String(value)}T00:00:00'` : String(value);
	}
	const iso = new Date(String(value)).toISOString();
	return version === 'v2' ? `datetimeoffset'${iso}'` : iso;
}

export function buildKeyPredicate(
	keyJson: unknown,
	policy: EntityPolicy,
	version: ODataVersion,
): string {
	let parsed: unknown;
	try {
		parsed = typeof keyJson === 'string' ? JSON.parse(keyJson) : keyJson;
	} catch {
		// This is local node-parameter validation, not an API failure.
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
		throw new OperationalError('Key JSON must be valid JSON.');
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new OperationalError('Key JSON must be an object.');
	}
	const values = parsed as Record<string, unknown>;
	const expected = [...policy.keyFields.keys()];
	if (expected.length === 0) {
		throw new OperationalError(`Entity ${policy.name} has no key fields authorized for Get.`);
	}
	const actual = Object.keys(values);
	const unknown = actual.filter((field) => !policy.keyFields.has(field));
	const missing = expected.filter(
		(field) => !Object.prototype.hasOwnProperty.call(values, field),
	);
	if (unknown.length > 0 || missing.length > 0 || actual.length !== expected.length) {
		throw new OperationalError(`Key JSON must contain exactly: ${expected.join(', ')}.`);
	}
	const parts = expected.map((field) => {
		const type = policy.keyFields.get(field);
		if (!type) throw new OperationalError(`Missing key type for ${field}.`);
		return `${field}=${formatODataLiteral(values[field], type, version)}`;
	});
	if (parts.length === 1) return parts[0].slice(parts[0].indexOf('=') + 1);
	return parts.join(',');
}

function filterExpression(
	filter: UiFilter,
	policy: EntityPolicy,
	version: ODataVersion,
): string {
	const type = policy.filterFields.get(filter.field);
	if (!type) {
		throw new OperationalError(`Filter field ${filter.field} is not allowed for ${policy.name}.`);
	}
	if (['contains', 'startsWith', 'endsWith'].includes(filter.operator) && type !== 'string') {
		throw new OperationalError(`Operator ${filter.operator} requires a string field.`);
	}
	const literal = formatODataLiteral(filter.value, type, version);
	if (filter.operator === 'contains') {
		return version === 'v2'
			? `substringof(${literal},${filter.field})`
			: `contains(${filter.field},${literal})`;
	}
	if (filter.operator === 'startsWith') return `startswith(${filter.field},${literal})`;
	if (filter.operator === 'endsWith') return `endswith(${filter.field},${literal})`;
	return `${filter.field} ${filter.operator} ${literal}`;
}

export function buildFilter(
	userFilters: UiFilter[],
	logic: FilterLogic,
	policy: EntityPolicy,
	version: ODataVersion,
): string | undefined {
	const user = userFilters.map((filter) => filterExpression(filter, policy, version));
	const required = policy.requiredFilters.map((filter) => filterExpression(filter, policy, version));
	const userGroup = user.length > 0 ? `(${user.join(` ${logic} `)})` : '';
	const requiredGroup = required.length > 0 ? `(${required.join(' and ')})` : '';
	return [requiredGroup, userGroup].filter(Boolean).join(' and ') || undefined;
}

export function buildOrderBy(orderBy: UiOrderBy[], policy: EntityPolicy): string | undefined {
	for (const sort of orderBy) {
		if (!policy.orderByFields.has(sort.field)) {
			throw new OperationalError(`Sort field ${sort.field} is not allowed for ${policy.name}.`);
		}
	}
	return orderBy.length > 0
		? orderBy.map((sort) => `${sort.field} ${sort.direction}`).join(',')
		: undefined;
}
