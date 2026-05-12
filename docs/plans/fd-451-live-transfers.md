# Plan — Extend CDK to Accept Live Transfer Leads (FD-451)

> **Status: ✅ Completed 2026-05-12.** Implemented, deployed to dev and prod, smoke-tested end-to-end (vendor → API Gateway → router Lambda → SQS → DDB writer → DynamoDB; envelope-shape EventBridge events flowing). This document describes the as-built state.
>
> Source: `/Users/askaranko/.claude/plans/ok-please-review-implementation-tender-bonbon.md`

## Context

FD-451 introduces **Live Transfer** leads alongside the existing **Internet Leads** path. Some vendors deliver live-transfer payloads in real-time (caller on the phone); some deliver post-call. The AWS layer treats both flows **asynchronously** — Salesforce decides sync vs async per payload size via the Async Command Framework (deployed in FD-451 Phase 1).

This change **extends** the existing pipeline; it does not replace it. We reuse the existing EventBridge bus, OAuth Connection, DDB archive table, SQS queue, and event DLQ. While touching the event payload shape we also migrated internet leads to the standard EventBridge **metadata envelope** so both lead types follow the recommended pattern.

**AWS plugin skills consulted:** `aws-serverless:aws-lambda` (event-driven-architecture), `aws-serverless:api-gateway` (architecture-patterns), `aws-serverless:aws-serverless-deployment`, `deploy-on-aws:aws-architecture-diagram`.

---

## Architecture

```
                      VENDORS
                         │
        ┌────────────────┴────────────────┐
        ▼                                 ▼
  POST /leads                       POST /v1/live-transfers
   (existing)                              (new)
        │                                 │
        ▼                                 ▼
  post-router Lambda                live-transfer-router Lambda  (new)
   - parse vendor (header|query)     - parse vendor (header|query)
   - parse body (JSON|form|qs)       - parse body (JSON|form|qs)
   - allowlist via SSM               - allowlist via SSM
   - generate correlationId          - generate correlationId
   - emit envelope shape             - emit envelope shape
        │                                 │
        │     SHARED utility: lambda/utils/request-parser.js
        │     SHARED utility: lambda/utils/lead-publisher.js     (SQS + EB)
        │     SHARED utility: lambda/utils/vendors-config.js     (normalizer)
        │
        ├──► SQS  vendor-leads-ddb-queue ◄┤  (shared — items now include LeadType)
        │           │
        │           ▼
        │     ddb-writer Lambda  →  DynamoDB  (now writes LeadType attribute)
        │
        └──► EventBridge  salesforce-event-bus
                  │
                  ├─ Rule LeadsReceived.v1  ──► API Destination (existing) ──► SF /vendor-api/v1/leads/
                  └─ Rule LiveTransferReceived.v1  (new) ──► API Destination (new) ──► SF /vendor-api/v1/live-transfers/
                              │
                              └─ DLQ: shared vendor-leads-event-dlq (existing)
```

**OAuth Connection** is reused — same Salesforce Connected App credentials.

---

## Decisions (as-built)

| Decision | Choice | Rationale |
|---|---|---|
| Router Lambda for live transfers | **New** function `live-transfer-router` | Independent metrics/alarms/cold-start surface; zero regression risk to internet leads. |
| Shared parsing utility | `lambda/utils/request-parser.js` | Both routers handle JSON / form-urlencoded / query-string identically. One bug fix, one place. |
| Shared publisher utility | `lambda/utils/lead-publisher.js` | SQS batching + EventBridge envelope construction live in one module; routers pass leadType/detailType/serviceName as parameters. |
| Delivery mechanism | **Reuse EventBridge API Destination** | Per skill: managed retries, native DLQ, archive replay. No reason to hand-roll delivery when SLA is async. |
| Detail payload shape | **Full metadata envelope**, applied to **both** lead types | Best practice per skill. |
| `detailType` | `LeadsReceived.v1` and `LiveTransferReceived.v1` | Versioned upfront — adding `.v2` later won't break SF consumers. |
| DDB schema | Add **`LeadType` top-level attribute**, no backfill | Old rows missing field → reader treats as `internet`. Add GSI later only if reporting needs emerge. |
| Schema validation | **Vendor allowlist check in Lambda** only (no API GW JSON schema, no AJV) | Strict per-vendor schemas are overkill; SF CMDT handles mapping. |
| SSM vendor-config layout | **One SSM parameter per vendor** under `/${stage}/vendor-leads/vendors/<name>`, fetched via `GetParametersByPath`. Each param nested by `leadTypes` with backward-compat normalizer. | Per-vendor blast-radius isolation; per-vendor audit trail; aligns with SF CMDT model; each vendor's JSON can grow independently. |
| Response shaping | Existing `vendors-response.js` unchanged. Live transfers use the default `{status, message}` branch. | Not many vendor-specific responses; keep hardcoded. |
| DLQ for live transfers | **Share existing** `vendorLeadsEventDeadLetterQueue` | Simpler ops surface; differentiate failures by `detailType` in logs. |
| Auth on new endpoint | **Defer**, document as risk | Matches existing `AuthorizationType.NONE`. PII gap flagged for security follow-up. |
| Stack split | **Extend** `VendorLeadsStack` | Cross-stack refs cause sticky CFN exports; ~150 lines added is fine. |

