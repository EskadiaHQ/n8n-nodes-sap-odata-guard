# Policy model

Logali SAP OData Guard separates **code capability** from **credential authorization**.

| Question | Answer |
|---|---|
| Must a new SAP service be programmed into the node? | No, if it uses the implemented V2/V4 read contract. Add its exact path and policy to the credential. |
| Must a new entity set be programmed into the node? | No. Add the exact entity name, operations, fields, keys, filters, and sorting policy. |
| Can policy JSON enable create, update, delete, actions, batches, or triggers? | No. Those capabilities do not exist in version 0.1.0. |
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
