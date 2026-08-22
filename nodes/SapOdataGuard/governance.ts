import { OperationalError } from 'n8n-workflow';

import type {
	EntityPolicy,
	EntityOperation,
	EntityWriteOperation,
	FilterOperator,
	ODataGuardCredentials,
	ODataValueType,
	ODataVersion,
	ODataWriteValueType,
	RequiredFilterPolicy,
	ServicePolicies,
	ServicePolicy,
} from './types';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALUE_TYPES = new Set<ODataValueType>([
	'string',
	'number',
	'boolean',
	'date',
	'datetime',
	'guid',
]);
const WRITE_VALUE_TYPES = new Set<ODataWriteValueType>([
	...VALUE_TYPES,
	'object',
	'array',
]);
const FILTER_OPERATORS = new Set<FilterOperator>([
	'eq',
	'ne',
	'gt',
	'ge',
	'lt',
	'le',
	'contains',
	'startsWith',
	'endsWith',
]);
const ENTITY_OPERATIONS = new Set<EntityOperation>([
	'get',
	'getMany',
	'create',
	'update',
	'delete',
]);
const MAX_SERVICES = 50;
const MAX_ENTITIES_PER_SERVICE = 200;
const MAX_FIELDS_PER_POLICY = 500;
const MAX_WRITE_DEPTH = 12;
const MAX_WRITE_MEMBERS = 5000;

function containsControlCharacter(value: string): boolean {
	return [...value].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || code === 127;
	});
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new OperationalError(`${label} must be a JSON object.`);
	}
	return value as Record<string, unknown>;
}

function assertSafeObjectKey(key: string, label: string): void {
	if (['__proto__', 'prototype', 'constructor'].includes(key.toLowerCase())) {
		throw new OperationalError(`${label} contains a forbidden property name.`);
	}
}

export function assertIdentifier(value: unknown, label: string): string {
	const identifier = String(value ?? '').trim();
	if (!IDENTIFIER.test(identifier) || identifier === '_odata') {
		throw new OperationalError(
			`${label} must start with a letter or underscore and contain only letters, numbers, or underscores (maximum 128 characters).`,
		);
	}
	return identifier;
}

export function normalizeServicePath(value: unknown): string {
	const raw = String(value ?? '').trim();
	if (!raw.startsWith('/') || raw.startsWith('//')) {
		throw new OperationalError('Service paths must be relative absolute paths starting with one /.');
	}
	let parsed: URL;
	try {
		parsed = new URL(raw, 'https://odata-guard.invalid');
	} catch {
		// This is local policy validation, not an API failure.
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
		throw new OperationalError('Service policy contains an invalid service path.');
	}
	if (parsed.origin !== 'https://odata-guard.invalid' || parsed.search || parsed.hash) {
		throw new OperationalError('Service paths cannot contain a host, query string, or fragment.');
	}
	let decoded: string;
	try {
		decoded = decodeURIComponent(parsed.pathname);
	} catch {
		// This is local policy validation, not an API failure.
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
		throw new OperationalError('Service path contains invalid percent encoding.');
	}
	if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) {
		throw new OperationalError('Service paths cannot contain dot segments.');
	}
	const normalized = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
	if (!normalized || normalized === '/') {
		throw new OperationalError('Service path must identify one OData service.');
	}
	return normalized;
}

function parseValueType(value: unknown, label: string): ODataValueType {
	if (typeof value !== 'string' || !VALUE_TYPES.has(value as ODataValueType)) {
		throw new OperationalError(
			`${label} must be one of string, number, boolean, date, datetime, or guid.`,
		);
	}
	return value as ODataValueType;
}

function parseFieldTypeMap(value: unknown, label: string): Map<string, ODataValueType> {
	if (value === undefined) return new Map();
	const record = recordValue(value, label);
	if (Object.keys(record).length > MAX_FIELDS_PER_POLICY) {
		throw new OperationalError(`${label} exceeds ${MAX_FIELDS_PER_POLICY} entries.`);
	}
	const result = new Map<string, ODataValueType>();
	for (const [field, type] of Object.entries(record)) {
		assertSafeObjectKey(field, label);
		const normalizedField = assertIdentifier(field, `${label} field`);
		result.set(normalizedField, parseValueType(type, `${label}.${normalizedField}`));
	}
	return result;
}

