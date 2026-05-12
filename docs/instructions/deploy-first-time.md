# First-Time Deploy — FD-451 Live Transfers

> Use this runbook the first time you deploy the live-transfer extension to a stage (dev or prod).
> For subsequent code-only deploys, see `deploy-update.md`.

## Stack inventory

This CDK app has four stacks across two stages:

```
dev/VendorLeadsDatabase   (dev-VendorLeadsDatabase)
dev/VendorLeadsMain       (dev-VendorLeadsMain)
prod/VendorLeadsDatabase  (prod-VendorLeadsDatabase)
prod/VendorLeadsMain      (prod-VendorLeadsMain)
```

To list them at any time:
```bash
npx cdk list --profile emc-sf-integrations-dev
```

---

## Step 1 — Pre-flight: log in via AWS SSO + confirm identity

This project uses AWS IAM Identity Center (SSO) for credentials. Each session starts with an `aws sso login`; the local credential cache expires after a few hours.

**One-time setup** (only if you've never configured an SSO profile on this machine):

```bash
aws configure sso
# Answer the prompts:
#   SSO session name:        bp-sso          (any name)
#   SSO start URL:           https://<your-org>.awsapps.com/start
#   SSO region:              us-west-2
#   SSO registration scopes: sso:account:access
# Browser opens for SSO login → pick the dev account + role → finish.
# Set "CLI default client Region", "CLI default output format" (json), and
#   "CLI profile name", e.g. "emc-sf-integrations-dev" for the dev account.
```

**Every session** — refresh SSO and verify your identity:

```bash
# Refresh SSO credentials (opens a browser tab):
aws sso login --profile emc-sf-integrations-dev

# Verify which account you're hitting — must match the dev account number:
aws sts get-caller-identity --profile emc-sf-integrations-dev

# Verify the profile's configured region — must be us-west-2:
aws configure get region --profile emc-sf-integrations-dev
```

This runbook uses `--profile emc-sf-integrations-dev` (and `--region us-west-2` where explicitly required) on every command. **Do not** rely on `export AWS_PROFILE=...` for this project — being explicit with `--profile` on each command prevents the "I forgot which shell I'm in" class of mistakes when switching between dev and prod, and avoids relying on shell state that doesn't survive across terminal tabs. For prod, swap in your prod SSO profile name on every flag.

> **CDK note:** `cdk` reads `--profile` directly and pulls the region from that profile's config. `bin/vendor-leads.ts` resolves the deploy region from the CDK context, so no `CDK_DEFAULT_REGION` export is needed when passing `--profile`.

> **If commands fail with `ExpiredToken` or `SSOTokenLoadError`**, your SSO session expired — re-run `aws sso login --profile emc-sf-integrations-dev`.

## Step 2 — Bootstrap CDK in this account+region (only once per account+region)

If this account/region has never been used with CDK, run:

```bash
ACCOUNT=$(aws sts get-caller-identity --profile emc-sf-integrations-dev --query Account --output text)
npx cdk bootstrap --profile emc-sf-integrations-dev aws://$ACCOUNT/us-west-2
```

If prod is already deployed in the same account+region, bootstrap is already done — skip.

## Step 3a — Confirm the Salesforce domain in `cdk.json`

The CDK reads the Salesforce domain per stage from `cdk.json` → `context.salesforceDomain.<stage>`. When your sandbox gets refreshed and renamed (e.g. `godspeed` → `r2d2`), update this value before deploying.

```bash
# Show the current dev domain CDK will deploy against:
node -e "console.log(require('./cdk.json').context.salesforceDomain.dev)"
```

Expected output: the full URL of your **current** dev sandbox, e.g.
`https://emortgage--r2d2.sandbox.my.salesforce.com`.

If it points at an old sandbox name, edit `cdk.json` → `context.salesforceDomain.dev` and re-run `cdk synth`. **Production domain (`emortgage.my.salesforce.com`) shouldn't change** between deploys.

## Step 3b — Create the Salesforce OAuth secret BEFORE the deploy

The CDK stack's EventBridge `Connection` (in `lib/vendor-leads-stack.ts:336-355`) requires a Secrets Manager secret at:

```
<stage>/salesforce/sf-lead-store-app-creds
```

…with a JSON value containing `client_id` and `client_secret`. The deploy will fail with `ResourceNotFoundException` from Secrets Manager if the secret doesn't exist.

**Get the credentials** from the Salesforce Connected App / External Client App in the target Salesforce org (sandbox `emortgage--godspeed` for dev, production org for prod). Setup → External Client Apps → your app → Settings → OAuth Settings → **Consumer Key** and **Consumer Secret**.

```bash
SF_CLIENT_ID="<consumer-key-from-SF>"
SF_CLIENT_SECRET="<consumer-secret-from-SF>"

aws secretsmanager create-secret \
  --name dev/salesforce/sf-lead-store-app-creds \
  --description "Salesforce Connected App client_credentials creds for vendor-leads (dev)" \
  --secret-string "{\"client_id\":\"$SF_CLIENT_ID\",\"client_secret\":\"$SF_CLIENT_SECRET\"}" \
  --region us-west-2 \
  --profile emc-sf-integrations-dev

# Verify the secret value has the exact two required keys:
aws secretsmanager get-secret-value \
  --secret-id dev/salesforce/sf-lead-store-app-creds \
  --region us-west-2 \
  --profile emc-sf-integrations-dev \
  --query 'SecretString' --output text | jq 'keys'
# Expected exactly: ["client_id","client_secret"]
```

For **prod**, swap stage in the name (`prod/salesforce/sf-lead-store-app-creds`) and swap the SSO profile.

**If you need to rotate later** (don't use `create-secret` again — that'll fail because the secret already exists):

```bash
aws secretsmanager put-secret-value \
  --secret-id dev/salesforce/sf-lead-store-app-creds \
  --secret-string "{\"client_id\":\"$SF_CLIENT_ID\",\"client_secret\":\"$SF_CLIENT_SECRET\"}" \
  --region us-west-2 \
  --profile emc-sf-integrations-dev
```

> Note on naming: Secrets Manager paths use **no leading slash** (`dev/salesforce/...`), unlike SSM Parameter Store which requires one (`/dev/vendor-leads/...`). Don't mix them up.

## Step 4 — Create per-vendor SSM parameters BEFORE the deploy

The new Lambda code reads from `/${stage}/vendor-leads/vendors/*`. If those don't exist when the deploy completes, requests to existing vendors will fail.

All commands below pin `--region us-west-2 --profile emc-sf-integrations-dev`. Swap both for prod.

```bash
# 4a. Inspect the old single-blob parameter so you can copy each vendor's leadIdProperty:
aws ssm get-parameter \
  --name /dev/vendor-leads/vendors-config \
  --region us-west-2 --profile emc-sf-integrations-dev \
  --query 'Parameter.Value' --output text | jq .

# 4b. Create one per-vendor parameter for each existing vendor.
# Substitute leadIdProperty values from the output above. Examples:

aws ssm put-parameter \
  --name "/dev/vendor-leads/vendors/lendingtree" \
  --type String \
  --value '{"leadTypes":{"internet":{"leadIdProperty":"Internal_LeadID"}}}' \
  --region us-west-2 --profile emc-sf-integrations-dev

aws ssm put-parameter \
  --name "/dev/vendor-leads/vendors/lendgo" \
  --type String \
  --value '{"leadTypes":{"internet":{"leadIdProperty":"universal_leadid"}}}' \
  --region us-west-2 --profile emc-sf-integrations-dev

aws ssm put-parameter \
  --name "/dev/vendor-leads/vendors/mortgageresearchcenter" \
  --type String \
  --value '{"leadTypes":{"internet":{"leadIdProperty":"<leadIdProperty>"}}}' \
  --region us-west-2 --profile emc-sf-integrations-dev

# 4c. Add the first live-transfer vendor:
aws ssm put-parameter \
  --name "/dev/vendor-leads/vendors/todays-best-mortgage-loans" \
  --type String \
  --value '{"leadTypes":{"live_transfer":{"leadIdProperty":"transferId"}}}' \
  --region us-west-2 --profile emc-sf-integrations-dev

# 4d. Verify all parameters exist:
aws ssm get-parameters-by-path \
  --path /dev/vendor-leads/vendors/ \
  --region us-west-2 --profile emc-sf-integrations-dev \
  --query 'Parameters[].Name' --output table
```

> **Do NOT delete `/dev/vendor-leads/vendors-config` yet** — keep the old blob as a rollback backstop until smoke tests pass.

## Step 5 — Synth + diff (read this carefully)

```bash
# Synth bundles all Lambdas. Idempotent.
npx cdk synth dev/VendorLeadsMain --profile emc-sf-integrations-dev > /dev/null

# Show CFN diff against what's currently deployed.
npx cdk diff "dev/*" --profile emc-sf-integrations-dev
```

Expected changes:
- **NEW**: `LiveTransferRouter` Lambda + log group + service role, `/v1/live-transfers` resource + POST method, `LiveTransferUpsertRule`, `SalesforceLiveTransfersAPIDest`.
- **CHANGED**: `VendorLeadsUpsertToSalesforce` rule pattern (`LeadsReceived` → `LeadsReceived.v1`) and target paths (`$.detail.leads` → `$.detail.data.leads`).
- **CHANGED**: `VendorLeadsPostRouterServiceRole` and `VendorLeadsDDBWriterServiceRole` IAM — was `ssm:GetParameter` on one ARN; now `ssm:GetParametersByPath` on wildcard.
- **CHANGED**: `VendorLeadsPostRouter` env — `SALESFORCE_EVENT_BUS_RULE_DETAIL_TYPE` removed (Lambda hardcodes `LeadsReceived.v1`).

If anything else changes, stop and investigate before proceeding.

## Step 6 — Deploy

```bash
npx cdk deploy "dev/*" --require-approval broadening --profile emc-sf-integrations-dev
```

> **First-time-failure gotcha:** if this is the very first deploy of `dev-VendorLeadsMain` and it fails, the stack ends in `ROLLBACK_COMPLETE` state. CFN refuses any update from that state — you must `delete-stack` first, then redeploy. See "Rollback plan" at the end of this doc.

Expect 3–5 minutes. CloudFormation applies the rule pattern change and the new Lambda code in one transaction.

## Step 7 — Smoke test

```bash
# Grab the API URL from CloudFormation outputs:
API_URL=$(aws cloudformation describe-stacks \
  --stack-name dev-VendorLeadsMain \
  --region us-west-2 --profile emc-sf-integrations-dev \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiEndpoint`].OutputValue' \
  --output text)
