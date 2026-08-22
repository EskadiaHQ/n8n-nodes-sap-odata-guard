# Roadmap and acceptance gates

## Implemented in 0.1.x

- Read-only SAP OData V2/V4 node for Connection, Metadata, Get and Get Many.
- Basic, anonymous test-service and OAuth2 client-credentials authentication.
- Credential-owned deny-by-default service/entity/operation/field policy.
- Structured keys, filters, projections and sorting without raw-query escape hatches.
- Required filters and bounded rows, pages, URL length, response bytes and timeouts.
- Same-origin, same-collection and protected-query pagination validation.
- Separate opt-in and tighter bounds for AI Tool use.
- Unit, lint, build, package and runtime-load checks.

## Required before stable release

- Complete acceptance against each SAP OData version and n8n version claimed as supported.
- Add controlled OAuth2 acceptance against an SAP/BTP identity provider.
- Exercise server-driven V2 and V4 pagination with real continuation links.
- Perform dependency, threat-model, secret-handling and recovery reviews.
- Document a least-privilege SAP communication user and network-egress profile.
- Repeat the exact-version/package acceptance for every future supported n8n release.

Create, update, delete, actions/functions, `$batch`, delta subscriptions and webhook
triggers are intentionally not implemented in the read-only 0.1.x line.