function parseWriteValueType(value: unknown, label: string): ODataWriteValueType {
	if (typeof value !== 'string' || !WRITE_VALUE_TYPES.has(value as ODataWriteValueType)) {
		throw new OperationalError(
			`${label} must be one of string, number, boolean, date, datetime, guid, object, or array.`,
		);
	}
	return value as ODataWriteValueType;
}

function parseWriteFieldTypeMap(
	value: unknown,
	label: string,
): Map<string, ODataWriteValueType> {
	if (value === undefined) return new Map();
	const record = recordValue(value, label);
	if (Object.keys(record).length > MAX_FIELDS_PER_POLICY) {
		throw new OperationalError(`${label} exceeds ${MAX_FIELDS_PER_POLICY} entries.`);
	}
	const result = new Map<string, ODataWriteValueType>();
	for (const [field, type] of Object.entries(record)) {
		assertSafeObjectKey(field, label);
		const normalizedField = assertIdentifier(field, `${label} field`);
		result.set(normalizedField, parseWriteValueType(type, `${label}.${normalizedField}`));
	}
	return result;
}

function parseFieldList(value: unknown, label: string, required = false): string[] {
	if (value === undefined && !required) return [];
	if (!Array.isArray(value) || (required && value.length === 0)) {
		throw new OperationalError(`${label} must be ${required ? 'a non-empty' : 'an'} array.`);
	}
	if (value.length > MAX_FIELDS_PER_POLICY) {
		throw new OperationalError(`${label} exceeds ${MAX_FIELDS_PER_POLICY} fields.`);
	}
	const unique = new Set<string>();
	for (const field of value) unique.add(assertIdentifier(field, `${label} field`));
	return [...unique];
}

function parseOperations(value: unknown, label: string): Set<EntityOperation> {
	if (!Array.isArray(value) || value.length === 0) {
		throw new OperationalError(
			`${label} must contain one or more of get, getMany, create, update, or delete.`,
		);
	}
	const result = new Set<EntityOperation>();
	for (const operation of value) {
		if (typeof operation !== 'string' || !ENTITY_OPERATIONS.has(operation as EntityOperation)) {
			throw new OperationalError(`${label} contains an unsupported operation.`);
		}
		result.add(operation as EntityOperation);
	}
	return result;
}

export function validateTypedValue(value: unknown, type: ODataValueType, label: string): void {
	if (type === 'string') {
		if (typeof value !== 'string') throw new OperationalError(`${label} must be a string.`);
		return;
	}
	if (type === 'number') {
		const numeric = typeof value === 'number' ? value : Number(value);
		if (!Number.isFinite(numeric)) throw new OperationalError(`${label} must be a finite number.`);
		return;
	}
	if (type === 'boolean') {
		if (value !== true && value !== false && value !== 'true' && value !== 'false') {
			throw new OperationalError(`${label} must be true or false.`);
		}
		return;
	}
	if (type === 'guid') {
		if (typeof value !== 'string' || !GUID.test(value)) {
			throw new OperationalError(`${label} must be a canonical GUID.`);
		}
		return;
	}
	if (typeof value !== 'string') {
		throw new OperationalError(`${label} must be an ISO date string.`);
	}
	if (type === 'date') {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
			throw new OperationalError(`${label} must use YYYY-MM-DD.`);
		}
		return;
	}
	if (Number.isNaN(Date.parse(value))) {
		throw new OperationalError(`${label} must be a valid ISO datetime.`);
	}
}

function parseRequiredFilters(
	value: unknown,
	filterFields: Map<string, ODataValueType>,
	label: string,
): RequiredFilterPolicy[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new OperationalError(`${label} must be an array.`);
	if (value.length > 50) throw new OperationalError(`${label} cannot contain more than 50 filters.`);
	return value.map((entry, index) => {
		const record = recordValue(entry, `${label}[${index}]`);
		const field = assertIdentifier(record.field, `${label}[${index}].field`);
		const type = filterFields.get(field);
		if (!type) throw new OperationalError(`${label}[${index}] uses a field absent from filterFields.`);
		if (typeof record.operator !== 'string' || !FILTER_OPERATORS.has(record.operator as FilterOperator)) {
			throw new OperationalError(`${label}[${index}] contains an unsupported operator.`);
		}
		const operator = record.operator as FilterOperator;
		if (['contains', 'startsWith', 'endsWith'].includes(operator) && type !== 'string') {
			throw new OperationalError(`${label}[${index}] uses a text operator on a non-string field.`);
		}
		validateTypedValue(record.value, type, `${label}[${index}].value`);
		return { field, operator, value: record.value };
	});
}

