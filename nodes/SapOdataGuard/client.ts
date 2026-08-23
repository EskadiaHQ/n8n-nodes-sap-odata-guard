import { OperationalError, type IDataObject, type IHttpRequestOptions } from 'n8n-workflow';

import { normalizeHost } from './governance';
import type {
	EntityPolicy,
	ODataGuardCredentials,
	ODataHttpRequest,
	ODataMutationResult,
	ODataPage,
} from './types';

function byteLength(value: unknown): number {
	return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function enforceUrlLength(url: string, maximum: number): void {
	if (url.length > maximum) {
		throw new OperationalError(`OData URL is ${url.length} characters, above the limit of ${maximum}.`);
	}
}

function serializeODataUrl(url: URL): string {
	// URLSearchParams follows form encoding and serializes spaces as "+". OData
	// expressions use URI query syntax, where whitespace must be percent-encoded.
	// Literal plus signs are already encoded as %2B, so this replacement is safe.
	return url.toString().replace(/\+/g, '%20');
}

function addSapContext(url: URL, credentials: ODataGuardCredentials): void {
	if (credentials.sapClient) url.searchParams.set('sap-client', credentials.sapClient);
	if (credentials.sapLanguage) url.searchParams.set('sap-language', credentials.sapLanguage);
}

export function serviceRootUrl(
	credentials: ODataGuardCredentials,
	servicePath: string,
): string {
	const host = normalizeHost(
		credentials.host,
		credentials.allowInsecureHttp === true,
		credentials.allowPrivateNetwork === true,
	);
	return `${host}${servicePath}`;
}

export function buildMetadataUrl(
	credentials: ODataGuardCredentials,
	servicePath: string,
): string {
	const url = new URL(`${serviceRootUrl(credentials, servicePath)}/$metadata`);
	addSapContext(url, credentials);
	const result = serializeODataUrl(url);
	enforceUrlLength(result, credentials.maxUrlLength);
	return result;
}

export interface CollectionUrlOptions {
	keyPredicate?: string;
	select: string[];
	filter?: string;
	orderBy?: string;
	top?: number;
}

export function buildEntityUrl(
	credentials: ODataGuardCredentials,
	servicePath: string,
	entitySet: string,
	options: CollectionUrlOptions,
): string {
	const suffix = options.keyPredicate ? `${entitySet}(${options.keyPredicate})` : entitySet;
	const url = new URL(`${serviceRootUrl(credentials, servicePath)}/${suffix}`);
	url.searchParams.set('$select', options.select.join(','));
	if (options.filter) url.searchParams.set('$filter', options.filter);
	if (options.orderBy) url.searchParams.set('$orderby', options.orderBy);
	if (options.top !== undefined) url.searchParams.set('$top', String(options.top));
	addSapContext(url, credentials);
	const result = serializeODataUrl(url);
	enforceUrlLength(result, credentials.maxUrlLength);
	return result;
}

export function buildMutationUrl(
	credentials: ODataGuardCredentials,
	servicePath: string,
	entitySet: string,
	keyPredicate?: string,
): string {
	const suffix = keyPredicate ? `${entitySet}(${keyPredicate})` : entitySet;
	const url = new URL(`${serviceRootUrl(credentials, servicePath)}/${suffix}`);
	addSapContext(url, credentials);
	const result = serializeODataUrl(url);
	enforceUrlLength(result, credentials.maxUrlLength);
	return result;
}

export function resolveNextLink(
	nextLink: string,
	currentUrl: string,
	governedCollectionUrl: string,
	credentials: ODataGuardCredentials,
): string {
	let resolved: URL;
	try {
		resolved = new URL(nextLink, currentUrl);
	} catch {
		// The HTTP call succeeded; this validates untrusted server-provided data locally.
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
		throw new OperationalError('The OData service returned an invalid pagination link.');
	}
	const expected = new URL(governedCollectionUrl);
	if (
		resolved.username ||
		resolved.password ||
		resolved.hash ||
		resolved.origin !== expected.origin ||
		resolved.pathname.replace(/\/$/, '') !== expected.pathname.replace(/\/$/, '')
	) {
		throw new OperationalError(
			'The OData service returned a pagination link outside the approved origin or entity collection.',
		);
	}
	const protectedParameters = ['$select', '$filter', '$orderby', '$top'];
	const continuationParameters = ['$skiptoken', '$skip'];
	const allowedParameters = new Set([
		...protectedParameters,
		...continuationParameters,
		'sap-client',
		'sap-language',
	]);
	for (const key of new Set(resolved.searchParams.keys())) {
		if (!allowedParameters.has(key)) {
			throw new OperationalError(
				`The OData pagination link contains unsupported query parameter ${key}.`,
			);
		}
		if (resolved.searchParams.getAll(key).length !== 1) {
			throw new OperationalError(`The OData pagination link repeats query parameter ${key}.`);
		}
	}
	for (const key of protectedParameters) {
		const expectedValue = expected.searchParams.get(key);
		const providedValue = resolved.searchParams.get(key);
		if (providedValue !== null && providedValue !== expectedValue) {
			throw new OperationalError(
				`The OData pagination link attempted to change protected query parameter ${key}.`,
			);
		}
		if (expectedValue === null) resolved.searchParams.delete(key);
		else resolved.searchParams.set(key, expectedValue);
	}
	if (continuationParameters.filter((key) => resolved.searchParams.has(key)).length !== 1) {
		throw new OperationalError(
			'The OData pagination link must contain exactly one supported continuation parameter.',
		);
	}
	const skip = resolved.searchParams.get('$skip');
	if (skip !== null && !/^\d+$/.test(skip)) {
		throw new OperationalError('The OData pagination $skip value must be a non-negative integer.');
	}
	addSapContext(resolved, credentials);
	const result = serializeODataUrl(resolved);
	enforceUrlLength(result, credentials.maxUrlLength);
	return result;
}

function requestOptions(
	url: string,
	credentials: ODataGuardCredentials,
	json: boolean,
): IHttpRequestOptions {
	const options: IHttpRequestOptions = {
		method: 'GET',
		url,
		headers: { Accept: json ? 'application/json' : 'application/xml, text/xml' },
		json,
		timeout: credentials.requestTimeout,
		skipSslCertificateValidation: credentials.rejectUnauthorized === false,
	};
	if (credentials.authMode === 'basicAuth') {
		options.auth = { username: credentials.username ?? '', password: credentials.password ?? '' };
	}
	return options;
}

interface ODataFullResponse {
	body: unknown;
	headers: Record<string, unknown>;
	statusCode: number;
}

function fullResponse(value: unknown, label: string): ODataFullResponse {
	if (!value || typeof value !== 'object' || !('headers' in value) || !('statusCode' in value)) {
		throw new OperationalError(`${label} did not return the required HTTP headers.`);
	}
	const response = value as {
		body?: unknown;
		headers?: unknown;
		statusCode?: unknown;
	};
	if (!response.headers || typeof response.headers !== 'object' || Array.isArray(response.headers)) {
		throw new OperationalError(`${label} returned invalid HTTP headers.`);
	}
	const statusCode = Number(response.statusCode);
	if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
		throw new OperationalError(`${label} returned an invalid HTTP status code.`);
	}
	return {
		body: response.body,
		headers: response.headers as Record<string, unknown>,
		statusCode,
	};
}

