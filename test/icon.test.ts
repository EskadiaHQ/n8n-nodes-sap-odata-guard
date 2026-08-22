import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const nodeSource = readFileSync(
	new URL('../nodes/SapOdataGuard/SapOdataGuard.node.ts', import.meta.url),
	'utf8',
);
const lightIcon = readFileSync(
	new URL('../nodes/SapOdataGuard/sapOdataGuard-v021.svg', import.meta.url),
	'utf8',
);
const darkIcon = readFileSync(
	new URL('../nodes/SapOdataGuard/sapOdataGuard-v021.dark.svg', import.meta.url),
	'utf8',
);
const credentialIcon = readFileSync(
	new URL('../credentials/sapOdataGuardCredential.svg', import.meta.url),
	'utf8',
);

describe('SAP OData Guard icon family', () => {
	it('references versioned light and dark artwork', () => {
		assert.match(nodeSource, /file:sapOdataGuard-v021\.svg/);
		assert.match(nodeSource, /file:sapOdataGuard-v021\.dark\.svg/);
	});

	it('uses the Logali base and a legible OD badge in every surface', () => {
		for (const icon of [lightIcon, darkIcon, credentialIcon]) {
			assert.match(icon, /<image x="1" y="1" width="62" height="62"/);
			assert.match(icon, /<circle cx="49" cy="49" r="14\.5"/);
			assert.match(icon, /<circle cx="44\.5" cy="49" r="5\.2"/);
			assert.match(icon, /M51\.5 43\.5v11h2\.7/);
			assert.match(icon, /fill="#12C8D4"/);
		}
		assert.equal(lightIcon, darkIcon);
		assert.equal(lightIcon, credentialIcon);
	});
});