function parseEntityPolicy(name: string, value: unknown, label: string): EntityPolicy {
	const entity = recordValue(value, label);
	const fields = parseFieldList(entity.fields, `${label}.fields`, true);
	const keyFields = parseFieldTypeMap(entity.keyFields, `${label}.keyFields`);
	const filterFields = parseFieldTypeMap(entity.filterFields, `${label}.filterFields`);
	const createFields = parseWriteFieldTypeMap(entity.createFields, `${label}.createFields`);
	const updateFields = parseWriteFieldTypeMap(entity.updateFields, `${label}.updateFields`);
	const operations = parseOperations(entity.operations, `${label}.operations`);
	const orderByFields = new Set(parseFieldList(entity.orderByFields, `${label}.orderByFields`));
	const requiredCreateFields = new Set(
		parseFieldList(entity.requiredCreateFields, `${label}.requiredCreateFields`),
	);
	const nullableCreateFields = new Set(
		parseFieldList(entity.nullableCreateFields, `${label}.nullableCreateFields`),
	);
	const nullableUpdateFields = new Set(
		parseFieldList(entity.nullableUpdateFields, `${label}.nullableUpdateFields`),
	);
	for (const field of orderByFields) {
		if (!fields.includes(field)) {
			throw new OperationalError(`${label}.orderByFields contains ${field}, which is not an output field.`);
		}
	}
	const requiredFilters = parseRequiredFilters(
		entity.requiredFilters,
		filterFields,
		`${label}.requiredFilters`,
	);
	if (['get', 'update', 'delete'].some((operation) => operations.has(operation as EntityOperation)) && keyFields.size === 0) {
		throw new OperationalError(
			`${label} must define keyFields before Get, Update, or Delete can be allowed.`,
		);
	}
	if (
		['get', 'update', 'delete'].some((operation) => operations.has(operation as EntityOperation)) &&
		requiredFilters.length > 0
	) {
		throw new OperationalError(
			`${label} cannot allow Get, Update, or Delete together with requiredFilters because a direct key URL cannot enforce row filters. Use Get Many with a key filter for scoped reads and a separate write policy.`,
		);
	}
	if (operations.has('create') && createFields.size === 0) {
		throw new OperationalError(`${label} must define createFields before Create can be allowed.`);
	}
	if (operations.has('update') && updateFields.size === 0) {
		throw new OperationalError(`${label} must define updateFields before Update can be allowed.`);
	}
	for (const field of requiredCreateFields) {
		if (!createFields.has(field)) {
			throw new OperationalError(
				`${label}.requiredCreateFields contains ${field}, which is absent from createFields.`,
			);
		}
	}
	for (const field of nullableCreateFields) {
		if (!createFields.has(field)) {
			throw new OperationalError(
				`${label}.nullableCreateFields contains ${field}, which is absent from createFields.`,
			);
		}
	}
	for (const field of nullableUpdateFields) {
		if (!updateFields.has(field)) {
			throw new OperationalError(
				`${label}.nullableUpdateFields contains ${field}, which is absent from updateFields.`,
			);
		}
	}
	return {
		name,
		operations,
		fields,
		keyFields,
		filterFields,
		orderByFields,
		requiredFilters,
		createFields,
		updateFields,
		requiredCreateFields,
		nullableCreateFields,
		nullableUpdateFields,
		allowWildcardIfMatch: entity.allowWildcardIfMatch === true,
	};
}