function headerValue(headers: Record<string, unknown>, name: string): unknown {
	const normalized = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === normalized) return value;
	}
	return undefined;
}

function containsControlCharacter(value: string): boolean {
	return [...value].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || code === 127;
	});
}

function safeResponseHeader(value: unknown, label: string, maximum = 4096): string | undefined {
	const candidate = Array.isArray(value) ? value[0] : value;
	if (candidate === undefined || candidate === null || candidate === '') return undefined;
	const normalized = String(candidate).trim();
	if (!normalized || normalized.length > maximum || containsControlCharacter(normalized)) {
		throw new OperationalError(`${label} returned an invalid header value.`);
	}
	return normalized;
}

function cookieHeader(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	const rawCookies = Array.isArray(value)
		? value.map(String)
		: String(value).split(/,(?=\s*[^;,=\s]+=[^;,]*)/);
	const cookies = rawCookies
		.map((cookie) => cookie.trim().split(';', 1)[0])
		.filter((cookie) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[^\r\n;]*$/.test(cookie));
	if (cookies.length === 0) return undefined;
	const result = cookies.join('; ');
	if (result.length > 16384) {
		throw new OperationalError('SAP OData CSRF response returned oversized session cookies.');
	}
	return result;
}

function csrfRequestOptions(
	credentials: ODataGuardCredentials,
	servicePath: string,
): IHttpRequestOptions {
	const url = new URL(`${serviceRootUrl(credentials, servicePath)}/`);
	addSapContext(url, credentials);
	const result: IHttpRequestOptions = {
		method: 'GET',
		url: url.toString(),
		headers: {
			Accept: 'application/json',
			'Cache-Control': 'no-cache',
			'X-CSRF-Token': 'Fetch',
		},
		json: false,
		returnFullResponse: true,
		timeout: credentials.requestTimeout,
		skipSslCertificateValidation: credentials.rejectUnauthorized === false,
	};
	if (credentials.authMode === 'basicAuth') {
		result.auth = { username: credentials.username ?? '', password: credentials.password ?? '' };
	}
	enforceUrlLength(result.url, credentials.maxUrlLength);
	return result;
}

