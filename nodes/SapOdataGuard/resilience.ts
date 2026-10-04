import { OperationalError, sleep, type IHttpRequestOptions } from 'n8n-workflow';
import { httpStatus, responseHeaders } from './errors';
import type { ODataGuardCredentials, ODataHttpRequest } from './types';

interface Budget {
	started: number;
	calls: number;
	last: number;
}
const budgets = new WeakMap<ODataGuardCredentials, Budget>();

function retryDelay(error: unknown, attempt: number): number {
	const headers = responseHeaders(error);
	const retryAfter = Object.entries(headers).find(
		([key]) => key.toLowerCase() === 'retry-after',
	)?.[1];
	if (retryAfter !== undefined) {
		const value = String(retryAfter);
		const delay = /^\d+(?:\.\d+)?$/.test(value)
			? Number(value) * 1000
			: Date.parse(value) - Date.now();
		if (Number.isFinite(delay) && delay >= 0) return delay;
	}
	return Math.min(10000, 500 * 2 ** attempt * (1 + Math.random() * 0.2));
}

export async function requestWithPolicy(
	http: ODataHttpRequest,
	options: IHttpRequestOptions,
	credentials: ODataGuardCredentials,
): Promise<unknown> {
	let budget = budgets.get(credentials);
	if (!budget) {
		budget = { started: Date.now(), calls: 0, last: 0 };
		budgets.set(credentials, budget);
	}
	const retries = options.method === 'GET' ? Number(credentials.readRetryAttempts ?? 0) : 0;
	const interval = Number(credentials.minRequestIntervalMs ?? 0);
	const deadline =
		retries > 0 || interval > 0
			? budget.started + Number(credentials.maxReadElapsedMs ?? 60000)
			: Infinity;
	for (let attempt = 0; ; attempt++) {
		const wait = Math.max(0, budget.last + interval - Date.now());
		if (Date.now() + wait >= deadline)
			throw new OperationalError('Credential HTTP elapsed-time budget exceeded.');
		if (budget.calls >= Number(credentials.maxHttpRequests ?? 200))
			throw new OperationalError('Credential HTTP request-count budget exceeded.');
		if (wait > 0) await sleep(wait);
		if (Date.now() >= deadline)
			throw new OperationalError('Credential HTTP elapsed-time budget exceeded.');
		budget.calls++;
		budget.last = Date.now();
		try {
			return await http({
				...options,
				timeout: Math.max(
					1,
					Math.min(Number(options.timeout ?? credentials.requestTimeout), deadline - Date.now()),
				),
			});
		} catch (error) {
			const status = httpStatus(error);
			const networkCode =
				error && typeof error === 'object' ? (error as Record<string, unknown>).code : undefined;
			if (
				attempt >= retries ||
				!(
					(status && [429, 502, 503, 504].includes(status)) ||
					['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(String(networkCode))
				)
			) {
				// The caller sanitizes the transport error before it reaches the node boundary.
				// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
				throw error;
			}
			const delay = retryDelay(error, attempt);
			// Never shorten a server-requested delay to fit our budget.
			if (Date.now() + delay >= deadline) {
				// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
				throw error;
			}
			await sleep(delay);
		}
	}
}
