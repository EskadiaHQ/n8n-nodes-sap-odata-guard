import type { ODataGuardCredentials } from '../nodes/SapOdataGuard/types';

export const policyObject = {
	'/sap/opu/odata/sap/API_BUSINESS_PARTNER': {
		version: 'v2',
		allowMetadata: true,
		entities: {
			A_BusinessPartner: {
				operations: ['getMany'],
				fields: ['BusinessPartner', 'BusinessPartnerCategory', 'BusinessPartnerFullName'],
				keyFields: { BusinessPartner: 'string' },
				filterFields: {
					BusinessPartner: 'string',
					BusinessPartnerCategory: 'string',
				},
				orderByFields: ['BusinessPartner'],
				requiredFilters: [
					{ field: 'BusinessPartnerCategory', operator: 'eq', value: '2' },
				],
			},
		},
	},
};

export function credentials(
	overrides: Partial<ODataGuardCredentials> = {},
): ODataGuardCredentials {
	return {
		host: 'https://sap.example.com',
		authMode: 'basicAuth',
		username: 'reader',
		password: 'secret',
		servicePoliciesJson: JSON.stringify(policyObject),
		allowPrivateNetwork: false,
		allowInsecureHttp: false,
		rejectUnauthorized: true,
		allowAiTool: false,
		allowAiMetadata: false,
		maxRows: 1000,
		maxPages: 10,
		maxUrlLength: 8192,
		maxResponseBytes: 1048576,
		requestTimeout: 30000,
		aiToolMaxRows: 100,
		aiToolMaxBytes: 262144,
		...overrides,
	};
}
