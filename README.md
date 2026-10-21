# Logali SAP OData Guard

Security-first n8n community node for discovering visible SAP services and governing reads and
writes through SAP OData V2 and V4.

> Status: candidate `0.4.0-beta.3` for controlled, non-production evaluation.

## Why Guard?

The node supports reusable OData mechanics and optional credential restrictions. Leave
**Service Policies JSON** empty to load the selected service's entities, fields, EDM types, keys,
and nullable fields automatically from live `$metadata`. SAP authorizes every data request using
the configured user or OAuth client. A service or entity needs no new TypeScript code when it fits
the implemented OData contract.

For a restricted credential, fill **Service Policies JSON** with the exact subset the workflow
may use. Existing policies remain authoritative and deny everything they do not list. Invalid
JSON, `{}`, and incomplete policies are errors; they never activate automatic mode.

With no policy, the credential dialog can check only the configured host: it does not know
which service the workflow will select. A root URL returning HTTP 404 counts as a reachable
host, with an explicit message that authentication and OData access have not been verified.
Use **Connection → Test Connection** in the node to test the selected service's metadata.
HTTP 401/403, server errors, DNS, TCP, and TLS failures still fail the credential check;
a 404 from a configured service's metadata also remains an error.

There are therefore two different limits:

- **Implemented capability**: version `0.4.0-beta.3` implements service-catalog discovery, connection
  checks, metadata, Get, Get Many, Create, Update, and Delete. Policy JSON cannot unlock actions,
  batches, or triggers.
- **Credential authorization**: a configured policy denies anything absent from it. An empty field
  uses the selected service's metadata and SAP user permissions instead of a handwritten allowlist.

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

## Resilience, precise types, and discovery cache

The 0.4 candidate adds explicit `int64`, `datetime-local`, `datetimeoffset`, `time`, and
`timeofday` policy types. Metadata templates distinguish these EDM types and include optional
`outputTypes`. Existing `datetime` policies retain their previous behavior. Pass large Int64 and
Decimal values as strings; unsafe integer numbers are rejected before HTTP. V4 JSON requests
negotiate `IEEE754Compatible=true`. Collection-valued primitives and inherited entity types are
excluded from scalar policy templates; incomplete composite keys never enable Get.

**Read Retry Attempts** defaults to zero. When enabled, only GET retries transient network
failures and HTTP 429/502/503/504, honoring `Retry-After` or bounded exponential backoff. POST,
PATCH, and DELETE are never automatically retried. **Minimum Request Interval (ms)** defaults to
zero. Dependent requests share a per-input-item elapsed budget (60 seconds when retry/pacing is
enabled) and a request-count limit (200 by default), including CSRF reads and pagination. These
are worker-local budgets, not a global SAP rate limiter.

**Allow Discovery Cache** defaults to false. The bounded in-memory cache holds only catalog and
metadata responses, never entity data or CSRF tokens. Cache keys include the n8n credential ID
and a SHA-256 fingerprint of its effective settings. TTL defaults to 60 seconds (maximum 300),
with 64 entries and 8 MiB per worker. Refresh Discovery bypasses and invalidates older work;
Connection and credential tests always make a fresh request. Restarts clear the cache.

**Normalize Date and Time Output** defaults to false. It converts only explicitly approved
top-level fields in `outputTypes`; numeric strings, IDs, untyped fields, and invalid server dates
remain unchanged. DateTimeOffset envelopes normalize to UTC; local DateTime has no timezone
suffix. V4 ISO strings are preserved. See [the policy guide](docs/POLICY.md) for examples.

SAP failures expose bounded `statusCode`, `sapCode`, business `details`, and an actionable `hint`
through Continue On Fail. Credential secrets, authorization headers, CSRF values, session cookies,
and full inner-error stacks are excluded. Write failures remain failures; a 403 alone never
triggers another mutation.

## Operations

- **Service Catalog → List Visible Services**: returns the OData V2 services visible to the SAP
  user and marks whether each one is already allowed by the credential policy.
- **Service Catalog → Generate Read-Only Policy Template**: loads live `$metadata` for one
  discovered service and produces a reviewable policy skeleton. It never edits the credential.
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

Entity, output, filter, sort, and write-field choices come from the configured policy, or automatically
from service metadata when the policy field is empty. Enter the service path as an ID/expression;
enabling catalog discovery also populates the service selector. Create and Update accept either a complete JSON object or the visual
field mapper; mapped values use JSON literals so their number, boolean, null, object, and array
types remain unambiguous.

Catalog discovery is a separate credential opt-in. It calls SAP Gateway
`/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection`, so the SAP user must be authorized for
that catalog service. When a policy is configured, seeing a service does not add it to the allowlist.
The generated template can be reviewed and merged into **Service Policies JSON** to restrict access.

## Credential policy

This field is optional. Empty, omitted, or whitespace-only values select automatic mode. In that
mode the node detects V2/V4 from metadata, uses the supported primitive fields and complete keys,
and honors SAP `creatable`, `updatable`, and `deletable` flags. Unknown scalar types, collections,
and unresolved inherited entity types are not inferred. Unsupported metadata causes an explicit
error rather than an unrestricted request. SAP remains responsible for business authorization and
required create inputs. Update/Delete still require an exact ETag; wildcard `If-Match` requires an
explicit policy. CSRF, TLS, URL checks, and request/row/byte limits apply in both modes.

Without a policy, the credential's connection test probes the configured Host only; its message
states that service access still needs testing. Run **Connection → Test Connection** in a node
with the exact service path to validate OData access. Runtime output reports `policyApplied: false`
in automatic mode and `true` when a configured policy was applied.

Example of optional restrictions:

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

Supported field types are `string`, `number`, `decimal`, `boolean`, `date`, `datetime`, and `guid`.
Supported filter operators are `eq`, `ne`, `gt`, `ge`, `lt`, `le`, `contains`, `startsWith`, and
`endsWith`. String values are escaped as OData literals; V2 and V4 function syntax is generated
separately.

Write fields are separate from read projection fields. `createFields` and `updateFields` define
the exact top-level properties and types accepted for each operation. Types `object` and `array`
explicitly permit a bounded nested JSON value for deep OData payloads; nested property names are
safety-checked, but the administrator remains responsible for limiting SAP authorizations for
those navigation writes. Null requires the corresponding nullable-field allowlist.

Declare SAP `Edm.Decimal` fields as `decimal`, not `number`. This lets the Guard apply the OData V2
JSON and URI literal rules without changing integer, single, or double values.

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

Service-catalog enumeration is never available to the AI Tool variant. AI opt-ins and caps apply
in both automatic and explicitly restricted modes.

## Development

```bash
npm install
npm test
npm run lint
npm run build
npm pack --dry-run
```

Use `npm run dev` only with non-production credentials and an isolated n8n user folder.
