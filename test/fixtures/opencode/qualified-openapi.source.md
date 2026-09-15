# Qualified OpenCode consumed contract

`qualified-openapi.json` is the normalized consumed projection of the official
OpenCode v1.18.30 OpenAPI document, not a recorded response from a local server.

- Source: https://raw.githubusercontent.com/anomalyco/opencode/v1.18.30/packages/sdk/openapi.json
- Tag commit: `3104c1428ec91f809e5ab86631300de41eb6952e`
- Original document SHA256: `00502bd13e9c86f3ca9e765e99a57e06fa9f434ca16f2a714766d1444f8d37f3`
- Consumed projection SHA256: `0126721f557bfb0fcbeed3567392416394921d0c5d38798392608ffd8f63e95d`

The production projection in `src/transports/opencode-admission.ts` selects nine
consumed HTTP operations and recursively follows their schema references. It
removes documentation annotations and canonicalizes unordered schema arrays.
The Event projection first requires every consumed union branch to exist.
Unconsumed API changes do not invalidate qualification. The independently sourced
SDK 1.18.25 document produces the same consumed projection.

Tests use this bounded subset instead of vendoring the entire unrelated API.
Production compares a fresh `/doc` response against the fixed policy digest;
it never manufactures a qualification digest from that response.
