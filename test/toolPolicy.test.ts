import assert from 'node:assert/strict';
import test from 'node:test';

import { enforceAiToolByteLimit, resolveAiToolPolicy } from '../nodes/SapOdataGuard/toolPolicy';
import { credentials } from './fixtures';

test('normal node is unaffected by AI opt-ins', () => {
	assert.deepEqual(resolveAiToolPolicy('pkg.sapOdataGuard', 'entity', 'getMany', credentials()), {
		isTool: false,
	});
});

test('AI Tool needs general and metadata-specific opt-ins', () => {
	assert.throws(
		() => resolveAiToolPolicy('pkg.sapOdataGuardTool', 'entity', 'getMany', credentials()),
		/AI Tool use is disabled/,
	);
	assert.throws(
		() =>
			resolveAiToolPolicy(
				'pkg.sapOdataGuardTool',
				'metadata',
				'getMetadata',
				credentials({ allowAiTool: true }),
			),
		/separate credential opt-in/,
	);
	assert.deepEqual(
		resolveAiToolPolicy(
			'pkg.sapOdataGuardTool',
			'metadata',
			'getMetadata',
			credentials({ allowAiTool: true, allowAiMetadata: true }),
		),
		{ isTool: true, maxRows: 100, maxBytes: 262144 },
	);
});

test('AI Tool cannot enumerate the SAP service catalog', () => {
	assert.throws(
		() =>
			resolveAiToolPolicy(
				'pkg.sapOdataGuardTool',
				'catalog',
				'listServices',
				credentials({ allowAiTool: true, allowServiceDiscovery: true }),
			),
		/catalog discovery is intentionally unavailable/,
	);
});

test('AI Tool write operations need a separate opt-in and write cap', () => {
	assert.throws(
		() =>
			resolveAiToolPolicy(
				'pkg.sapOdataGuardTool',
				'entity',
				'create',
				credentials({ allowAiTool: true }),
			),
		/AI write operations require/,
	);
	assert.deepEqual(
		resolveAiToolPolicy(
			'pkg.sapOdataGuardTool',
			'entity',
			'update',
			credentials({ allowAiTool: true, allowAiWrites: true, aiToolMaxWrites: 1 }),
		),
		{ isTool: true, maxRows: 100, maxBytes: 262144, maxWrites: 1 },
	);
});

test('AI Tool byte limit fails closed', () => {
	assert.throws(() => enforceAiToolByteLimit({ value: '1234567890' }, 5), /above the credential limit/);
});
