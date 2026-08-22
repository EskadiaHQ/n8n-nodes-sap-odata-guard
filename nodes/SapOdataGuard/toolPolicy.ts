import { OperationalError } from 'n8n-workflow';

import type { ODataGuardCredentials } from './types';

const AI_TOOL_NODE_TYPE = /(?:^|\.)sapOdataGuardTool$/;

export interface AiToolPolicy {
	isTool: boolean;
	maxRows?: number;
	maxBytes?: number;
}

export function isODataGuardAiToolNode(nodeType: string): boolean {
	return AI_TOOL_NODE_TYPE.test(nodeType);
}

export function resolveAiToolPolicy(
	nodeType: string,
	resource: string,
	credentials: ODataGuardCredentials,
): AiToolPolicy {
	if (!isODataGuardAiToolNode(nodeType)) return { isTool: false };
	if (credentials.allowAiTool !== true) {
		throw new OperationalError(
			'AI Tool use is disabled in the selected credential. Enable it only for governed reads.',
		);
	}
	if (resource === 'metadata' && credentials.allowAiMetadata !== true) {
		throw new OperationalError('AI metadata discovery requires its separate credential opt-in.');
	}
	return {
		isTool: true,
		maxRows: credentials.aiToolMaxRows,
		maxBytes: credentials.aiToolMaxBytes,
	};
}

export function enforceAiToolByteLimit(value: unknown, maxBytes?: number): void {
	if (maxBytes === undefined) return;
	const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
	if (size > maxBytes) {
		throw new OperationalError(
			`AI Tool result is ${size} bytes, above the credential limit of ${maxBytes} bytes.`,
		);
	}
}
