import { OperationalError, type IDataObject } from 'n8n-workflow';

import { assertIdentifier, normalizeServicePath, parseServicePolicies } from './governance';
import type { ODataValueType, ODataVersion, ServicePolicy } from './types';

interface MetadataProperty {
	name: string;
	type: ODataValueType;
	nullable: boolean;
	creatable: boolean;
	updatable: boolean;
}

interface MetadataEntityType {
	name: string;
	properties: MetadataProperty[];
	keys: string[];
}

function attribute(source: string, name: string): string | undefined {
	const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(source);
	return match?.[1];
}

function valueType(edmType: string): ODataValueType | undefined {
	const type = edmType; // Collections require a separate policy; never treat them as scalars.
	if (type === 'Edm.String') return 'string';
	if (type === 'Edm.Boolean') return 'boolean';
	if (type === 'Edm.Guid') return 'guid';
	if (type === 'Edm.Date') return 'date';
	if (type === 'Edm.DateTime') return 'datetime-local';
	if (type === 'Edm.DateTimeOffset') return 'datetimeoffset';
	if (type === 'Edm.Int64') return 'int64';
	if (type === 'Edm.Time') return 'time';
	if (type === 'Edm.TimeOfDay') return 'timeofday';
	if (type === 'Edm.Decimal') return 'decimal';
	if (
		['Edm.Byte', 'Edm.SByte', 'Edm.Int16', 'Edm.Int32', 'Edm.Single', 'Edm.Double'].includes(type)
	) {
		return 'number';
	}
	return undefined;
}

function parseEntityTypes(xml: string): Map<string, MetadataEntityType> {
	const result = new Map<string, MetadataEntityType>();
	const pattern = /<(?:\w+:)?EntityType\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?EntityType>/gi;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(xml)) !== null) {
		// Inherited properties and keys need a dedicated metadata resolver.
		if (attribute(match[1], 'BaseType')) continue;
		const rawName = attribute(match[1], 'Name');
		if (!rawName) continue;
		let name: string;
		try {
			name = assertIdentifier(rawName, 'Metadata EntityType');
		} catch {
			continue;
		}
		const properties: MetadataProperty[] = [];
		const propertyPattern = /<(?:\w+:)?Property\b([^>]*)\/?\s*>/gi;
		let propertyMatch: RegExpExecArray | null;
		while ((propertyMatch = propertyPattern.exec(match[2])) !== null) {
			const rawPropertyName = attribute(propertyMatch[1], 'Name');
			const rawType = attribute(propertyMatch[1], 'Type');
			if (!rawPropertyName || !rawType) continue;
			const type = valueType(rawType);
			if (!type) continue;
			try {
				properties.push({
					name: assertIdentifier(rawPropertyName, 'Metadata Property'),
					type,
					nullable: attribute(propertyMatch[1], 'Nullable') !== 'false',
					creatable: attribute(propertyMatch[1], 'sap:creatable') !== 'false',
					updatable: attribute(propertyMatch[1], 'sap:updatable') !== 'false',
				});
			} catch {
				// Ignore metadata members that cannot be represented safely by the node policy.
			}
		}
		const keyBlock = /<(?:\w+:)?Key\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Key>/i.exec(match[2])?.[1] ?? '';
		const keys: string[] = [];
		const keyPattern = /<(?:\w+:)?PropertyRef\b([^>]*)\/?\s*>/gi;
		let keyMatch: RegExpExecArray | null;
		while ((keyMatch = keyPattern.exec(keyBlock)) !== null) {
			const rawKey = attribute(keyMatch[1], 'Name');
			if (!rawKey) continue;
			try {
				keys.push(assertIdentifier(rawKey, 'Metadata Key'));
			} catch {
				keys.push(''); // A partial composite key must never enable Get.
			}
		}
		if (properties.length > 0) {
			const schemaPrefix = xml.slice(0, match.index);
			const schemas = [...schemaPrefix.matchAll(/<(?:\w+:)?Schema\b([^>]*)>/gi)];
			const schema = schemas[schemas.length - 1]?.[1] ?? '';
			const namespace = attribute(schema, 'Namespace');
			const alias = attribute(schema, 'Alias');
			const entity = { name, properties, keys };
			const qualified = namespace ? `${namespace}.${name}` : name;
			result.set(qualified, entity);
			if (alias) result.set(`${alias}.${name}`, entity);
		}
	}
	return result;
}

