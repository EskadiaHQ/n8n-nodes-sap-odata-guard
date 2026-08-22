import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const nodeSource = readFileSync(
	new URL('../nodes/SapOdataGuard/SapOdataGuard.node.ts', import.meta.url),
	'utf8',
);
const basicCredentialSource = readFileSync(
	new URL('../credentials/SapOdataGuardApi.credentials.ts', import.meta.url),
	'utf8',
);
const oauthCredentialSource = readFileSync(
	new URL('../credentials/SapOdataGuardOAuth2Api.credentials.ts', import.meta.url),
	'utf8',
);
const lightIcon = readFileSync(
	new URL('../nodes/SapOdataGuard/sapOdataGuard-v022.svg', import.meta.url),
	'utf8',
);
const darkIcon = readFileSync(
	new URL('../nodes/SapOdataGuard/sapOdataGuard-v022.dark.svg', import.meta.url),
	'utf8',
);
const credentialIcon = readFileSync(
	new URL('../credentials/sapOdataGuardCredential-v022.svg', import.meta.url),
	'utf8',
);

describe('SAP OData Guard icon family', () => {
	it('references versioned node and credential artwork', () => {
		assert.match(nodeSource, /file:sapOdataGuard-v022\.svg/);
		assert.match(nodeSource, /file:sapOdataGuard-v022\.dark\.svg/);
		assert.match(basicCredentialSource, /file:sapOdataGuardCredential-v022\.svg/);
		assert.match(oauthCredentialSource, /file:sapOdataGuardCredential-v022\.svg/);
	});

	it('uses the exact approved high-resolution artwork on every surface', () => {
		assert.equal(lightIcon, darkIcon);
		assert.equal(lightIcon, credentialIcon);
		const png = Buffer.from(lightIcon.match(/base64,([^"']+)/)?.[1] ?? '', 'base64');
		assert.equal(png.readUInt32BE(16), 1024);
		assert.equal(png.readUInt32BE(20), 1024);
		assert.equal(
			createHash('sha256').update(png).digest('hex'),
			'ac1e504dddf53abecaeea3b4288cf04aa5a3bd4c394933b6f191425290598e5e',
		);
	});
});
