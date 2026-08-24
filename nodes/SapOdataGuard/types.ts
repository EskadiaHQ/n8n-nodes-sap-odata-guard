import type { IDataObject, IHttpRequestOptions } from 'n8n-workflow';

export type ODataVersion = 'v2' | 'v4';
export type EntityReadOperation = 'get' | 'getMany';
export type EntityWriteOperation = 'create' | 'update' | 'delete';
export type EntityOperation = EntityReadOperation | EntityWriteOperation;
export type ODataValueType =
	| 'string'
	| 'number'
	| 'decimal'
	| 'boolean'
	| 'date'
	| 'datetime'
	| 'guid';
export type ODataWriteValueType = ODataValueType | 'object' | 'array';
export type FilterOperator =
	| 'eq'
	| 'ne'
	| 'gt'
	| 'ge'
	| 'lt'
	| 'le'
	| 'contains'
	| 'startsWith'
	| 'endsWith';

export interface ODataGuardCredentials {
	host: string;
	authMode?: 'none' | 'basicAuth';
	username?: string;
	password?: string;
	clientSecret?: string;
	accessToken?: string;
	oauthTokenData?: unknown;
	sapClient?: string;
	sapLanguage?: string;
	servicePoliciesJson: string;
	allowServiceDiscovery?: boolean;
	maxCatalogServices?: number;
	allowPrivateNetwork?: boolean;
	allowInsecureHttp?: boolean;
	rejectUnauthorized?: boolean;
	allowAiTool?: boolean;
	allowAiMetadata?: boolean;
	allowAiWrites?: boolean;
	maxRows: number;
	maxPages: number;
	maxUrlLength: number;
	maxResponseBytes: number;
	maxRequestBytes: number;
	maxWrites: number;
	requestTimeout: number;
	aiToolMaxRows?: number;
	aiToolMaxBytes?: number;
	aiToolMaxWrites?: number;
}

export interface ODataCatalogService extends IDataObject {
	id: string;
	title: string;
	technicalName: string;
	servicePath: string;
	protocolVersion: ODataVersion;
	technicalVersion?: string;
	description?: string;
}

export interface RequiredFilterPolicy {
	field: string;
	operator: FilterOperator;
	value: unknown;
}

export interface EntityPolicy {
	name: string;
	operations: Set<EntityOperation>;
	fields: string[];
	keyFields: Map<string, ODataValueType>;
	filterFields: Map<string, ODataValueType>;
	orderByFields: Set<string>;
	requiredFilters: RequiredFilterPolicy[];
	createFields: Map<string, ODataWriteValueType>;
	updateFields: Map<string, ODataWriteValueType>;
	requiredCreateFields: Set<string>;
	nullableCreateFields: Set<string>;
	nullableUpdateFields: Set<string>;
	allowWildcardIfMatch: boolean;
}

export interface ServicePolicy {
	path: string;
	version: ODataVersion;
	allowMetadata: boolean;
	entities: Map<string, EntityPolicy>;
}

export type ServicePolicies = Map<string, ServicePolicy>;

export interface UiFilter {
	field: string;
	operator: FilterOperator;
	value: unknown;
}

export interface UiOrderBy {
	field: string;
	direction: 'asc' | 'desc';
}

export type FilterLogic = 'and' | 'or';

export interface EntityReadQuery {
	selectedFields: string[];
	filters: UiFilter[];
	filterLogic: FilterLogic;
	orderBy: UiOrderBy[];
	pageSize: number;
}

export interface ODataPage {
	items: IDataObject[];
	nextLink?: string;
	serializedBytes: number;
}

export interface ODataExecutionMetadata extends IDataObject {
	servicePath: string;
	entitySet?: string;
	operation: string;
	version: ODataVersion;
	rowCount?: number;
	rowLimit?: number;
	pageCount?: number;
	truncated?: boolean;
	requiredFilterCount?: number;
	durationMs: number;
	policyApplied: true;
}

export interface ODataMutationResult {
	item?: IDataObject;
	statusCode: number;
	serializedBytes: number;
	etag?: string;
}

export type ODataHttpRequest = (options: IHttpRequestOptions) => Promise<unknown>;