function parseServicePolicy(path: string, value: unknown): ServicePolicy {
	const service = recordValue(value, `Policy for ${path}`);
	if (service.version !== 'v2' && service.version !== 'v4') {
		throw new OperationalError(`Policy for ${path} must set version to v2 or v4.`);
	}
	const entityObject = recordValue(service.entities, `Policy for ${path}.entities`);
	if (Object.keys(entityObject).length === 0) {
		throw new OperationalError(`Policy for ${path} must define at least one entity.`);
	}
	if (Object.keys(entityObject).length > MAX_ENTITIES_PER_SERVICE) {
		throw new OperationalError(
			`Policy for ${path} exceeds ${MAX_ENTITIES_PER_SERVICE} entities.`,
		);
	}
	const entities = new Map<string, EntityPolicy>();
	for (const [entityName, entityValue] of Object.entries(entityObject)) {
		assertSafeObjectKey(entityName, `Policy for ${path}.entities`);
		const name = assertIdentifier(entityName, `Entity in policy for ${path}`);
		entities.set(name, parseEntityPolicy(name, entityValue, `Policy for ${path}.${name}`));
	}
	return {
		path,
		version: service.version,
		allowMetadata: service.allowMetadata === true,
		entities,
	};
}

export function parseServicePolicies(value: string): ServicePolicies {
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(value ?? '').trim());
	} catch {
		// This is local policy validation, not an API failure.
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
		throw new OperationalError('Service Policies JSON must be valid JSON.');
	}
	const services = recordValue(parsed, 'Service Policies JSON');
	const entries = Object.entries(services);
	if (entries.length === 0) {
		throw new OperationalError('Service Policies JSON must define at least one service.');
	}
	if (entries.length > MAX_SERVICES) {
		throw new OperationalError(`Service Policies JSON exceeds ${MAX_SERVICES} services.`);
	}
	const policies = new Map<string, ServicePolicy>();
	for (const [rawPath, policyValue] of entries) {
		assertSafeObjectKey(rawPath, 'Service Policies JSON');
		const path = normalizeServicePath(rawPath);
		if (policies.has(path)) throw new OperationalError(`Duplicate normalized service policy ${path}.`);
		policies.set(path, parseServicePolicy(path, policyValue));
	}
	return policies;
}

export function servicePolicyFor(path: string, policies: ServicePolicies): ServicePolicy {
	const normalized = normalizeServicePath(path);
	const policy = policies.get(normalized);
	if (!policy) throw new OperationalError(`Service ${normalized} is not allowed by these credentials.`);
	return policy;
}

export function entityPolicyFor(
	service: ServicePolicy,
	entityName: string,
	operation: EntityOperation,
): EntityPolicy {
	const normalized = assertIdentifier(entityName, 'Entity Set');
	const entity = service.entities.get(normalized);
	if (!entity) {
		throw new OperationalError(
			`Entity ${normalized} is not allowed for service ${service.path}.`,
		);
	}
	if (!entity.operations.has(operation)) {
		throw new OperationalError(
			`Operation ${operation} is not allowed for ${service.path}/${normalized}.`,
		);
	}
	return entity;
}

function safeNestedWriteValue(
	value: unknown,
	label: string,
	depth: number,
	memberCount: { value: number },
): void {
	if (depth > MAX_WRITE_DEPTH) {
		throw new OperationalError(`${label} exceeds the maximum nested write depth.`);
	}
	if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
	if (Array.isArray(value)) {
		memberCount.value += value.length;
		if (memberCount.value > MAX_WRITE_MEMBERS) {
			throw new OperationalError(`Write payload exceeds ${MAX_WRITE_MEMBERS} nested members.`);
		}
		value.forEach((entry, index) =>
			safeNestedWriteValue(entry, `${label}[${index}]`, depth + 1, memberCount),
		);
		return;
	}
	if (!value || typeof value !== 'object') {
		throw new OperationalError(`${label} contains a non-JSON value.`);
	}
	const entries = Object.entries(value as Record<string, unknown>);
	memberCount.value += entries.length;
	if (memberCount.value > MAX_WRITE_MEMBERS) {
		throw new OperationalError(`Write payload exceeds ${MAX_WRITE_MEMBERS} nested members.`);
	}
	for (const [key, nestedValue] of entries) {
		assertSafeObjectKey(key, label);
		if (
			key === '__metadata' ||
			key.length === 0 ||
			key.length > 128 ||
			containsControlCharacter(key)
		) {
			throw new OperationalError(`${label} contains an unsafe nested property name.`);
		}
		safeNestedWriteValue(nestedValue, `${label}.${key}`, depth + 1, memberCount);
	}
}

