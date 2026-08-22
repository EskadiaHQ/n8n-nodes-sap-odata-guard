import type { ICredentialType, INodeProperties } from 'n8n-workflow';

import { commonCredentialProperties } from './properties';

export class SapOdataGuardApi implements ICredentialType {
	name = 'sapOdataGuardApi';
	displayName = 'Logali SAP OData Guard API';
	icon = 'file:sapOdataGuardCredential-v022.svg' as const;
	documentationUrl =
		'https://github.com/EskadiaHQ/n8n-nodes-sap-odata-guard#credential-policy';
	properties: INodeProperties[] = [
		{
			displayName: 'Authentication',
			name: 'authMode',
			type: 'options',
			options: [
				{ name: 'Basic Auth', value: 'basicAuth' },
				{ name: 'None (Public Test Service)', value: 'none' },
			],
			default: 'basicAuth',
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: '',
			required: true,
			displayOptions: { show: { authMode: ['basicAuth'] } },
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			displayOptions: { show: { authMode: ['basicAuth'] } },
		},
		...commonCredentialProperties,
	];
}
