# Policy model

Logali SAP OData Guard separates **code capability** from **credential authorization**.

| Question | Answer |
|---|---|
| Must a new SAP service be programmed into the node? | No, if it uses the implemented V2/V4 CRUD contract. Add its exact path and policy to the credential. |
| Must a new entity set be programmed into the node? | No. Add the exact entity name, operations, fields, keys, filters, and sorting policy. |
| Can policy JSON enable create, update, or delete? | Yes, only for the exact entity and fields listed in `createFields` or `updateFields`; Delete requires an exact approved key. |
| Can policy JSON enable actions, batches, or triggers? | No. Those capabilities do not exist in version 0.4.0-beta.1. |
| What happens when a service, entity, operation, or field is absent? | Execution fails before sending that data request. |
| Can a workflow replace a required row filter? | No. Required filters are generated from the credential and joined with `AND`. |
| Can server pagination drop a required filter? | No. Continuation links cannot change protected query parameters. |
| Does catalog discovery grant access to a service? | No. It only shows services visible to the SAP user and can generate a reviewable read-only policy template. |

## Catalog discovery and authorization

Catalog discovery has its own credential switch and result limit. It queries SAP Gateway
`CATALOGSERVICE`, marks services already present in the credential policy, and can derive a
read-only template from live metadata. The template is not applied automatically.

To authorize a discovered service, an administrator must:

1. grant the SAP user runtime access to the activated OData service and its business data;
2. review the generated template and remove every entity, field, filter, and sort option the
   workflow does not need;
3. merge the approved service object into **Service Policies JSON**;
4. test the exact credential with a bounded read before enabling a workflow.

## Minimal policy

```json
{
  "/sap/opu/odata/sap/Z_APPROVED_SERVICE": {
    "version": "v2",
    "allowMetadata": false,
    "entities": {
      "ApprovedEntitySet": {
        "operations": ["getMany"],
        "fields": ["ID", "Status"],
        "keyFields": { "ID": "string" },
        "filterFields": { "ID": "string", "Status": "string" },
        "orderByFields": ["ID"],
        "requiredFilters": [
          { "field": "Status", "operator": "eq", "value": "ACTIVE" }
        ]
      }
    }
  }
}
```

Identifiers are exact and case-sensitive. Supported scalar types are `string`, `number`, `decimal`,
`int64`, `boolean`, `date`, `datetime`, `datetime-local`, `datetimeoffset`, `time`, `timeofday`,
and `guid`. Keep SAP numeric identifiers declared as `string` when that is their EDM type.

An entity with `requiredFilters` cannot enable direct `get`, because a key URL cannot enforce
those filters. Use `getMany` with a key filter, or define a fully scoped composite key in a
separate policy.

## Write policy

`createFields` and `updateFields` are independent type maps. Allowing a field for reads does not
make it writable. `requiredCreateFields` enforces mandatory create inputs; null is accepted only
through `nullableCreateFields` or `nullableUpdateFields`.

Use `decimal` for SAP `Edm.Decimal` properties. On OData V2 the Guard serializes those write values
as JSON strings and emits the required `M` suffix in filters and keys. Use `number` for integer,
Int16/Int32, single, and double properties; use `int64` for Edm.Int64. An Int64 outside JavaScript's
safe integer range must be a decimal string. Both signed 64-bit boundaries are enforced, V2 query
literals receive `L`, and JSON writes remain strings. Decimal strings preserve precision and scale;
unsafe integer numbers are refused even under a decimal policy. V4 negotiates the
`IEEE754Compatible=true` JSON media-type parameter for reads and writes.

Update and Delete require `If-Match`. The wildcard `*` is denied unless the entity policy sets
`allowWildcardIfMatch` to `true`. The node fetches a CSRF token and matching session cookie before
each mutation, and applies credential-level request-size and write-count limits.

Top-level field types `object` and `array` allow deep OData payloads. This is an explicit grant for
the entire nested value under that property, so the SAP communication user must still restrict
which related business objects can be changed.