echo "API: $API_URL"

# --- A. Existing internet-lead path (regression check) ---
curl -i -X POST "${API_URL}leads?vendor=lendingtree" \
  -H 'Content-Type: application/json' \
  -d '{"Internal_LeadID":"smoke-internet-001","firstName":"Test","lastName":"Internet"}'

# --- B. New live-transfer path ---
curl -i -X POST "${API_URL}v1/live-transfers?vendor=todays-best-mortgage-loans" \
  -H 'Content-Type: application/json' \
  -d '{
    "transferId":"TBM-smoke-001",
    "transferredAt":"2026-05-12T12:00:00Z",
    "borrower":{"firstName":"Test","lastName":"User","phone":"5551234567","email":"t@e.com","state":"TX"},
    "loan":{"purpose":"Refinance","estimatedAmount":250000,"propertyType":"SFR"}
  }'

# --- C. Unknown vendor rejection ---
curl -i -X POST "${API_URL}v1/live-transfers?vendor=does-not-exist" \
  -H 'Content-Type: application/json' \
  -d '{"transferId":"x"}'
# Expect HTTP 400: "Vendor 'does-not-exist' is not configured for live transfers."

# --- D. Form-urlencoded body variant (verify parser parity) ---
curl -i -X POST "${API_URL}v1/live-transfers?vendor=todays-best-mortgage-loans" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'transferId=TBM-smoke-002&borrower.phone=5559999999'
```

## Step 8 — Tail logs while smoke-testing (separate terminal)

```bash
# Router for live transfers:
aws logs tail /aws/lambda/dev-live-transfer-router --follow --format short \
  --region us-west-2 --profile emc-sf-integrations-dev

