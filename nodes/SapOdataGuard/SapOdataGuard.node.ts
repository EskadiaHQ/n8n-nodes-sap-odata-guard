import {
	NodeConnectionTypes,
	NodeOperationError,
	OperationalError,
	type ICredentialDataDecryptedObject,
	type ICredentialTestFunctions,
	type ICredentialsDecrypted,
	type IDataObject,
	type IExecuteFunctions,
	type ILoadOptionsFunctions,
	type INodeCredentialTestResult,
	type INodeExecutionData,
	type INodePropertyOptions,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

import {
	allowedEntitySetsFromMetadata,
	buildEntityUrl,
	buildMutationUrl,
	projectItem,
	requestCollection,
	requestMetadata,
	requestMutation,
	requestServiceCatalog,
	requestSingle,
} from './client';
import { readOnlyPolicyTemplateFromMetadata } from './catalog';
import {
	entityPolicyFor,
	servicePolicyFor,
	validateGovernanceConfiguration,
	validateIfMatch,
	validateWritePayload,
} from './governance';
import {
	buildFilter,
	buildKeyPredicate,
	buildOrderBy,
	normalizeKeyValues,
	normalizeUiFilters,
	normalizeUiOrderBy,
	selectedFieldsFromInput,
	writePayloadFromUi,
} from './query';
import { enforceAiToolByteLimit, resolveAiToolPolicy } from './toolPolicy';
import type {
	EntityPolicy,
	EntityOperation,
	EntityWriteOperation,
	FilterLogic,
	ODataGuardCredentials,
	ODataHttpRequest,
} from './types';

function isWriteOperation(operation: EntityOperation): operation is EntityWriteOperation {
	return operation === 'create' || operation === 'update' || operation === 'delete';
}

function credentialName(authentication: string): string {
	return authentication === 'oauth2' ? 'sapOdataGuardOAuth2Api' : 'sapOdataGuardApi';
}

function integerParameter(value: unknown, label: string, minimum: number, maximum: number): number {
	const number = Number(value);
	if (!Number.isInteger(number) || number < minimum || number > maximum) {
		throw new OperationalError(`${label} must be an integer between ${minimum} and ${maximum}.`);
	}
	return number;
}

function metadataObject(
	servicePath: string,
	operation: string,
	version: 'v2' | 'v4',
	startedAt: number,
	extra: IDataObject = {},
): IDataObject {
	return {
		servicePath,
		operation,
		version,
		durationMs: Date.now() - startedAt,
		policyApplied: true,
		...extra,
	};
}

async function loadCredentials(
	context: ILoadOptionsFunctions,
): Promise<ODataGuardCredentials> {
	const authentication = String(context.getCurrentNodeParameter('authentication') ?? 'basicOrNone');
	return (await context.getCredentials(
		credentialName(authentication),
	)) as unknown as ODataGuardCredentials;
}

async function currentEntityPolicy(
	context: ILoadOptionsFunctions,
): Promise<EntityPolicy | undefined> {
	const servicePath = String(context.getCurrentNodeParameter('servicePath') ?? '');
	const entitySet = String(context.getCurrentNodeParameter('entitySet') ?? '');
	const operation = String(context.getCurrentNodeParameter('operation') ?? '');
	if (!servicePath || !entitySet || !['get', 'getMany', 'create', 'update', 'delete'].includes(operation)) {
		return undefined;
	}
	const credentials = await loadCredentials(context);
	const policies = validateGovernanceConfiguration(credentials);
	const service = servicePolicyFor(servicePath, policies);
	return entityPolicyFor(service, entitySet, operation as EntityOperation);
}

export class SapOdataGuard implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Logali SAP OData Guard',
		name: 'sapOdataGuard',
		icon: {
			light: 'file:sapOdataGuard-v022.svg',
			dark: 'file:sapOdataGuard-v022.dark.svg',
		},
		group: ['input'],
		version: [1, 1.1, 1.2],
		subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
		description: 'Discover visible SAP services and read or write approved OData V2/V4 data with deny-by-default guardrails',
		usableAsTool: {
			replacements: {
				description:
					'Give an AI agent bounded access to explicitly approved SAP OData services, entities, operations, and fields',
			},
		},
		defaults: { name: 'Logali SAP OData Guard' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'sapOdataGuardApi',
				required: true,
				testedBy: 'sapOdataGuardConnectionTest',
				displayOptions: { show: { authentication: ['basicOrNone'] } },
			},
			{
				name: 'sapOdataGuardOAuth2Api',
				required: true,
				displayOptions: { show: { authentication: ['oauth2'] } },
			},
		],
		properties: [
			{
				displayName: 'Authentication',
				name: 'authentication',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Basic Auth / None', value: 'basicOrNone' },
					{ name: 'OAuth2 Client Credentials', value: 'oauth2' },
				],
				default: 'basicOrNone',
			},
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Service Catalog', value: 'catalog' },
					{ name: 'Connection', value: 'connection' },
					{ name: 'Metadata', value: 'metadata' },
					{ name: 'Entity', value: 'entity' },
				],
				default: 'connection',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['catalog'] } },
				options: [
					{
						name: 'List Visible Services',
						value: 'listServices',
						action: 'List visible services from SAP',
					},
					{
						name: 'Generate Read-Only Policy Template',
						value: 'getReadPolicyTemplate',
						action: 'Generate a read only policy template from metadata',
					},
				],
				default: 'listServices',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['connection'] } },
				options: [
					{
						name: 'Test Connection',
						value: 'testConnection',
						action: 'Test the governed SAP connection',
						description: 'Fetch metadata internally for one approved service',
					},
				],
				default: 'testConnection',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['metadata'] } },
				options: [
					{
						name: 'Get Metadata',
						value: 'getMetadata',
						action: 'Get approved service metadata',
					},
					{
						name: 'List Entity Sets',
						value: 'listEntitySets',
						action: 'List policy approved entity sets present in metadata',
					},
				],
				default: 'listEntitySets',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['entity'] } },
				options: [
					{ name: 'Create', value: 'create', action: 'Create an approved entity' },
					{ name: 'Delete', value: 'delete', action: 'Delete an approved entity' },
					{ name: 'Get', value: 'get', action: 'Get one approved entity by key' },
					{ name: 'Get Many', value: 'getMany', action: 'Get approved entities' },
					{ name: 'Update', value: 'update', action: 'Update an approved entity' },
				],
				default: 'getMany',
			},
			{
				displayName: 'Service Name or ID',
				name: 'servicePath',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getAllowedServices' },
				default: '',
				description: 'Only service paths present in the selected credential policy are listed. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: { show: { resource: ['connection', 'metadata', 'entity'] } },
				required: true,
			},
			{
				displayName: 'Catalog Service Name or ID',
				name: 'catalogServicePath',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getDiscoveredServices' },
				default: '',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				displayOptions: {
					show: { resource: ['catalog'], operation: ['getReadPolicyTemplate'] },
				},
				required: true,
			},
			{
				displayName: 'Entity Set Name or ID',
				name: 'entitySet',
				type: 'options',
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				typeOptions: { loadOptionsMethod: 'getAllowedEntities' },
				default: '',
				displayOptions: { show: { resource: ['entity'] } },
				required: true,
			},
			{
				displayName: 'Key JSON',
				name: 'keyJson',
				type: 'json',
				default: '{}',
				placeholder: '{"BusinessPartner":"1000000"}',
				description: 'Exact structured key defined by the selected entity policy',
				displayOptions: {
					show: { resource: ['entity'], operation: ['get', 'update', 'delete'] },
				},
				required: true,
			},
			{
				displayName: 'Fields',
				name: 'fields',
				type: 'string',
				default: '',
				placeholder: 'BusinessPartner,BusinessPartnerFullName',
				description:
					'Comma-separated projection. Empty means every policy-approved field, never every server field.',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { lte: 1 } }],
						resource: ['entity'],
						operation: ['get', 'getMany'],
					},
				},
			},
			{
				displayName: 'Field Names or IDs',
				name: 'fields',
				type: 'multiOptions',
				typeOptions: {
					loadOptionsMethod: 'getAllowedOutputFields',
					loadOptionsDependsOn: ['servicePath', 'entitySet', 'operation'],
				},
				default: [],
				description:
					'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.1 } }],
						resource: ['entity'],
						operation: ['get', 'getMany'],
					},
				},
			},
			{
				displayName: 'Payload Input',
				name: 'dataInputMode',
				type: 'options',
				options: [
					{ name: 'JSON Object', value: 'json' },
					{ name: 'Map Approved Fields', value: 'fields' },
				],
				default: 'json',
				description:
					'Choose a complete JSON object or build it from fields allowed by the selected credential policy',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.1 } }],
						resource: ['entity'],
						operation: ['create', 'update'],
					},
				},
			},
			{
				displayName: 'Data JSON',
				name: 'dataJson',
				type: 'json',
				default: '{}',
				description:
					'Entity payload. Every top-level field and value type must be explicitly allowed by the credential policy.',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { lte: 1 } }],
						resource: ['entity'],
						operation: ['create', 'update'],
					},
				},
				required: true,
			},
			{
				displayName: 'Data JSON',
				name: 'dataJson',
				type: 'json',
				default: '{}',
				placeholder: '{"BusinessPartnerCategory":"2","FirstName":"Ada"}',
				description:
					'Entity payload. Every top-level field and value type must be explicitly allowed by the credential policy.',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.1 } }],
						resource: ['entity'],
						operation: ['create', 'update'],
						dataInputMode: ['json'],
					},
				},
				required: true,
			},
			{
				displayName: 'Data Fields',
				name: 'dataFields',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add Approved Field',
				description:
					'Each value is a JSON value: use quotes for text, for example "Ada"; numbers, booleans, null, objects, and arrays use normal JSON syntax',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.1 } }],
						resource: ['entity'],
						operation: ['create', 'update'],
						dataInputMode: ['fields'],
					},
				},
				options: [
					{
						displayName: 'Values',
						name: 'values',
						values: [
							{
								displayName: 'Field Name or ID',
								name: 'field',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getAllowedWriteFields',
									loadOptionsDependsOn: ['servicePath', 'entitySet', 'operation'],
								},
								description:
									'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
								default: '',
								required: true,
							},
							{
								displayName: 'JSON Value',
								name: 'valueJson',
								type: 'string',
								default: '',
								placeholder: '"Ada"',
								required: true,
							},
						],
					},
				],
			},
			{
				displayName: 'If-Match',
				name: 'ifMatch',
				type: 'string',
				default: '',
				placeholder: 'W/"..."',
				description:
					'Current entity ETag. The wildcard * works only when the credential policy explicitly allows it.',
				displayOptions: {
					show: { resource: ['entity'], operation: ['update', 'delete'] },
				},
				required: true,
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				displayOptions: { show: { resource: ['entity'], operation: ['getMany'] } },
				options: [
					{
						name: 'values',
						displayName: 'Filter',
						values: [
							{
								displayName: 'Field Name or ID',
								name: 'field',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getAllowedFilterFields',
									loadOptionsDependsOn: ['servicePath', 'entitySet', 'operation'],
								},
								description:
									'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
								default: '',
								required: true,
							},
							{
								displayName: 'Operator',
								name: 'operator',
								type: 'options',
								options: [
									{ name: 'Contains', value: 'contains' },
									{ name: 'Ends With', value: 'endsWith' },
									{ name: 'Equals', value: 'eq' },
									{ name: 'Greater Than', value: 'gt' },
									{ name: 'Greater Than or Equal', value: 'ge' },
									{ name: 'Less Than', value: 'lt' },
									{ name: 'Less Than or Equal', value: 'le' },
									{ name: 'Not Equals', value: 'ne' },
									{ name: 'Starts With', value: 'startsWith' },
								],
								default: 'eq',
							},
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
			},
			{
				displayName: 'Filter Logic',
				name: 'filterLogic',
				type: 'options',
				options: [
					{ name: 'AND', value: 'and' },
					{ name: 'OR', value: 'or' },
				],
				default: 'and',
				displayOptions: { show: { resource: ['entity'], operation: ['getMany'] } },
			},
			{
				displayName: 'Order By',
				name: 'orderBy',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				displayOptions: { show: { resource: ['entity'], operation: ['getMany'] } },
				options: [
					{
						name: 'values',
						displayName: 'Sort',
						values: [
							{
								displayName: 'Field Name or ID',
								name: 'field',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getAllowedOrderByFields',
									loadOptionsDependsOn: ['servicePath', 'entitySet', 'operation'],
								},
								description:
									'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
								default: '',
								required: true,
							},
							{
								displayName: 'Direction',
								name: 'direction',
								type: 'options',
								options: [
									{ name: 'Ascending', value: 'asc' },
									{ name: 'Descending', value: 'desc' },
								],
								default: 'asc',
							},
						],
					},
				],
			},
			{
				displayName: 'Return All Within Credential Limit',
				name: 'returnAll',
				type: 'boolean',
				description: 'Whether to return all results or only up to a given limit',
				default: false,
				displayOptions: { show: { resource: ['entity'], operation: ['getMany'] } },
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				description: 'Max number of results to return',
				typeOptions: { minValue: 1, maxValue: 10000 },
				default: 50,
				displayOptions: {
					show: { resource: ['entity'], operation: ['getMany'], returnAll: [false] },
				},
			},
			{
				displayName: 'Page Size',
				name: 'pageSize',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 1000 },
				default: 100,
				description: 'Requested $top per page; the SAP service may enforce a smaller page',
				displayOptions: { show: { resource: ['entity'], operation: ['getMany'] } },
			},
			{
				displayName: 'Include Governance Metadata',
				name: 'includeMetadata',
				type: 'boolean',
				default: true,
				displayOptions: { show: { resource: ['entity'] } },
			},
		],
	};

	methods = {
		loadOptions: {
			async getAllowedServices(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const credentials = await loadCredentials(this);
				return [...validateGovernanceConfiguration(credentials).values()].map((service) => ({
					name: `${service.path} (${service.version.toUpperCase()})`,
					value: service.path,
				}));
			},
			async getDiscoveredServices(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const authentication = String(
					this.getCurrentNodeParameter('authentication') ?? 'basicOrNone',
				);
				const credentials = await loadCredentials(this);
				validateGovernanceConfiguration(credentials);
				const httpRequest: ODataHttpRequest =
					authentication === 'oauth2'
						? async (options) =>
								await this.helpers.httpRequestWithAuthentication.call(
									this,
									'sapOdataGuardOAuth2Api',
									options,
								)
						: async (options) => await this.helpers.httpRequest(options);
				const result = await requestServiceCatalog(httpRequest, credentials);
				const policies = validateGovernanceConfiguration(credentials);
				return result.services.map((service) => ({
					name: `${policies.has(service.servicePath) ? '✓ Allowed' : 'Discovered'} · ${service.title} (${service.technicalName})`,
					value: service.servicePath,
					description: service.description ?? service.servicePath,
				}));
			},
			async getAllowedEntities(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const credentials = await loadCredentials(this);
				const policies = validateGovernanceConfiguration(credentials);
				const path = String(this.getCurrentNodeParameter('servicePath') ?? '');
				if (!path) return [];
				return [...servicePolicyFor(path, policies).entities.values()].map((entity) => ({
					name: entity.name,
					value: entity.name,
					description: `Allowed operations: ${[...entity.operations].join(', ')}`,
				}));
			},
			async getAllowedOutputFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const entity = await currentEntityPolicy(this);
				if (!entity) return [];
				return entity.fields.map((field) => ({ name: field, value: field }));
			},
			async getAllowedFilterFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const entity = await currentEntityPolicy(this);
				if (!entity) return [];
				return [...entity.filterFields].map(([field, type]) => ({
					name: field,
					value: field,
					description: `Policy type: ${type}`,
				}));
			},
			async getAllowedOrderByFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const entity = await currentEntityPolicy(this);
				if (!entity) return [];
				return [...entity.orderByFields].map((field) => ({ name: field, value: field }));
			},
			async getAllowedWriteFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const entity = await currentEntityPolicy(this);
				if (!entity) return [];
				const operation = String(this.getCurrentNodeParameter('operation') ?? '');
				const fields = operation === 'create' ? entity.createFields : entity.updateFields;
				return [...fields].map(([field, type]) => ({
					name: field,
					value: field,
					description: `Policy type: ${type}${entity.requiredCreateFields.has(field) && operation === 'create' ? ' · required' : ''}`,
				}));
			},
		},
		credentialTest: {
			async sapOdataGuardConnectionTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted<ICredentialDataDecryptedObject>,
			): Promise<INodeCredentialTestResult> {
				try {
					const credentials = credential.data as unknown as ODataGuardCredentials;
					const policies = validateGovernanceConfiguration(credentials);
					const service = policies.values().next().value;
					if (!service) throw new OperationalError('No allowed service is configured.');
					const request: ODataHttpRequest = async (options) =>
						// ICredentialTestFunctions exposes the legacy request adapter in this SDK.
						// eslint-disable-next-line @n8n/community-nodes/no-deprecated-workflow-functions
						await this.helpers.request({
							method: options.method,
							uri: options.url,
							headers: options.headers,
							auth: options.auth,
							json: options.json,
							timeout: options.timeout,
							rejectUnauthorized: !options.skipSslCertificateValidation,
						});
					await requestMetadata(request, credentials, service.path);
					return { status: 'OK', message: `Connection successful for ${service.path}` };
				} catch (error) {
					return {
						status: 'Error',
						message: error instanceof Error ? error.message : String(error),
					};
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const inputItems = this.getInputData();
		const outputItems: INodeExecutionData[] = [];
		let writeCount = 0;
		for (let itemIndex = 0; itemIndex < inputItems.length; itemIndex += 1) {
			try {
				const authentication = this.getNodeParameter(
					'authentication',
					itemIndex,
					'basicOrNone',
				) as string;
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const credentials = (await this.getCredentials(
					credentialName(authentication),
					itemIndex,
				)) as unknown as ODataGuardCredentials;
				const policies = validateGovernanceConfiguration(credentials);
				const aiPolicy = resolveAiToolPolicy(
					this.getNode().type,
					resource,
					operation,
					credentials,
				);
				const startedAt = Date.now();
				const httpRequest: ODataHttpRequest =
					authentication === 'oauth2'
						? async (options) =>
								await this.helpers.httpRequestWithAuthentication.call(
									this,
									'sapOdataGuardOAuth2Api',
									options,
								)
						: async (options) => await this.helpers.httpRequest(options);

				if (resource === 'catalog') {
					const catalog = await requestServiceCatalog(httpRequest, credentials);
					if (operation === 'listServices') {
						for (const discovered of catalog.services) {
							const allowedPolicy = policies.get(discovered.servicePath);
							const json: IDataObject = {
								...discovered,
								allowedByCredential: allowedPolicy !== undefined,
								allowedEntityCount: allowedPolicy?.entities.size ?? 0,
								_odata: {
									operation,
									version: 'v2',
									catalogDiscovery: true,
									policyApplied: false,
									durationMs: Date.now() - startedAt,
									responseBytes: catalog.serializedBytes,
								},
							};
							outputItems.push({ json, pairedItem: { item: itemIndex } });
						}
						continue;
					}
					if (operation !== 'getReadPolicyTemplate') {
						throw new OperationalError(`Unsupported catalog operation ${operation}.`);
					}
					const selectedPath = this.getNodeParameter(
						'catalogServicePath',
						itemIndex,
					) as string;
					const discovered = catalog.services.find(
						(candidate) => candidate.servicePath === selectedPath,
					);
					if (!discovered) {
						throw new OperationalError(
							'Selected service is not present in the current SAP service catalog response.',
						);
					}
					const metadata = await requestMetadata(
						httpRequest,
						credentials,
						discovered.servicePath,
					);
					const template = readOnlyPolicyTemplateFromMetadata(
						discovered.servicePath,
						discovered.protocolVersion,
						metadata.xml,
					);
					outputItems.push({
						json: {
							...discovered,
							alreadyAllowed: policies.has(discovered.servicePath),
							entityCount: template.entityCount,
							fieldCount: template.fieldCount,
							policyTemplate: template.policy,
							policyJson: JSON.stringify(template.policy, null, 2),
							_odata: {
								operation,
								version: discovered.protocolVersion,
								catalogDiscovery: true,
								policyApplied: false,
								durationMs: Date.now() - startedAt,
								metadataBytes: metadata.serializedBytes,
							},
						},
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				const servicePath = this.getNodeParameter('servicePath', itemIndex) as string;
				const service = servicePolicyFor(servicePath, policies);

				if (resource === 'connection') {
					const result = await requestMetadata(httpRequest, credentials, service.path);
					const json: IDataObject = {
						connected: true,
						metadataBytes: result.serializedBytes,
						_odata: metadataObject(service.path, operation, service.version, startedAt),
					};
					enforceAiToolByteLimit(json, aiPolicy.maxBytes);
					outputItems.push({ json, pairedItem: { item: itemIndex } });
					continue;
				}

				if (resource === 'metadata') {
					if (!service.allowMetadata) {
						throw new OperationalError(
							`Metadata output is disabled by the policy for ${service.path}.`,
						);
					}
					const result = await requestMetadata(httpRequest, credentials, service.path);
					const json: IDataObject =
						operation === 'getMetadata'
							? {
									metadataXml: result.xml,
									_odata: metadataObject(
										service.path,
										operation,
										service.version,
										startedAt,
										{ metadataBytes: result.serializedBytes },
									),
								}
							: {
									entitySets: allowedEntitySetsFromMetadata(result.xml, service.entities),
									_odata: metadataObject(service.path, operation, service.version, startedAt),
								};
					enforceAiToolByteLimit(json, aiPolicy.maxBytes);
					outputItems.push({ json, pairedItem: { item: itemIndex } });
					continue;
				}

				const entitySet = this.getNodeParameter('entitySet', itemIndex) as string;
				if (!['get', 'getMany', 'create', 'update', 'delete'].includes(operation)) {
					throw new OperationalError(`Unsupported entity operation ${operation}.`);
				}
				const entityOperation = operation as EntityOperation;
				const entity = entityPolicyFor(service, entitySet, entityOperation);
				const includeMetadata = this.getNodeParameter(
					'includeMetadata',
					itemIndex,
					true,
				) as boolean;

				if (isWriteOperation(entityOperation)) {
					writeCount += 1;
					const writeLimit = Math.min(
						credentials.maxWrites,
						aiPolicy.maxWrites ?? credentials.maxWrites,
					);
					if (writeCount > writeLimit) {
						throw new OperationalError(
							`Write count exceeds the credential limit of ${writeLimit} per execution.`,
						);
					}
					const keyParameter =
						entityOperation === 'create'
							? undefined
							: this.getNodeParameter('keyJson', itemIndex);
					const keyValues =
						keyParameter === undefined ? undefined : normalizeKeyValues(keyParameter, entity);
					const key =
						keyValues === undefined
							? undefined
							: buildKeyPredicate(keyValues, entity, service.version);
					const bodyInput =
						entityOperation === 'delete'
							? undefined
							: this.getNodeParameter('dataInputMode', itemIndex, 'json') === 'fields'
								? writePayloadFromUi(this.getNodeParameter('dataFields', itemIndex, {}))
								: this.getNodeParameter('dataJson', itemIndex);
					const body =
						entityOperation === 'delete'
							? undefined
							: validateWritePayload(
									bodyInput,
									entity,
									entityOperation,
									service.version,
									credentials.maxRequestBytes,
								);
					const ifMatch =
						entityOperation === 'create'
							? undefined
							: validateIfMatch(this.getNodeParameter('ifMatch', itemIndex), entity);
					const method =
						entityOperation === 'create'
							? 'POST'
							: entityOperation === 'update'
								? 'PATCH'
								: 'DELETE';
					const url = buildMutationUrl(
						credentials,
						service.path,
						entity.name,
						key,
					);
					const result = await requestMutation(
						httpRequest,
						credentials,
						service.path,
						method,
						url,
						body,
						ifMatch,
					);
					const json: IDataObject = result.item
						? projectItem(result.item, entity.fields)
						: { ...(keyValues ?? {}), success: true };
					if (includeMetadata) {
						const extra: IDataObject = {
							entitySet: entity.name,
							writeApplied: true,
							csrfApplied: true,
							statusCode: result.statusCode,
							responseBytes: result.serializedBytes,
						};
						if (result.etag) extra.etag = result.etag;
						json._odata = metadataObject(
							service.path,
							operation,
							service.version,
							startedAt,
							extra,
						);
					}
					enforceAiToolByteLimit(json, aiPolicy.maxBytes);
					outputItems.push({ json, pairedItem: { item: itemIndex } });
					continue;
				}

				const fields = selectedFieldsFromInput(
					this.getNodeParameter('fields', itemIndex, ''),
					entity,
				);
				if (entityOperation === 'get') {
					const key = buildKeyPredicate(
						this.getNodeParameter('keyJson', itemIndex),
						entity,
						service.version,
					);
					const url = buildEntityUrl(credentials, service.path, entity.name, {
						keyPredicate: key,
						select: fields,
					});
					const result = await requestSingle(httpRequest, credentials, url);
					const json = projectItem(result.item, fields);
					if (includeMetadata) {
						const extra: IDataObject = {
							entitySet: entity.name,
							rowCount: 1,
							responseBytes: result.serializedBytes,
						};
						if (result.etag) extra.etag = result.etag;
						json._odata = metadataObject(
							service.path,
							operation,
							service.version,
							startedAt,
							extra,
						);
					}
					enforceAiToolByteLimit(json, aiPolicy.maxBytes);
					outputItems.push({ json, pairedItem: { item: itemIndex } });
					continue;
				}

				const filters = normalizeUiFilters(this.getNodeParameter('filters', itemIndex, {}));
				const filterLogic = this.getNodeParameter(
					'filterLogic',
					itemIndex,
					'and',
				) as FilterLogic;
				const orderByInput = normalizeUiOrderBy(
					this.getNodeParameter('orderBy', itemIndex, {}),
				);
				const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
				const requestedLimit = returnAll
					? credentials.maxRows
					: integerParameter(
							this.getNodeParameter('limit', itemIndex, 100),
							'Limit',
							1,
							10000,
						);
				const rowLimit = Math.min(
					requestedLimit,
					credentials.maxRows,
					aiPolicy.maxRows ?? credentials.maxRows,
				);
				const pageSize = Math.min(
					integerParameter(
						this.getNodeParameter('pageSize', itemIndex, 100),
						'Page Size',
						1,
						1000,
					),
					rowLimit,
				);
				const filter = buildFilter(filters, filterLogic, entity, service.version);
				const orderBy = buildOrderBy(orderByInput, entity);
				const initialUrl = buildEntityUrl(credentials, service.path, entity.name, {
					select: fields,
					filter,
					orderBy,
					top: pageSize,
				});
				const result = await requestCollection(
					httpRequest,
					credentials,
					initialUrl,
					initialUrl,
					rowLimit,
				);
				const rows = result.items.map((item) => projectItem(item, fields));
				const executionMetadata = metadataObject(
					service.path,
					operation,
					service.version,
					startedAt,
					{
						entitySet: entity.name,
						rowCount: rows.length,
						rowLimit,
						pageCount: result.pageCount,
						responseBytes: result.serializedBytes,
						truncated: result.truncated,
						requiredFilterCount: entity.requiredFilters.length,
					},
				);
				if (includeMetadata) {
					if (rows.length === 0) rows.push({ _odata: executionMetadata });
					else rows[0]._odata = executionMetadata;
				}
				enforceAiToolByteLimit(rows, aiPolicy.maxBytes);
				outputItems.push(
					...rows.map((json) => ({ json, pairedItem: { item: itemIndex } })),
				);
			} catch (error) {
				if (this.continueOnFail()) {
					outputItems.push({
						json: { error: error instanceof Error ? error.message : String(error) },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw new NodeOperationError(
					this.getNode(),
					error instanceof Error ? error : new Error(String(error)),
					{ itemIndex },
				);
			}
		}
		return [outputItems];
	}
}
