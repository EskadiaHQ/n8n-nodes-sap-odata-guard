import assert from 'node:assert/strict';
import test from 'node:test';

import { enforceAiToolByteLimit, resolveAiToolPolicy } from '../nodes/SapOdataGuard/toolPolicy';
import { credentials } from './fixtures';

test('normal node is unaffected by AI opt-ins', () => {
	assert.deepEqual(resolveAiToolPolicy('pkg.sapOdataGuard', 'entity', credentials()), {
		isTool: false,
	});
});

test('AI Tool needs general and metadata-specific opt-ins', () => {
	assert.throws(
		() => resolveAiToolPolicy('pkg.sapOdataGuardTool', 'entity', credentials()),
		/AI Tool use is disabled/,
	);
	assert.throws(
		() =>
			resolveAiToolPolicy(
				'pkg.sapOdataGuardTool',
				'metadata',
				credentials({ allowAiTool: true }),
			),
		/separate credential opt-in/,
	);
	assert.deepEqual(
		resolveAiToolPolicy(
			'pkg.sapOdataGuardTool',
			'metadata',
			credentials({ allowAiTool: true, allowAiMetadata: true }),
		),
		{ isTool: true, maxRows: 100, maxBytes: 262144 },
	);
});

test('AI Tool byte limit fails closed', () => {
	assert.throws(() => enforceAiToolByteLimit({ value: '1234567890' }, 5), /above the credential limit/);
});
