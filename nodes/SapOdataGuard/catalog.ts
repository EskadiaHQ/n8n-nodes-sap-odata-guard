import { OperationalError, type IDataObject } from 'n8n-workflow';

import { assertIdentifier, normalizeServicePath } from './governance';
import type { ODataValueType, ODataVersion } from './types';

interface MetadataProperty {
	name: string;
	type: ODataValueType;
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
	const type = edmType.replace(/^Collection\((.*)\)$/, '$1');
	if (type === 'Edm.String') return 'string';
	if (type === 'Edm.Boolean') return 'boolean';
	if (type === 'Edm.Guid') return 'guid';
	if (type === 'Edm.Date') return 'date';
	if (['Edm.DateTime', 'Edm.DateTimeOffset'].includes(type)) return 'datetime';
	if (type === 'Edm.Decimal') return 'decimal';
	if (
		[
			'Edm.Byte',
			'Edm.SByte',
			'Edm.Int16',
			'Edm.Int32',
			'Edm.Int64',
			'Edm.Single',
			'Edm.Double',
		].includes(type)
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
				// Ignore keys that cannot be represented by the policy grammar.
			}
		}
		if (properties.length > 0) result.set(name, { name, properties, keys });
	}
	return result;
}

function parseEntitySets(xml: string): Array<{ name: string; typeName: string }> {
	const result: Array<{ name: string; typeName: string }> = [];
	const pattern = /<(?:\w+:)?EntitySet\b([^>]*)\/?\s*>/gi;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(xml)) !== null) {
		const rawName = attribute(match[1], 'Name');
		const rawType = attribute(match[1], 'EntityType');
		if (!rawName || !rawType) continue;
		try {
			result.push({
				name: assertIdentifier(rawName, 'Metadata EntitySet'),
				typeName: assertIdentifier(rawType.split('.').pop(), 'Metadata EntityType reference'),
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
		const keyFields = Object.fromEntries(
			entityType.keys
				.filter((key) => typeByField.has(key))
				.map((key) => [key, typeByField.get(key)]),
		);
		const filterFields = Object.fromEntries(
			entityType.properties.map((property) => [property.name, property.type]),
		);
		entities[entitySet.name] = {
			operations: Object.keys(keyFields).length > 0 ? ['get', 'getMany'] : ['getMany'],
			fields,
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