function credentialSecrets(credentials: ODataGuardCredentials): string[] {
	const secrets = new Set<string>();
	const inspect = (value: unknown, key = ''): void => {
		if (typeof value === 'string') {
			if (/password|secret|token/i.test(key) && value.length >= 4) secrets.add(value);
			if (key === 'oauthTokenData') {
				try {
					inspect(JSON.parse(value), key);
				} catch {
					// OAuth token data may already be an opaque token instead of JSON.
				}
			}
			return;
		}
		if (!value || typeof value !== 'object') return;
		for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
			inspect(nestedValue, nestedKey);
		}
	};
	inspect(credentials);
	return [...secrets].sort((a, b) => b.length - a.length);
}

async function performRequest(
	httpRequest: ODataHttpRequest,
	options: IHttpRequestOptions,
	credentials: ODataGuardCredentials,
	additionalSecrets: string[] = [],
): Promise<unknown> {
	try {
		return await httpRequest(options);
	} catch (error) {
		const original = error instanceof Error ? error.message : String(error);
		const redacted = [...credentialSecrets(credentials), ...additionalSecrets]
			.filter((secret) => secret.length >= 4)
			.sort((a, b) => b.length - a.length)
			.reduce(
			(message, secret) => message.split(secret).join('[REDACTED]'),
			original,
			);
		// Converted to NodeOperationError at the execute boundary, which has node context.
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
		throw new OperationalError(`SAP OData request failed: ${redacted}`);
	}
}

function objectValue(value: unknown, label: string): IDataObject {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new OperationalError(`${label} is not an OData object.`);
	}
	return value as IDataObject;
}

function objectArray(value: unknown, label: string): IDataObject[] {
	if (!Array.isArray(value)) throw new OperationalError(`${label} is not an OData collection.`);
	return value.map((item, index) => objectValue(item, `${label}[${index}]`));
}

export function parseODataPage(payload: unknown): ODataPage {
	const serializedBytes = byteLength(payload);
	const root = objectValue(payload, 'OData response');
	if (Object.prototype.hasOwnProperty.call(root, 'd')) {
		const d = objectValue(root.d, 'OData V2 response.d');
		if (Array.isArray(d.results)) {
			return {
				items: objectArray(d.results, 'OData V2 response.d.results'),
				nextLink: typeof d.__next === 'string' ? d.__next : undefined,
				serializedBytes,
			};
		}
		return { items: [d], serializedBytes };
	}
	if (Array.isArray(root.value)) {
		return {
			items: objectArray(root.value, 'OData V4 response.value'),
			nextLink:
				typeof root['@odata.nextLink'] === 'string'
					? (root['@odata.nextLink'] as string)
					: undefined,
			serializedBytes,
		};
	}
	return { items: [root], serializedBytes };
}