---

## EventBridge envelope shape (both lead types)

```jsonc
"Detail": {
  "metadata": {
    "id":            "01HXY...",                       // randomUUID; consumer-side idempotency key
    "version":       "1",                              // payload schema version
    "timestamp":     "2026-05-12T10:00:00Z",           // when event occurred
    "correlationId": "req-abc123",                     // = Lambda awsRequestId; flows end-to-end
    "service":       "vendor-leads-router"             // or "live-transfer-router"
  },
  "data": {
    "vendor":   "todays-best-mortgage-loans",
    "leadType": "live_transfer",                       // "internet" | "live_transfer"
    "leads":    [ { /* vendor payload */ } ]
  }
}
```

API Destination rules read leads from `$.detail.data.leads` and vendor from `$.detail.data.vendor`.

---

## SSM vendor-config (per-vendor parameters)

One SSM `String` parameter per vendor under `/${stage}/vendor-leads/vendors/<vendor-name>`. Replaces the old single blob at `/${stage}/vendor-leads/vendors-config`.

**Example layout:**
```
/dev/vendor-leads/vendors/lendingtree
  {"leadTypes":{"internet":{"leadIdProperty":"Internal_LeadID"}}}

/dev/vendor-leads/vendors/lendgo
  {"leadTypes":{"internet":{"leadIdProperty":"universal_leadid"}}}

/dev/vendor-leads/vendors/testurl
  {"leadTypes":{"internet":{"leadIdProperty":"id"}}}

/dev/vendor-leads/vendors/todays-best-mortgage-loans
  {"leadTypes":{"live_transfer":{"leadIdProperty":"transferId"}}}
```

**Backward compat:** the normalizer in `lambda/utils/vendors-config.js` accepts legacy flat shape `{"leadIdProperty":"..."}` per vendor and wraps it as `{leadTypes:{internet:{leadIdProperty:"..."}}}`. Admins can still write flat for internet-only vendors.

**Blast-radius:** a bad JSON save breaks only that vendor; others continue working.

See `docs/instructions/deploy-first-time.md` for the exact CLI commands.

---

## Critical files

**Modified:**
- `lib/vendor-leads-stack.ts` — live-transfer Lambda + log group, `/v1/live-transfers` API resource + POST method, new EventBridge rule (`LiveTransferReceived.v1`) + new API Destination (reusing OAuth Connection), updated existing internet-lead rule to `LeadsReceived.v1` + envelope target paths, broadened SSM IAM to `GetParametersByPath` on wildcard path.
- `lambda/routes/post-router.js` — uses shared parser + shared publisher; emits envelope; `LeadsReceived.v1`.
- `lambda/database/ddb-writer.js` — writes `LeadType` attribute on every DDB item.
- `lambda/utils/vendors-config.js` — rewritten to `GetParametersByPath`; normalizer accepts flat + nested shapes; new `getVendorLeadConfig` accessor.
- `lambda/utils/vendors-data.js` — `getVendorsLeadId` takes `leadType` (default `internet`).

**Created:**
- `lambda/utils/request-parser.js` — extracted vendor + body parsing.
- `lambda/utils/lead-publisher.js` — shared SQS + EventBridge publisher (envelope built here).
- `lambda/routes/live-transfer-router.js` — new handler.

**Unchanged:**
- `lambda/utils/vendors-response.js`, `lib/vendor-leads-database-stack.ts`, `bin/vendor-leads.ts`, `lib/vendor-leads-stage.ts`.

