import { automaticServicePolicyFromMetadata } from './catalog';
import { requestMetadata } from './client';
import { hasServicePolicies, normalizeServicePath, servicePolicyFor } from './governance';
import type {
	ODataGuardCredentials,
	ODataHttpRequest,
	ServicePolicies,
	ServicePolicy,
} from './types';

export async function resolveServicePolicy(
	credentials: ODataGuardCredentials,
	policies: ServicePolicies,
	servicePath: string,
	request: ODataHttpRequest,
	fresh = false,
): Promise<{
	service: ServicePolicy;
	metadata?: { xml: string; serializedBytes: number };
}> {
	if (hasServicePolicies(credentials)) return { service: servicePolicyFor(servicePath, policies) };
	const path = normalizeServicePath(servicePath);
	const metadata = await requestMetadata(request, credentials, path, fresh);
	const service = automaticServicePolicyFromMetadata(path, metadata.xml);
	credentials.resolvedServiceVersions = {
		...credentials.resolvedServiceVersions,
		[path]: service.version,
	};
	return { service, metadata };
}
