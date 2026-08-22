# Logali SAP OData Guard

Security-first n8n community node for governed reads from SAP OData V2 and V4 services.

> Status: prerelease `0.1.1` for controlled, non-production evaluation.

## Why Guard?

This node is not an unrestricted OData URL builder. Its runtime supports reusable OData mechanics,
while each credential defines the exact subset a workflow may use. A service or entity does not
need new TypeScript code when it already fits the implemented read contract, but it must be added
to the credential policy before it becomes usable.

There are therefore two different limits:

- **Implemented capability**: the `0.1.x` line implements connection checks, metadata, Get, and Get
  Many. Policy JSON cannot unlock writes, actions, batches, or triggers that do not exist in code.
- **Credential authorization**: within those implemented reads, anything absent from the policy is
  denied by default.

Programmatic node style is intentional: one execution can require policy validation, version-aware
filter construction, several dependent pagination requests, same-origin checks, response
projection, and cumulative limits. That flow cannot be represented safely as a single declarative
HTTP mapping.

## Authentication

- **Basic Auth / None** for SAP Gateway and explicitly public test services.
- **OAuth2 Client Credentials** through n8n's native OAuth2 credential and
  `httpRequestWithAuthentication` helper.

OAuth2 is implemented for reads, but it still requires an authorized SAP/BTP communication
arrangement for a real end-to-end acceptance test.

## Operations

- **Connection → Test Connection**: fetches `$metadata` from one allowed service and confirms the
  policy, authentication, endpoint, and response limits.
- **Metadata → Get Metadata**: returns the bounded XML metadata for an allowed service.
- **Metadata → List Entity Sets**: extracts only entity sets present in both metadata and policy.
- **Entity → Get**: reads one entity using structured key JSON and policy-defined key types.
- **Entity → Get Many**: performs bounded reads with selected fields, structured filters, sorting,
  and V2/V4 pagination.

No write operation is present in the `0.1.x` line.

## Credential policy

```json
{
  "/sap/opu/odata/sap/API_BUSINESS_PARTNER": {
    "version": "v2",
    "allowMetadata": true,
    "entities": {
      "A_BusinessPartner": {
        "operations": ["getMany"],
        "fields": [
          "BusinessPartner",
          "BusinessPartnerCategory",
          "BusinessPartnerFullName"
        ],
        "keyFields": {
          "BusinessPartner": "string"
        },
        "filterFields": {
          "BusinessPartner": "string",
          "BusinessPartnerCategory": "string"
        },
        "orderByFields": ["BusinessPartner"],
        "requiredFilters": [
          {
            "field": "BusinessPartnerCategory",
            "operator": "eq",
            "value": "2"
          }
        ]
      }
    }
  }
}
```

The service path and every identifier are exact and case-sensitive. Required filters are joined
with `AND` and cannot be replaced by caller filters. If `Fields` is empty, the node selects the
complete policy-approved projection, never `*`.

`Get` is rejected at policy-validation time when that entity also has required row filters: a
direct key URL cannot prove that the returned row satisfies those filters. Use `Get Many` with a
key filter for that policy, or encode the complete scope in an approved composite key.

Supported field types are `string`, `number`, `boolean`, `date`, `datetime`, and `guid`.
Supported filter operators are `eq`, `ne`, `gt`, `ge`, `lt`, `le`, `contains`, `startsWith`, and
`endsWith`. String values are escaped as OData literals; V2 and V4 function syntax is generated
separately.

Private literal IPs require an explicit credential switch. DNS rebinding cannot be solved inside
an n8n node alone, so production installations must also restrict outbound network access at the
container, host, firewall, or proxy layer.

## AI Tool contract

The generated `sapOdataGuardTool` variant refuses to run unless **Allow AI Tool Use** is enabled in
the credential. Metadata additionally requires **Allow AI Metadata Discovery**. Normal and tool
executions remain subject to the same service/entity/field policies; the tool also receives its
own row and byte caps.

## Development

```bash
npm install
npm test
npm run lint
npm run build
npm pack --dry-run
```

Use `npm run dev` only with non-production credentials and an isolated n8n user folder.
