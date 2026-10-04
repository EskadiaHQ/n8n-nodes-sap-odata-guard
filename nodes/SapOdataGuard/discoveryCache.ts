import { createHash } from 'node:crypto';
import type { ODataGuardCredentials } from './types';

interface Entry {
	value: string;
	expires: number;
	bytes: number;
}
const entries = new Map<string, Entry>();
const pending = new Map<string, Promise<unknown>>();
const MAX_BYTES = 8 * 1024 * 1024;
let bytes = 0;
const invalidated = new WeakSet<Promise<unknown>>();

function keyFor(credentials: ODataGuardCredentials, resource: string): string | undefined {
	if (credentials.allowDiscoveryCache !== true || !credentials.cacheIdentity) return undefined;
	// Include all effective configuration, including identity changes and policy limits.
	const data = Object.keys(credentials)
		.sort()
		.map((key) => [key, (credentials as unknown as Record<string, unknown>)[key]]);
	return createHash('sha256')
		.update(JSON.stringify([data, resource]))
		.digest('hex');
}

function remove(key: string): void {
	const entry = entries.get(key);
	if (entry) bytes -= entry.bytes;
	entries.delete(key);
}

export async function cachedDiscovery<T>(
	credentials: ODataGuardCredentials,
	resource: string,
	load: () => Promise<T>,
	fresh = false,
): Promise<T> {
	const key = keyFor(credentials, resource);
	if (!key) return load();
	if (fresh) {
		remove(key);
		const task = pending.get(key);
		if (task) invalidated.add(task);
		pending.delete(key);
		return load();
	}
	for (const [id, entry] of entries) if (entry.expires <= Date.now()) remove(id);
	const cached = entries.get(key);
	if (cached) return JSON.parse(cached.value) as T;
	const existing = pending.get(key);
	if (existing) return JSON.parse(JSON.stringify(await existing)) as T;
	if (pending.size >= 64) return load();
	const task = load();
	pending.set(key, task);
	try {
		const result = await task;
		const value = JSON.stringify(result),
			size = Buffer.byteLength(value, 'utf8');
		if (size <= MAX_BYTES && !invalidated.has(task)) {
			while (entries.size >= 64 || bytes + size > MAX_BYTES) remove(entries.keys().next().value!);
			remove(key);
			entries.set(key, {
				value,
				bytes: size,
				expires: Date.now() + Number(credentials.discoveryCacheTtlSeconds ?? 60) * 1000,
			});
			bytes += size;
		}
		return JSON.parse(value) as T;
	} finally {
		if (pending.get(key) === task) pending.delete(key);
	}
}
