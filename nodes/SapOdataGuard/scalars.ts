import { OperationalError, type IDataObject } from 'n8n-workflow';
import type { ODataValueType } from './types';

export function int64Value(value: unknown): string {
	if (typeof value === 'number' && !Number.isSafeInteger(value)) {
		throw new OperationalError(
			'Int64 numbers must be safe integers; use a decimal string for large values.',
		);
	}
	if (!['string', 'number'].includes(typeof value) || !/^-?\d{1,19}$/.test(String(value))) {
		throw new OperationalError('Int64 must be an integer decimal string or safe integer.');
	}
	const number = BigInt(String(value));
	if (number < BigInt('-9223372036854775808') || number > BigInt('9223372036854775807')) {
		throw new OperationalError('Int64 is outside the signed 64-bit range.');
	}
	return number.toString();
}

export function calendarDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function localDateTime(value: unknown): string {
	if (
		typeof value !== 'string' ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?$/.test(value) ||
		!calendarDate(value.slice(0, 10)) ||
		!validClock(value.slice(11))
	) {
		throw new OperationalError(
			'Local datetime must use YYYY-MM-DDTHH:mm:ss with optional fraction and no timezone.',
		);
	}
	return value;
}

function validClock(value: string): boolean {
	return /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,7})?$/.test(value);
}

export function offsetDateTime(value: unknown): string {
	if (
		typeof value !== 'string' ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(
			value,
		)
	) {
		throw new OperationalError('DatetimeOffset must be an ISO datetime with an explicit timezone.');
	}
	localDateTime(value.replace(/(?:Z|[+-]\d{2}:\d{2})$/, ''));
	if (!Number.isFinite(Date.parse(value))) throw new OperationalError('Invalid DatetimeOffset.');
	if (/[+-]14:(?!00)/.test(value))
		throw new OperationalError('Timezone offset cannot exceed 14 hours.');
	return value;
}

export function timeOfDay(value: unknown): string {
	if (typeof value !== 'string' || !validClock(value)) {
		throw new OperationalError('TimeOfDay must use HH:mm:ss with an optional fraction.');
	}
	return value;
}

export function timeDuration(value: unknown): string {
	if (typeof value !== 'string') throw new OperationalError('Time must be an ISO time duration.');
	const match = /^PT(?:(\d{1,2})H)?(?:(\d{1,2})M)?(?:(\d{1,2}(?:\.\d{1,7})?)S)?$/.exec(value);
	if (
		!match ||
		!match.slice(1).some((part) => part !== undefined) ||
		Number(match[1] ?? 0) > 23 ||
		Number(match[2] ?? 0) > 59 ||
		Number(match[3] ?? 0) >= 60
	) {
		throw new OperationalError('Time must be a duration within one day, such as PT14H30M00.5S.');
	}
	const [seconds, fraction] = String(match[3] ?? '0').split('.');
	return `${String(match[1] ?? '0').padStart(2, '0')}:${String(match[2] ?? '0').padStart(2, '0')}:${seconds.padStart(2, '0')}${fraction ? `.${fraction}` : ''}`;
}

export function clockDuration(clock: string): string {
	const [hours, minutes, seconds] = timeOfDay(clock).split(':');
	return `PT${hours}H${minutes}M${seconds}S`;
}

export function v2DateTicks(value: string): number {
	// The V2 JSON date envelope has millisecond precision; refuse silent truncation.
	const fraction = /\.(\d+)/.exec(value)?.[1] ?? '';
	if (/[1-9]/.test(fraction.slice(3)))
		throw new OperationalError('OData V2 JSON dates cannot preserve sub-millisecond precision.');
	return Date.parse(value);
}

// Opt-in conversion of approved top-level fields only. No numeric-string inference.
export function normalizeOutputDates(
	item: IDataObject,
	fields: Map<string, ODataValueType>,
): IDataObject {
	const result = { ...item };
	for (const [field, type] of fields) {
		const value = result[field];
		if (typeof value !== 'string') continue;
		if (['date', 'datetime', 'datetime-local', 'datetimeoffset'].includes(type)) {
			const match = /^\/Date\((-?\d+)(?:([+-])(\d{4}))?\)\/$/.exec(value);
			if (!match || (match[3] && Number(match[3]) > 840)) continue;
			const date = new Date(Number(match[1]));
			if (!Number.isFinite(date.getTime())) continue;
			const iso = date.toISOString();
			result[field] =
				type === 'date' ? iso.slice(0, 10) : type === 'datetime-local' ? iso.slice(0, -1) : iso;
		} else if (type === 'time') {
			try {
				result[field] = timeDuration(value);
			} catch {
				/* Preserve invalid server values. */
			}
		}
	}
	return result;
}