export async function requestMetadata(
	httpRequest: ODataHttpRequest,
	credentials: ODataGuardCredentials,
	servicePath: string,
): Promise<{ xml: string; serializedBytes: number }> {
	const response = await performRequest(
		httpRequest,
		requestOptions(buildMetadataUrl(credentials, servicePath), credentials, false),
		credentials,
	);
	const xml = Buffer.isBuffer(response) ? response.toString('utf8') : String(response);
	const serializedBytes = byteLength(xml);
	if (serializedBytes > credentials.maxResponseBytes) {
		throw new OperationalError(
			`Metadata response is ${serializedBytes} bytes, above the credential limit.`,
		);
	}
	return { xml, serializedBytes };
}

export interface ReadCollectionResult {
	items: IDataObject[];
	pageCount: number;
	serializedBytes: number;
	truncated: boolean;
}

export async function requestCollection(
	httpRequest: ODataHttpRequest,
	credentials: ODataGuardCredentials,
	initialUrl: string,
	governedCollectionUrl: string,
	rowLimit: number,
): Promise<ReadCollectionResult> {
	const items: IDataObject[] = [];
	let currentUrl: string | undefined = initialUrl;
	let pageCount = 0;
	let serializedBytes = 0;
	let truncated = false;
	while (currentUrl && pageCount < credentials.maxPages && items.length < rowLimit) {
		const payload = await performRequest(
			httpRequest,
			requestOptions(currentUrl, credentials, true),
			credentials,
		);
		const page = parseODataPage(payload);
		pageCount += 1;
		serializedBytes += page.serializedBytes;
		if (serializedBytes > credentials.maxResponseBytes) {
			throw new OperationalError(
				`Cumulative OData response is ${serializedBytes} bytes, above the credential limit.`,
			);
		}
		const remaining = rowLimit - items.length;
		items.push(...page.items.slice(0, remaining));
		if (page.items.length > remaining) truncated = true;
		if (!page.nextLink) {
			currentUrl = undefined;
		} else if (items.length >= rowLimit) {
			truncated = true;
			currentUrl = undefined;
		} else {
			currentUrl = resolveNextLink(
				page.nextLink,
				currentUrl,
				governedCollectionUrl,
				credentials,
			);
		}
	}
	if (currentUrl) truncated = true;
	return { items, pageCount, serializedBytes, truncated };
}

export async function requestSingle(
	httpRequest: ODataHttpRequest,
	credentials: ODataGuardCredentials,
	url: string,
): Promise<{ item: IDataObject; serializedBytes: number; etag?: string }> {
	const payload = await performRequest(
		httpRequest,
		requestOptions(url, credentials, true),
		credentials,
	);
	const page = parseODataPage(payload);
	if (page.serializedBytes > credentials.maxResponseBytes) {
		throw new OperationalError('OData response exceeds the credential byte limit.');
	}
	if (page.items.length !== 1) {
		throw new OperationalError('Get expected exactly one OData entity.');
	}
	const item = page.items[0];
	const etag =
		typeof item['@odata.etag'] === 'string'
			? item['@odata.etag']
			: item.__metadata &&
				  typeof item.__metadata === 'object' &&
				  typeof (item.__metadata as Record<string, unknown>).etag === 'string'
				? String((item.__metadata as Record<string, unknown>).etag)
				: undefined;
	return { item, serializedBytes: page.serializedBytes, etag };
}

