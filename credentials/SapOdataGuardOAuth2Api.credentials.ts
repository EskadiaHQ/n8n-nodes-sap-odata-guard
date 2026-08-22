import type { ICredentialType, INodeProperties } from 'n8n-workflow';

import { commonCredentialProperties } from './properties';

export class SapOdataGuardOAuth2Api implements ICredentialType {
	name = 'sapOdataGuardOAuth2Api';
	extends = ['oAuth2Api'];
	displayName = 'Logali SAP OData Guard OAuth2 API';
	icon = 'file:sapOdataGuardCredential.svg' as const;
	documentationUrl =
		'https://github.com/EskadiaHQ/n8n-nodes-sap-odata-guard#authentication';
	properties: INodeProperties[] = [
		{
			displayName: 'Grant Type',
			name: 'grantType',
			type: 'hidden',
			default: 'clientCredentials',
		},
		...commonCredentialProperties,
	];
}