# Existing internet router (regression):
aws logs tail /aws/lambda/dev-vendor-leads-post-router --follow --format short \
  --region us-west-2 --profile emc-sf-integrations-dev

# DDB writer (verifies LeadType attribute):
aws logs tail /aws/lambda/dev-vendor-leads-ddb-writer --follow --format short \
  --region us-west-2 --profile emc-sf-integrations-dev

# EventBridge logging rule output (confirms envelope shape on the bus):
aws logs tail /aws/events/dev-salesforce-event-bus --follow --format short \
  --region us-west-2 --profile emc-sf-integrations-dev
```

## Step 9 — Verify DynamoDB items have `LeadType`

```bash
aws dynamodb scan \
  --table-name dev-vendor-leads \
  --region us-west-2 --profile emc-sf-integrations-dev \
  --limit 5 \
  --projection-expression "LeadId,VendorName,LeadType,ReceivedAt"
```

New rows should show `LeadType: "internet"` or `LeadType: "live_transfer"`. Rows from before the deploy won't have it — that's expected.

## Step 10 — Watch the DLQ during/after smoke tests

```bash
DLQ_URL=$(aws sqs get-queue-url \
  --queue-name dev-vendor-leads-event-dlq \
  --region us-west-2 --profile emc-sf-integrations-dev \
  --query QueueUrl --output text)