function normalizeWriteValue(
	value: unknown,
	type: ODataWriteValueType,
	version: ODataVersion,
): unknown {
	if (value === null) return null;
	if (type === 'datetime' && version === 'v2' && typeof value === 'string') {
		return `/Date(${Date.parse(value)})/`;
	}
	if (type === 'boolean' && typeof value === 'string') return value === 'true';
	return value;
}

export function validateWritePayload(
	value: unknown,
	entity: EntityPolicy,
	operation: Exclude<EntityWriteOperation, 'delete'>,
	version: ODataVersion,
	maxRequestBytes: number,
): Record<string, unknown> {
	let parsed = value;
	if (typeof value === 'string') {
		try {
			parsed = JSON.parse(value);
		} catch {
			// This is local input validation, not an API failure.
			// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
			throw new OperationalError('Data JSON must be valid JSON.');
		}
	}
	const body = recordValue(parsed, 'Data JSON');
	const entries = Object.entries(body);
	if (entries.length === 0) throw new OperationalError('Data JSON must contain at least one field.');
	const allowedFields = operation === 'create' ? entity.createFields : entity.updateFields;
	const nullableFields =
		operation === 'create' ? entity.nullableCreateFields : entity.nullableUpdateFields;
	if (operation === 'create') {
		for (const required of entity.requiredCreateFields) {
			if (!Object.prototype.hasOwnProperty.call(body, required)) {
				throw new OperationalError(`Create requires field ${required}.`);
			}
		}
	}
	const normalized: Record<string, unknown> = {};
	const memberCount = { value: entries.length };
	for (const [rawField, fieldValue] of entries) {
		assertSafeObjectKey(rawField, 'Data JSON');
		const field = assertIdentifier(rawField, 'Data JSON field');
		const type = allowedFields.get(field);
		if (!type) {
			throw new OperationalError(`Field ${field} is not allowed for ${operation} on ${entity.name}.`);
		}
		if (fieldValue === null) {
			if (!nullableFields.has(field)) {
				throw new OperationalError(`Field ${field} is not nullable for ${operation} on ${entity.name}.`);
			}
			normalized[field] = null;
			continue;
		}
		if (type === 'object') {
			if (!fieldValue || typeof fieldValue !== 'object' || Array.isArray(fieldValue)) {
				throw new OperationalError(`Data JSON.${field} must be an object.`);
			}
			safeNestedWriteValue(fieldValue, `Data JSON.${field}`, 1, memberCount);
		} else if (type === 'array') {
			if (!Array.isArray(fieldValue)) {
				throw new OperationalError(`Data JSON.${field} must be an array.`);
			}
			safeNestedWriteValue(fieldValue, `Data JSON.${field}`, 1, memberCount);
		} else {
			validateTypedValue(fieldValue, type, `Data JSON.${field}`);
		}
		normalized[field] = normalizeWriteValue(fieldValue, type, version);
	}
	let serialized: string;
	try {
		serialized = JSON.stringify(normalized);
	} catch {
		// This is local input validation, not an API failure.
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
		throw new OperationalError('Data JSON must be serializable JSON.');
	}
	const bytes = Buffer.byteLength(serialized, 'utf8');
	if (bytes > maxRequestBytes) {
		throw new OperationalError(
			`Write payload is ${bytes} bytes, above the credential limit of ${maxRequestBytes}.`,
		);
	}
	return normalized;
}

export function validateIfMatch(value: unknown, entity: EntityPolicy): string {
	const ifMatch = String(value ?? '').trim();
	if (!ifMatch) {
		throw new OperationalError(
			'Update and Delete require If-Match. Provide the current ETag, or explicitly allow * in the credential policy.',
		);
	}
	if (ifMatch.length > 1024 || containsControlCharacter(ifMatch)) {
		throw new OperationalError('If-Match contains an invalid or oversized header value.');
	}
	if (ifMatch === '*' && !entity.allowWildcardIfMatch) {
		throw new OperationalError(
			`Wildcard If-Match is not allowed for ${entity.name}; provide the exact current ETag.`,
		);
	}
	return ifMatch;
}