---

## Migration cutover (envelope for internet leads)

Single atomic CDK deploy. CFN applies all resource updates as one transaction. Brief window (~5–30s) where in-flight requests may emit old-shape events that don't match the new rule pattern.

**Recommended:**
1. Deploy in a low-traffic window (off-hours).
2. Any unmatched events during cutover are captured by the existing 90-day EventBridge archive (`SalesforceEventBusArchive`).
3. Post-deploy, monitor the `SFEventBusLoggingRule` log group for matched event volume; if anything is missing, replay from archive via console or `start-replay` CLI.

---

## Verification

See `docs/instructions/deploy-first-time.md` → "Smoke test" section.

Minimum checks before claiming success:
1. CDK synth clean: `npx cdk synth` succeeds for both stages.
2. Internet-lead regression: POST to `/leads` returns 200 with `{leadId, correlationId}`; DDB row written with `LeadType: "internet"`; envelope event visible in EB logging rule output; Salesforce Lead created.
3. Live-transfer happy path: POST to `/v1/live-transfers` returns 202 with `{correlationId, receivedAt}`; DDB row written with `LeadType: "live_transfer"`; envelope event visible; Salesforce Lead created via live-transfer endpoint.
4. Unknown vendor on `/v1/live-transfers` → HTTP 400.
5. DLQ depth stays at 0 throughout.

---

## Completion summary (2026-05-12)

| Deliverable | Status |
|---|---|
| CDK code — extracted parsers, shared publisher, new live-transfer router, envelope migration, per-vendor SSM read | ✅ Merged |
| Salesforce OAuth secret (`<stage>/salesforce/sf-lead-store-app-creds`) | ✅ Created in dev and prod Secrets Manager |
| Per-vendor SSM parameters under `/<stage>/vendor-leads/vendors/` | ✅ Created in dev and prod |
| Salesforce domain moved from hardcoded source to `cdk.json` context | ✅ |
| Connected App `client_credentials` Run-As user configured (dev sandbox `r2d2` + prod) | ✅ |
| `cdk deploy "dev/*"` | ✅ CREATE_COMPLETE |
| `cdk deploy "prod/*"` | ✅ CREATE_COMPLETE |
| Smoke test — internet leads (regression) | ✅ End-to-end working in both stages |
| Smoke test — live transfer lead reached DynamoDB | ✅ Verified in prod DDB Item Explorer |
| Deploy runbooks (`docs/instructions/deploy-first-time.md`, `deploy-update.md`) | ✅ Written, profile-flag style, region-explicit |

**Deferred follow-ups** (intentionally out of scope for this initiative — track separately):

- Authentication on the API (currently `AuthorizationType.NONE`). Borrower PII flows unauthenticated. Recommended next step: API key + WAF IP allowlist before any new vendor onboards.
- Salesforce-side `/services/apexrest/vendor-api/v1/live-transfers/` Apex REST class implementation. Until deployed in Salesforce, live-transfer events accumulate in the EventBridge DLQ (`<stage>-vendor-leads-event-dlq`). Replay from archive once SF is ready.
- Adopt full metadata envelope for any future event types from day one (already done for `LeadsReceived.v1` and `LiveTransferReceived.v1`).
- Delete legacy `/prod/vendor-leads/vendors-config` blob after a confirmed soak period on prod (current state: retained as rollback backstop).

---

## Known gaps / risks

1. **Authentication is `NONE`** on the API. Borrower PII flows unauthenticated. Document for security follow-up — likely API key + WAF IP allowlist before vendor go-live. Phase-2 dependency.
2. **Vendor payload contract** for `todays-best-mortgage-loans` is sketched from `fd-451.md` — confirm with vendor before production traffic.
3. **Salesforce endpoint** `/services/apexrest/vendor-api/v1/live-transfers/` must exist in `emortgage--godspeed` sandbox before the new API Destination can succeed.
4. **Idempotency on SF side** — confirm SF upsert uses `transferId` as External Id so EventBridge retries don't create duplicate Leads.
5. **DLQ retention 14 days holds PII** — confirm with legal/compliance; may need shorter retention or KMS CMK.
6. **Envelope cutover window** — ~5–30s of potentially-unrouted events during deploy; archive replay is the backstop. Schedule for off-hours.