aws sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --region us-west-2 --profile emc-sf-integrations-dev \
  --attribute-names ApproximateNumberOfMessages \
  --query Attributes.ApproximateNumberOfMessages --output text
# Expect "0". Anything else means Salesforce rejected events; pull and inspect.
```

## Step 11 — Trace a single request end-to-end (CloudWatch Logs Insights)

Replace `YOUR-CORRELATION-ID` with the `correlationId` returned in the smoke-test response:

```bash
aws logs start-query \
  --region us-west-2 --profile emc-sf-integrations-dev \
  --log-group-names \
    /aws/lambda/dev-vendor-leads-post-router \
    /aws/lambda/dev-live-transfer-router \
    /aws/lambda/dev-vendor-leads-ddb-writer \
    /aws/events/dev-salesforce-event-bus \
  --start-time $(($(date +%s) - 3600)) --end-time $(date +%s) \
  --query-string 'fields @timestamp, @log, @message | filter @message like /YOUR-CORRELATION-ID/ | sort @timestamp asc'

# Use the returned queryId:
# aws logs get-query-results --query-id <queryId> --region us-west-2 --profile emc-sf-integrations-dev
```

## Step 12 — After all smoke tests pass: delete the old single-blob SSM parameter

```bash
aws ssm delete-parameter \
  --name /dev/vendor-leads/vendors-config \
  --region us-west-2 --profile emc-sf-integrations-dev
```

---

## Rollback plan

| Symptom | Action |
|---|---|
| `ResourceNotFoundException` from `AWSSecretsManager` during deploy | The Salesforce OAuth secret is missing. Go to Step 3 and create `dev/salesforce/sf-lead-store-app-creds`. Then handle the failed-stack state (next row). |
| Stack stuck in `ROLLBACK_COMPLETE` after first-deploy failure | CFN refuses updates from this state. Run: `aws cloudformation delete-stack --stack-name dev-VendorLeadsMain --region us-west-2 --profile emc-sf-integrations-dev` then `aws cloudformation wait stack-delete-complete --stack-name dev-VendorLeadsMain --region us-west-2 --profile emc-sf-integrations-dev`, then redeploy. |
| CDK deploy fails (after a previously successful deploy) | CFN auto-rolls back to the last good state. Inspect events: `aws cloudformation describe-stack-events --stack-name dev-VendorLeadsMain --region us-west-2 --profile emc-sf-integrations-dev --max-items 50`. |
| Internet leads broken after deploy | `npx cdk deploy "dev/*" --rollback --profile emc-sf-integrations-dev` (rolls back to previous CFN template). The old `/dev/vendor-leads/vendors-config` blob is still in place as backup. |
| `/v1/live-transfers` returns "vendor not configured" | Check the SSM parameter exists and contains valid JSON: `aws ssm get-parameter --name /dev/vendor-leads/vendors/<name> --region us-west-2 --profile emc-sf-integrations-dev`. |
| Salesforce not receiving events | Check EventBridge logging rule output (`/aws/events/dev-salesforce-event-bus`) for the envelope shape, then check the DLQ for failed deliveries. |
| DLQ filling up | Inspect message bodies via SQS console or `aws sqs receive-message --region us-west-2 --profile emc-sf-integrations-dev`. Common causes: SF endpoint missing, OAuth credentials expired, payload shape rejected by Apex REST. |

---

## Post-deploy checklist

- [ ] `cdk.json` → `context.salesforceDomain.dev` points at the current dev sandbox
- [ ] Salesforce OAuth secret exists in Secrets Manager (`dev/salesforce/sf-lead-store-app-creds`) with valid `client_id` + `client_secret`
- [ ] All per-vendor SSM parameters exist under `/dev/vendor-leads/vendors/`
- [ ] Internet-lead smoke test returns HTTP 200
- [ ] Live-transfer smoke test returns HTTP 202
- [ ] Unknown-vendor smoke test returns HTTP 400
- [ ] DDB rows have `LeadType` attribute
- [ ] EventBridge logging rule shows envelope shape on the bus
- [ ] Salesforce sandbox shows new Leads from both endpoints
- [ ] DLQ depth = 0
- [ ] Old `/dev/vendor-leads/vendors-config` deleted