## Explicit dates and time

| EDM / policy type | Input | V2 filter/key | V2 JSON write | V4 |
|---|---|---|---|---|
| DateTime / `datetime-local` | `2026-10-04T14:30:00` | `datetime'2026-10-04T14:30:00'` | `/Date(…)/` with wall-clock ticks | Denied; V4 has no DateTime |
| DateTimeOffset / `datetimeoffset` | `2026-10-04T14:30:00+02:00` | `datetimeoffset'…'` | SAP `/Date(…+0000)/`, UTC instant | Original ISO string |
| Time / `time` | `PT14H30M00.5S` | `time'PT14H30M00.5S'` | Canonical duration | Clock string |
| TimeOfDay / `timeofday` | `14:30:00.5` | `time'PT14H30M00.5S'` | Canonical duration | Clock string |

The explicit local type refuses timezone suffixes; DateTimeOffset requires one. Impossible calendar
dates, invalid clocks, and offsets beyond 14 hours are refused. Fractions support up to seven digits;
V2 date writes reject nonzero sub-millisecond precision rather than truncating it. Existing `datetime`
policies retain their historical timestamp behavior; migrate them deliberately using the real metadata.

For optional output normalization, add a map alongside the approved read fields:

```json
{
  "operations": ["getMany"],
  "fields": ["ID", "CreatedAt", "LocalDate", "OpeningTime"],
  "outputTypes": {
    "ID": "string",
    "CreatedAt": "datetimeoffset",
    "LocalDate": "date",
    "OpeningTime": "time"
  }
}
```

Enable **Normalize Date and Time Output** in the node. Only those projected fields are considered:
negative ticks are supported, DateTimeOffset becomes UTC ISO, local datetime loses the trailing `Z`,
and a date becomes `YYYY-MM-DD`. The legacy envelope offset is not used to shift the ticks. Conversion
is shallow and preserves nulls, IDs, decimal/Int64 strings, untyped fields, and invalid dates. Disable
normalization to retain the original SAP payload values.

Templates remain reviewable suggestions. They do not resolve entity inheritance or collections,
interpret every annotation, or infer business authorization from metadata.

## Operational bounds

| Credential setting | Default | Allowed range |
|---|---:|---:|
| Read Retry Attempts | 0 | 0–3 |
| Maximum HTTP Elapsed Time (ms) | 60000 | 1000–300000 |
| Minimum Request Interval (ms) | 0 | 0–10000 |
| Maximum HTTP Requests per Item | 200 | 2–1000 |
| Allow Discovery Cache | false | boolean |
| Discovery Cache TTL (seconds) | 60 | 1–300 |

Elapsed time is enforced when retries or pacing are enabled; the existing per-request timeout always
applies. Request-count bounds include attempts and CSRF reads. Budgets reset for each input item.
They do not coordinate concurrent executions or multiple workers. A requested retry delay exceeding
the remaining budget ends the read; it is never shortened to send sooner than `Retry-After`.

Discovery caching is isolated by credential identity and all effective settings, limited to metadata
and service catalog, and disabled when credential identity is missing. **Refresh Discovery** bypasses
and invalidates the cached result without warming it. Connection tests bypass the cache regardless
of node settings. Credential revocation in SAP may therefore remain invisible to cached discovery
until TTL or forced refresh; entity reads and writes always contact SAP.

Protocol references: [OData V2 JSON](https://www.odata.org/documentation/odata-version-2-0/json-format/),
[SAP Gateway dates and time zones](https://help.sap.com/docs/ABAP_PLATFORM_NEW/468a97775123488ab3345a0c48cadd8f/6c9e61dc157a40c19460660ece8368bc.html),
[OASIS OData JSON V4.01](https://docs.oasis-open.org/odata/odata-json-format/v4.01/cs01/odata-json-format-v4.01-cs01.html).
