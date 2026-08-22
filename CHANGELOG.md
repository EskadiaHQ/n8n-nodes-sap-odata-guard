# Changelog

All notable changes to this project are documented here.

## [0.2.1] - 2026-08-22

### Changed

- Replaced the generic shield with the branded Logali Guard family artwork and a legible OData `OD` badge.
- Aligned the node and credential icons so OData Guard is recognizable in the selector, canvas, and credential screens.

## [0.2.0] - 2026-08-22

### Added

- Governed OData Create (`POST`), Update (`PATCH`), and Delete operations.
- Operation-specific create/update field and type maps, required/nullable fields, and bounded nested payloads.
- SAP CSRF token retrieval with matching session-cookie propagation.
- Mandatory `If-Match` concurrency control with policy-owned wildcard permission.
- Credential and AI-specific write-count limits plus write-request byte limits.
- ETag extraction from Get and mutation responses.

## [0.1.1] - 2026-08-22

### Fixed

- Accept normal read credentials when n8n omits the hidden AI Tool row and byte limits.
- Continue to require both limits whenever AI Tool use is explicitly enabled.

## [0.1.0] - 2026-08-22

### Added

- Deny-by-default SAP OData V2 and V4 read node.
- Basic, anonymous, and OAuth2 Client Credentials authentication paths.
- Exact service, entity, operation, key, field, filter, and sorting policies.
- Credential-required filters that callers and AI agents cannot remove.
- Pagination locked to the same origin, entity collection, projection, filters, sorting, and page size.
- Credential-level row, page, URL, response-byte, and timeout limits.
- Separate opt-ins for AI Tool use and AI metadata access.
- Connection, metadata, Get, and Get Many operations.