export async function requestMutation(
	httpRequest: ODataHttpRequest,
	credentials: ODataGuardCredentials,
	servicePath: string,
	method: 'POST' | 'PATCH' | 'DELETE',
	url: string,
	body?: Record<string, unknown>,
	ifMatch?: string,
): Promise<ODataMutationResult> {
	const csrfRaw = await performRequest(
		httpRequest,
		csrfRequestOptions(credentials, servicePath),
		credentials,
	);
	const csrfResponse = fullResponse(csrfRaw, 'SAP OData CSRF request');
	const csrfToken = safeResponseHeader(
		headerValue(csrfResponse.headers, 'x-csrf-token'),
		'SAP OData CSRF request',
	);
	if (!csrfToken || /^(fetch|required)$/i.test(csrfToken)) {
		throw new OperationalError('SAP OData service did not return a usable CSRF token.');
	}
	const cookie = cookieHeader(headerValue(csrfResponse.headers, 'set-cookie'));
	const headers: Record<string, string> = {
		Accept: 'application/json',
		'Content-Type': 'application/json',
		'X-CSRF-Token': csrfToken,
	};
	// SAP CAP and other strict OData runtimes reject return preferences on DELETE.
	// The successful 2xx status is sufficient evidence for a delete operation.
	if (method !== 'DELETE') headers.Prefer = 'return=representation';
	if (cookie) headers.Cookie = cookie;
	if (ifMatch) headers['If-Match'] = ifMatch;
	const options: IHttpRequestOptions = {
		method,
		url,
		headers,
		json: false,
		returnFullResponse: true,
		timeout: credentials.requestTimeout,
		skipSslCertificateValidation: credentials.rejectUnauthorized === false,
	};
	if (body !== undefined) options.body = JSON.stringify(body);
	if (credentials.authMode === 'basicAuth') {
		options.auth = { username: credentials.username ?? '', password: credentials.password ?? '' };
	}
	const mutationRaw = await performRequest(
		httpRequest,
		options,
		credentials,
		[csrfToken, ...(cookie ? [cookie] : [])],
	);
	const mutation = fullResponse(mutationRaw, 'SAP OData write request');
	let responseBody = mutation.body;
	if (Buffer.isBuffer(responseBody)) responseBody = responseBody.toString('utf8');
	if (typeof responseBody === 'string') {
		const trimmed = responseBody.trim();
		if (!trimmed) responseBody = undefined;
		else {
			try {
				responseBody = JSON.parse(trimmed);
			} catch {
				// Converted to NodeOperationError at the execute boundary, which has node context.
				// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
				throw new OperationalError('SAP OData write response was not valid JSON.');
			}
		}
	}
	const serializedBytes = responseBody === undefined ? 0 : byteLength(responseBody);
	if (serializedBytes > credentials.maxResponseBytes) {
		throw new OperationalError('OData write response exceeds the credential byte limit.');
	}
	let item: IDataObject | undefined;
	if (responseBody !== undefined) {
		const page = parseODataPage(responseBody);
		if (page.items.length > 1) {
			throw new OperationalError('OData write response returned more than one entity.');
		}
		item = page.items[0];
	}
	const responseEtag = safeResponseHeader(
		headerValue(mutation.headers, 'etag'),
		'SAP OData write response',
		1024,
	);
	const itemEtag =
		item && typeof item['@odata.etag'] === 'string'
			? item['@odata.etag']
			: item?.__metadata &&
				  typeof item.__metadata === 'object' &&
				  typeof (item.__metadata as Record<string, unknown>).etag === 'string'
				? String((item.__metadata as Record<string, unknown>).etag)
				: undefined;
	return {
		item,
		statusCode: mutation.statusCode,
		serializedBytes,
		etag: responseEtag ?? itemEtag,
	};
}

export function projectItem(item: IDataObject, fields: string[]): IDataObject {
	const projected: IDataObject = {};
	for (const field of fields) {
		if (Object.prototype.hasOwnProperty.call(item, field)) projected[field] = item[field];
	}
	return projected;
}

export function allowedEntitySetsFromMetadata(xml: string, policy: Map<string, EntityPolicy>): string[] {
	const discovered = new Set<string>();
	const entitySetPattern = /<(?:\w+:)?EntitySet\b[^>]*\bName\s*=\s*["']([^"']+)["'][^>]*>/gi;
	let match: RegExpExecArray | null;
	while ((match = entitySetPattern.exec(xml)) !== null) {
		const name = match[1];
		if (policy.has(name)) discovered.add(name);
	}
	return [...discovered].sort();
}