export function normalizeHost(
	value: string,
	allowInsecureHttp = false,
	allowPrivateNetwork = false,
): string {
	let url: URL;
	try {
		url = new URL(String(value ?? '').trim());
	} catch {
		// This is local policy validation, not an API failure.
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
		throw new OperationalError('Host must be a valid absolute URL.');
	}
	if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
		throw new OperationalError('Host cannot contain credentials, a path, query parameters, or a fragment.');
	}
	if (url.protocol !== 'https:' && !(allowInsecureHttp && url.protocol === 'http:')) {
		throw new OperationalError('Host must use HTTPS. Plain HTTP is only allowed for isolated tests.');
	}
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	const metadataHosts = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata.azure.com']);
	if (metadataHosts.has(hostname)) {
		throw new OperationalError('Cloud metadata endpoints are never allowed.');
	}
	const isPrivate =
		hostname === 'localhost' ||
		hostname === '::1' ||
		/^127\./.test(hostname) ||
		/^10\./.test(hostname) ||
		/^192\.168\./.test(hostname) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
		/^169\.254\./.test(hostname) ||
		/^(fc|fd|fe8)/i.test(hostname);
	if (isPrivate && !allowPrivateNetwork) {
		throw new OperationalError(
			'Private-network hosts require the explicit Allow Private Network Access credential switch.',
		);
	}
	url.pathname = '';
	return url.toString().replace(/\/$/, '');
}

function assertIntegerRange(value: unknown, label: string, minimum: number, maximum: number): void {
	const numeric = Number(value);
	if (!Number.isInteger(numeric) || numeric < minimum || numeric > maximum) {
		throw new OperationalError(`${label} must be an integer between ${minimum} and ${maximum}.`);
	}
}

export function validateGovernanceConfiguration(credentials: ODataGuardCredentials): ServicePolicies {
	credentials.maxRequestBytes ??= 1_048_576;
	credentials.maxWrites ??= 100;
	normalizeHost(
		credentials.host,
		credentials.allowInsecureHttp === true,
		credentials.allowPrivateNetwork === true,
	);
	if (credentials.authMode === 'basicAuth' && (!credentials.username || !credentials.password)) {
		throw new OperationalError('Basic Auth requires both username and password.');
	}
	if (credentials.sapClient && !/^\d{3}$/.test(credentials.sapClient)) {
		throw new OperationalError('SAP Client must contain exactly three digits.');
	}
	if (credentials.sapLanguage && !/^[A-Za-z]{2}$/.test(credentials.sapLanguage)) {
		throw new OperationalError('SAP Language must contain exactly two letters.');
	}
	const policies = parseServicePolicies(credentials.servicePoliciesJson);
	assertIntegerRange(credentials.maxRows, 'Maximum Rows', 1, 10_000);
	assertIntegerRange(credentials.maxPages, 'Maximum Pages', 1, 100);
	assertIntegerRange(credentials.maxUrlLength, 'Maximum URL Length', 512, 32_768);
	assertIntegerRange(credentials.maxResponseBytes, 'Maximum Response Size', 1024, 10_485_760);
	assertIntegerRange(credentials.maxRequestBytes, 'Maximum Write Request Size', 128, 10_485_760);
	assertIntegerRange(credentials.maxWrites, 'Maximum Writes', 1, 1000);
	assertIntegerRange(credentials.requestTimeout, 'Request Timeout', 1000, 300_000);
	if (credentials.allowAiMetadata === true && credentials.allowAiTool !== true) {
		throw new OperationalError('AI metadata discovery requires Allow AI Tool Use as well.');
	}
	if (credentials.allowAiTool === true) {
		assertIntegerRange(credentials.aiToolMaxRows, 'AI Tool Maximum Rows', 1, 1000);
		assertIntegerRange(credentials.aiToolMaxBytes, 'AI Tool Maximum Bytes', 1024, 5_242_880);
		if (credentials.allowAiWrites === true) {
			assertIntegerRange(credentials.aiToolMaxWrites, 'AI Tool Maximum Writes', 1, 100);
		}
	} else if (credentials.allowAiWrites === true) {
		throw new OperationalError('AI write operations require Allow AI Tool Use as well.');
	}
	return policies;
}
