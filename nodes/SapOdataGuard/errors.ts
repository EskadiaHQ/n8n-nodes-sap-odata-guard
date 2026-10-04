import { OperationalError, type IDataObject } from 'n8n-workflow';
import type { ODataGuardCredentials } from './types';

function object(value: unknown): Record<string, unknown> {
	if (typeof value === 'string' && value.length <= 65536) {
		try {
			return object(JSON.parse(value));
		} catch {
			return {};
		}
	}
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function redactText(
	value: unknown,
	credentials: ODataGuardCredentials,
	extra: string[] = [],
): string {
	const secrets = new Set(extra.filter(Boolean));
	const visit = (value: unknown, key = '', depth = 0): void => {
		if (depth > 8) return;
		if (typeof value === 'string') {
			if (/password|secret|token/i.test(key) && value) secrets.add(value);
			if (key === 'oauthTokenData') visit(object(value), '', depth + 1);
		} else
			for (const [name, child] of Object.entries(object(value)).slice(0, 128))
				visit(child, name, depth + 1);
	};
	visit(credentials);
	if (credentials.username && credentials.password)
		secrets.add(Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64'));
	for (const secret of [...secrets]) {
		secrets.add(encodeURIComponent(secret));
		secrets.add(JSON.stringify(secret).slice(1, -1));
	}
	let result = String(value ?? '');
	for (const secret of [...secrets].sort((a, b) => b.length - a.length))
		result = result.split(secret).join('[REDACTED]');
	return result
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=_.,~-]+/gi, '$1 [REDACTED]')
		.replace(
			/\b(authorization|cookie|set-cookie|x-csrf-token)\s*[:=]\s*[^\r\n]+/gi,
			'$1: [REDACTED]',
		)
		.split('')
		.filter((character) => {
			const code = character.charCodeAt(0);
			return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
		})
		.join('')
		.slice(0, 2048);
}

export function httpStatus(error: unknown): number | undefined {
	const root = object(error),
		response = object(root.response);
	const code = Number(
		root.statusCode ??
			root.httpCode ??
			response.statusCode ??
			response.status ??
			root.httpStatusCode,
	);
	return Number.isInteger(code) && code >= 100 && code <= 599 ? code : undefined;
}

export function responseHeaders(error: unknown): Record<string, unknown> {
	const root = object(error);
	return object(object(root.response).headers ?? root.headers);
}

export class SapODataRequestError extends OperationalError {
	readonly statusCode?: number;
	readonly sapCode?: string;
	readonly details: IDataObject[];
	readonly hint?: string;
	constructor(error: unknown, credentials: ODataGuardCredentials, extra: string[] = []) {
		const root = object(error),
			response = object(root.response);
		const body = object(response.data ?? response.body ?? root.error ?? root.body);
		const sap = Object.keys(object(body.error)).length ? object(body.error) : body;
		const code = redactText(sap.code, credentials, extra).slice(0, 128);
		const message = typeof sap.message === 'string' ? sap.message : object(sap.message).value;
		const text = redactText(message ?? root.message ?? 'Unknown request error', credentials, extra);
		const status = httpStatus(error);
		super(
			`SAP OData request failed${status ? ` (HTTP ${status})` : ''}${code ? ` [${code}]` : ''}: ${text}`,
		);
		this.statusCode = status;
		this.sapCode = code || undefined;
		const entries = sap.details ?? object(sap.innererror).errordetails;
		this.details = (Array.isArray(entries) ? entries.slice(0, 8) : []).map((entry) => {
			const detail = object(entry);
			return {
				code: redactText(detail.code, credentials, extra).slice(0, 128),
				message: redactText(
					typeof detail.message === 'string' ? detail.message : object(detail.message).value,
					credentials,
					extra,
				),
				target: redactText(detail.target, credentials, extra).slice(0, 128),
			};
		});
		this.hint =
			status === 401
				? 'Check the credential and SAP user status.'
				: status === 403
					? 'Check SAP authorization; a 403 does not by itself prove an expired CSRF token.'
					: status === 412
						? 'Read the current entity and ETag before deciding whether to apply the update again.'
						: undefined;
	}

	toJSON(): IDataObject {
		return {
			error: this.message,
			...(this.statusCode ? { statusCode: this.statusCode } : {}),
			...(this.sapCode ? { sapCode: this.sapCode } : {}),
			...(this.hint ? { hint: this.hint } : {}),
			...(this.details.length ? { details: this.details } : {}),
		};
	}
}
