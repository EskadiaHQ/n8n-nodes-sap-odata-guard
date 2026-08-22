# Logali SAP OData Guard

Security-first n8n community node for governed reads and writes through SAP OData V2 and V4.

> Status: prerelease `0.2.0` for controlled, non-production evaluation.

## Why Guard?

This node is not an unrestricted OData URL builder. Its runtime supports reusable OData mechanics,
while each credential defines the exact subset a workflow may use. A service or entity does not
need new TypeScript code when it already fits the implemented OData contract, but it must be added
to the credential policy before it becomes usable.

There are therefore two different limits:

- **Implemented capability**: version `0.2.0` implements connection checks, metadata, Get, Get
  Many, Create, Update, and Delete. Policy JSON cannot unlock actions, batches, or triggers.
- **Credential authorization**: within those implemented operations, anything absent from the policy is
  denied by default.

Programmatic node style is intentional: one execution can require policy validation, version-aware
filter construction, several dependent pagination requests, same-origin checks, response
projection, and cumulative limits. That flow cannot be represented safely as a single declarative
HTTP mapping.

## Authentication

- **Basic Auth / None** for SAP Gateway and explicitly public test services.
- **OAuth2 Client Credentials** through n8n's native OAuth2 credential and
  `httpRequestWithAuthentication` helper.

OAuth2 is implemented for reads and writes, but it still requires an authorized SAP/BTP communication
arrangement for a real end-to-end acceptance test.

Every modifying request first fetches a CSRF token from the approved service root and sends the
returned session cookie with the subsequent OData request. Tokens and cookies are never emitted as
node output.

## Operations

- **Connection → Test Connection**: fetches `$metadata` from one allowed service and confirms the
  policy, authentication, endpoint, and response limits.
- **Metadata → Get Metadata**: returns the bounded XML metadata for an allowed service.
- **Metadata → List Entity Sets**: extracts only entity sets present in both metadata and policy.
- **Entity → Get**: reads one entity using structured key JSON and policy-defined key types.
- **Entity → Get Many**: performs bounded reads with selected fields, structured filters, sorting,
  and V2/V4 pagination.
- **Entity → Create**: sends a policy-validated JSON entity with `POST`.
- **Entity → Update**: sends only policy-approved fields with `PATCH` and mandatory `If-Match`.
- **Entity → Delete**: sends `DELETE` to an exact structured key with mandatory `If-Match`.

## Credential policy

```json
{
  "/sap/opu/odata/sap/Z_APPROVED_SERVICE": {
    "version": "v2",
    "allowMetadata": false,
    "entities": {
      "ApprovedEntitySet": {
        "operations": ["get", "getMany", "create", "update", "delete"],
        "fields": ["ID", "Name", "Status"],
        "keyFields": { "ID": "string" },
        "filterFields": { "ID": "string", "Status": "string" },
        "orderByFields": ["ID"],
        "requiredFilters": [],
        "createFields": { "Name": "string", "Status": "string", "Details": "object" },
        "updateFields": { "Name": "string", "Status": "string" },
        "requiredCreateFields": ["Name"],
        "nullableCreateFields": [],
        "nullableUpdateFields": ["Status"],
        "allowWildcardIfMatch": false
      }
    }
  }
}
```

The service path and every identifier are exact and case-sensitive. Required filters are joined
with `AND` and cannot be replaced by caller filters. If `Fields` is empty, the node selects the
complete policy-approved projection, never `*`.

`Get`, `Update`, and `Delete` are rejected at policy-validation time when that entity also has
required row filters: a direct key URL cannot prove that the target row satisfies those filters.
Use `Get Many` with a key filter for scoped reads and a separate policy for writes.

Supported field types are `string`, `number`, `boolean`, `date`, `datetime`, and `guid`.
Supported filter operators are `eq`, `ne`, `gt`, `ge`, `lt`, `le`, `contains`, `startsWith`, and
`endsWith`. String values are escaped as OData literals; V2 and V4 function syntax is generated
separately.

Write fields are separate from read projection fields. `createFields` and `updateFields` define
the exact top-level properties and types accepted for each operation. Types `object` and `array`
explicitly permit a bounded nested JSON value for deep OData payloads; nested property names are
safety-checked, but the administrator remains responsible for limiting SAP authorizations for
those navigation writes. Null requires the corresponding nullable-field allowlist.

Update and Delete always require `If-Match`. An exact ETag is preferred. `*` is rejected unless
`allowWildcardIfMatch` is true for that exact entity. Credential limits also cap request bytes and
the number of mutations per node execution.

Private literal IPs require an explicit credential switch. DNS rebinding cannot be solved inside
an n8n node alone, so production installations must also restrict outbound network access at the
container, host, firewall, or proxy layer.

## AI Tool contract

The generated `sapOdataGuardTool` variant refuses to run unless **Allow AI Tool Use** is enabled in
the credential. Metadata additionally requires **Allow AI Metadata Discovery**, and Create,
Update, or Delete requires **Allow AI Write Operations**. Normal and tool executions remain
subject to the same service/entity/operation/field policies; the tool also receives its own row,
byte, and write-count caps.

## Development

```bash
npm install
npm test
npm run lint
npm run build
npm pack --dry-run
```

Use `npm run dev` only with non-production credentials and an isolated n8n user folder.
