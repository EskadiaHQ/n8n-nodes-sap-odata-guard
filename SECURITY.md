# Security policy

## Status

Version `0.4.0-beta.1` is a candidate for non-production evaluation. Create, Update, and Delete are
implemented through OData only. Functions/actions, batch, and webhook operations are not
implemented and cannot be enabled through policy JSON.

## Security model

Logali SAP OData Guard uses two independent boundaries:

1. the SAP communication user or OAuth client must have least privilege in SAP;
2. the n8n credential must explicitly allow each service, entity, operation, field, filter field,
   sort field, and key field.

Missing policy means denied. The node also:

- requires HTTPS unless an isolated test credential explicitly enables HTTP;
- blocks cross-origin/cross-collection pagination and continuation links that alter protected query parameters;
- projects every returned record to the allowed field list even if the server ignores `$select`;
- applies required credential filters with `AND` outside caller-controlled filter logic;
- limits rows, pages, URL length, serialized response bytes, and request duration;
- validates create/update bodies against operation-specific field/type maps;
- fetches CSRF and session cookies without emitting either value;
- requires `If-Match` for update/delete and denies wildcard concurrency unless policy allows it;
- limits serialized write bytes and total mutations per execution;
- keeps AI Tool use disabled by default and requires separate opt-ins for metadata and writes;
- keeps service-catalog discovery disabled by default, bounded, same-origin, and unavailable to AI Tool nodes;
- redacts known credential secrets from request errors.

GET resilience is opt-in and bounded per input item; mutations are never automatically retried.
Discovery caching is separately opt-in, credential-isolated, worker-local, size/entry/TTL bounded,
and bypassed by connection tests. It stores only catalog/metadata responses, never entity data or
CSRF material. Known secrets are hashed into cache keys rather than stored as readable keys.
Forced refresh invalidates older in-flight discovery so it cannot repopulate a stale cache entry.
Errors expose selected bounded business details without full inner-error stacks or transport headers.
Typed conversion never infers numbers from strings and refuses unsafe integer input before HTTP.

## Reporting

Do not publish credentials, tokens, customer URLs, payloads, or exploit details in a public issue.
Use a private GitHub security advisory after publication or contact `admin@logaligroup.com`.