/** Build the schema for a credential with no user-supplied restrictions. SAP still authorizes requests. */
export function automaticServicePolicyFromMetadata(
	servicePath: string,
	xml: string,
): ServicePolicy {
	const edmx = /<(?:\w+:)?Edmx\b([^>]*)>/i.exec(xml);
	const dataServices = /<(?:\w+:)?DataServices\b([^>]*)>/i.exec(xml);
	const version: ODataVersion | undefined =
		attribute(edmx?.[1] ?? '', 'Version') === '4.0'
			? 'v4'
			: /^2(?:\.0)?$/.test(attribute(dataServices?.[1] ?? '', 'DataServiceVersion') ?? '')
				? 'v2'
				: undefined;
	if (!version) {
		throw new OperationalError(
			'Cannot detect OData V2/V4 from service metadata. Configure an explicit service policy.',
		);
	}
	const path = normalizeServicePath(servicePath);
	const template = readOnlyPolicyTemplateFromMetadata(path, version, xml);
	const service = parseServicePolicies(JSON.stringify(template.policy)).get(path)!;
	const types = parseEntityTypes(xml);
	for (const set of parseEntitySets(xml)) {
		const entity = service.entities.get(set.name);
		const type = types.get(set.typeName);
		if (!entity || !type) continue;
		entity.createFields = new Map(
			type.properties
				.filter((property) => property.creatable)
				.map((property) => [property.name, property.type]),
		);
		entity.updateFields = new Map(
			type.properties
				.filter((property) => property.updatable && !entity.keyFields.has(property.name))
				.map((property) => [property.name, property.type]),
		);
		entity.nullableCreateFields = new Set(
			type.properties.filter((property) => property.nullable).map((property) => property.name),
		);
		entity.nullableUpdateFields = new Set(
			[...entity.nullableCreateFields].filter((field) => entity.updateFields.has(field)),
		);
		if (set.creatable && entity.createFields.size > 0) entity.operations.add('create');
		if (entity.keyFields.size > 0) {
			if (set.updatable && entity.updateFields.size > 0) entity.operations.add('update');
			if (set.deletable) entity.operations.add('delete');
		}
	}
	return service;
}

function parseEntitySets(xml: string): Array<{
	name: string;
	typeName: string;
	creatable: boolean;
	updatable: boolean;
	deletable: boolean;
}> {
	const result: ReturnType<typeof parseEntitySets> = [];
	const pattern = /<(?:\w+:)?EntitySet\b([^>]*)\/?\s*>/gi;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(xml)) !== null) {
		const rawName = attribute(match[1], 'Name');
		const rawType = attribute(match[1], 'EntityType');
		if (!rawName || !rawType) continue;
		try {
			result.push({
				name: assertIdentifier(rawName, 'Metadata EntitySet'),
				creatable: attribute(match[1], 'sap:creatable') !== 'false',
				updatable: attribute(match[1], 'sap:updatable') !== 'false',
				deletable: attribute(match[1], 'sap:deletable') !== 'false',
				typeName: rawType
					.split('.')
					.map((part) => assertIdentifier(part, 'Metadata EntityType reference'))
					.join('.'),
			});
		} catch {
			// Ignore entity sets that cannot be represented by the policy grammar.
		}
	}
	return result;
}

export interface ReadPolicyTemplateResult {
	policy: IDataObject;
	entityCount: number;
	fieldCount: number;
}

export function readOnlyPolicyTemplateFromMetadata(
	servicePath: string,
	version: ODataVersion,
	xml: string,
): ReadPolicyTemplateResult {
	const normalizedPath = normalizeServicePath(servicePath);
	const entityTypes = parseEntityTypes(xml);
	const entities: Record<string, IDataObject> = {};
	let fieldCount = 0;
	for (const entitySet of parseEntitySets(xml)) {
		const entityType = entityTypes.get(entitySet.typeName);
		if (!entityType) continue;
		const fields = entityType.properties.map((property) => property.name);
		const typeByField = new Map(
			entityType.properties.map((property) => [property.name, property.type] as const),
		);
		const completeKeys =
			entityType.keys.length > 0 && entityType.keys.every((key) => typeByField.has(key));
		const keyFields = Object.fromEntries(
			(completeKeys ? entityType.keys : []).map((key) => [key, typeByField.get(key)]),
		);
		const filterFields = Object.fromEntries(
			entityType.properties.map((property) => [property.name, property.type]),
		);
		entities[entitySet.name] = {
			operations: Object.keys(keyFields).length > 0 ? ['get', 'getMany'] : ['getMany'],
			fields,
			outputTypes: Object.fromEntries(typeByField),
			keyFields,
			filterFields,
			orderByFields: fields,
			requiredFilters: [],
		};
		fieldCount += fields.length;
	}
	if (Object.keys(entities).length === 0) {
		throw new OperationalError(
			'No supported entity sets and primitive fields were found in the service metadata.',
		);
	}
	return {
		policy: {
			[normalizedPath]: {
				version,
				allowMetadata: true,
				entities,
			},
		},
		entityCount: Object.keys(entities).length,
		fieldCount,
	};
}
