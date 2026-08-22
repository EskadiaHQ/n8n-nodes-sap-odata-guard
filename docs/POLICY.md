# Policy model

Logali SAP OData Guard separates **code capability** from **credential authorization**.

| Question | Answer |
|---|---|
| Must a new SAP service be programmed into the node? | No, if it uses the implemented V2/V4 CRUD contract. Add its exact path and policy to the credential. |
| Must a new entity set be programmed into the node? | No. Add the exact entity name, operations, fields, keys, filters, and sorting policy. |
| Can policy JSON enable create, update, or delete? | Yes, only for the exact entity and fields listed in `createFields` or `updateFields`; Delete requires an exact approved key. |
| Can policy JSON enable actions, batches, or triggers? | No. Those capabilities do not exist in version 0.2.0. |
| What happens when a service, entity, operation, or field is absent? | Execution fails before sending that data request. |
| Can a workflow replace a required row filter? | No. Required filters are generated from the credential and joined with `AND`. |
| Can server pagination drop a required filter? | No. Continuation links cannot change protected query parameters. |

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

Identifiers are exact and case-sensitive. Supported value types are `string`, `number`,
`boolean`, `date`, `datetime`, and `guid`.

An entity with `requiredFilters` cannot enable direct `get`, because a key URL cannot enforce
those filters. Use `getMany` with a key filter, or define a fully scoped composite key in a
separate policy.

## Write policy

`createFields` and `updateFields` are independent type maps. Allowing a field for reads does not
make it writable. `requiredCreateFields` enforces mandatory create inputs; null is accepted only
through `nullableCreateFields` or `nullableUpdateFields`.

Update and Delete require `If-Match`. The wildcard `*` is denied unless the entity policy sets
`allowWildcardIfMatch` to `true`. The node fetches a CSRF token and matching session cookie before
each mutation, and applies credential-level request-size and write-count limits.

Top-level field types `object` and `array` allow deep OData payloads. This is an explicit grant for
the entire nested value under that property, so the SAP communication user must still restrict
which related business objects can be changed.
