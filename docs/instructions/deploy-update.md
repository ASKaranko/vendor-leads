# Update Deploy

> Use this runbook for any subsequent deploy after the initial FD-451 deploy.
> For the first-time deploy of FD-451, use `deploy-first-time.md`.

This covers the common case: code or CDK changes you want to ship to an already-bootstrapped stage. No SSM bootstrap, no cutover work.

All commands pin `--region us-west-2 --profile emc-sf-integrations-dev` for dev. Swap both for prod.

---

## Step 1 — Pre-flight: log in via AWS SSO + confirm identity

```bash
# Refresh SSO credentials (opens a browser):
aws sso login --profile emc-sf-integrations-dev

# Verify the account number matches the stage you intend to deploy to:
aws sts get-caller-identity --profile emc-sf-integrations-dev

# Verify the profile is configured for us-west-2:
aws configure get region --profile emc-sf-integrations-dev
```

> If a command later fails with `ExpiredToken` or `SSOTokenLoadError`, your SSO session expired — re-run `aws sso login --profile emc-sf-integrations-dev`.
>
> First time on this machine? Run `aws configure sso` once to register your SSO profile — see `deploy-first-time.md` Step 1 for the prompts.

## Step 2 — Pull latest, install deps if needed

```bash
git pull
npm install   # only if package.json or package-lock.json changed
```

## Step 3 — Synth + diff (always read the diff before deploying)

```bash
# Bundle Lambdas + render CloudFormation
npx cdk synth dev/VendorLeadsMain --profile emc-sf-integrations-dev > /dev/null

# CFN diff against the deployed stack
npx cdk diff "dev/*" --profile emc-sf-integrations-dev
```

**Pause here.** Check that:
- Resources you intended to change appear in the diff.
- No surprise IAM widening, no resource replacements (look for `[~]` vs `[-/+]` markers — the latter means delete+recreate).
- No deletions of resources you still need (Lambdas, queues, rules).

If the diff has anything unexpected, stop and investigate.

## Step 4 — Deploy

Pick one approach based on scope of change:

```bash
# A. Deploy everything in the stage (most common):
npx cdk deploy "dev/*" --require-approval broadening --profile emc-sf-integrations-dev

# B. Deploy ONLY the main stack (faster when database stack is unchanged):
npx cdk deploy dev/VendorLeadsMain --require-approval broadening --profile emc-sf-integrations-dev

# C. Deploy with hotswap (Lambda code only — skips CFN, ~10× faster, dev only!):
npx cdk deploy dev/VendorLeadsMain --hotswap-fallback --profile emc-sf-integrations-dev
```

> **Never use `--hotswap` in prod.** It bypasses CloudFormation and leaves drift; use only in dev for fast iteration on Lambda code.

## Step 5 — Smoke test

Get the API URL and run the same calls you used at first deploy:

```bash
API_URL=$(aws cloudformation describe-stacks \
  --stack-name dev-VendorLeadsMain \
  --region us-west-2 --profile emc-sf-integrations-dev \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiEndpoint`].OutputValue' \
  --output text)

# Internet leads (regression):
curl -i -X POST "${API_URL}leads?vendor=lendingtree" \
  -H 'Content-Type: application/json' \
  -d '{"Internal_LeadID":"update-test-001","firstName":"Test"}'

# Live transfers:
curl -i -X POST "${API_URL}v1/live-transfers?vendor=todays-best-mortgage-loans" \
  -H 'Content-Type: application/json' \
  -d '{"transferId":"TBM-update-001","borrower":{"firstName":"T","lastName":"U","phone":"5550000000","email":"t@e.com","state":"TX"},"loan":{"purpose":"Refinance","estimatedAmount":250000,"propertyType":"SFR"}}'
```

Expect HTTP 200 and HTTP 202 respectively, each with a `correlationId` in the response.

## Step 6 — Tail Lambda logs (separate terminal)

```bash
aws logs tail /aws/lambda/dev-live-transfer-router --follow --format short \
  --region us-west-2 --profile emc-sf-integrations-dev

# or for the internet-lead router:
aws logs tail /aws/lambda/dev-vendor-leads-post-router --follow --format short \
  --region us-west-2 --profile emc-sf-integrations-dev
```

## Step 7 — DLQ depth check

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
```

Expect `0`. If non-zero, see "Inspecting DLQ messages" below.

---

## Common operations

### Add a new vendor (no CDK deploy needed)

```bash
aws ssm put-parameter \
  --name "/dev/vendor-leads/vendors/<vendor-name>" \
  --type String \
  --value '{"leadTypes":{"internet":{"leadIdProperty":"<jsonPath>"}}}' \
  --region us-west-2 --profile emc-sf-integrations-dev

# Or for a live-transfer vendor:
aws ssm put-parameter \
  --name "/dev/vendor-leads/vendors/<vendor-name>" \
  --type String \
  --value '{"leadTypes":{"live_transfer":{"leadIdProperty":"<jsonPath>"}}}' \
  --region us-west-2 --profile emc-sf-integrations-dev
```

Lambda picks up the change on next cold start, or within 60 seconds on warm instances (cache TTL).

### Edit an existing vendor

```bash
aws ssm put-parameter \
  --name "/dev/vendor-leads/vendors/<vendor-name>" \
  --type String --overwrite \
  --value '{"leadTypes":{"internet":{"leadIdProperty":"<newJsonPath>"}}}' \
  --region us-west-2 --profile emc-sf-integrations-dev
```

### List all vendor configs

```bash
aws ssm get-parameters-by-path \
  --path /dev/vendor-leads/vendors/ \
  --region us-west-2 --profile emc-sf-integrations-dev \
  --query 'Parameters[].{Name:Name,Value:Value}' \
  --output table
```

### Remove a vendor

```bash
aws ssm delete-parameter \
  --name /dev/vendor-leads/vendors/<vendor-name> \
  --region us-west-2 --profile emc-sf-integrations-dev
```

### Point CDK at a new sandbox (after a sandbox refresh)

When your Salesforce sandbox is refreshed and renamed (e.g. `r2d2` → `c3po`), update `cdk.json`:

```bash
# Edit cdk.json → context.salesforceDomain.dev to the new URL, e.g.
#   "salesforceDomain": {
#     "dev":  "https://emortgage--c3po.sandbox.my.salesforce.com",
#     "prod": "https://emortgage.my.salesforce.com"
#   }

# Then redeploy:
npx cdk diff "dev/*" --profile emc-sf-integrations-dev      # confirm the three SF URLs flip
npx cdk deploy "dev/*" --require-approval broadening --profile emc-sf-integrations-dev
```

The Connection + both API Destinations will be replaced in one update. The OAuth secret keeps its name (`dev/salesforce/sf-lead-store-app-creds`); rotate its value separately if the Connected App's keys changed on the new sandbox (see below).

### Rotate the Salesforce OAuth secret

```bash
SF_CLIENT_ID="<new-consumer-key>"
SF_CLIENT_SECRET="<new-consumer-secret>"

aws secretsmanager put-secret-value \
  --secret-id dev/salesforce/sf-lead-store-app-creds \
  --secret-string "{\"client_id\":\"$SF_CLIENT_ID\",\"client_secret\":\"$SF_CLIENT_SECRET\"}" \
  --region us-west-2 --profile emc-sf-integrations-dev
```

EventBridge picks up the new value on its next token refresh; no redeploy needed.

### Inspecting DLQ messages

```bash
DLQ_URL=$(aws sqs get-queue-url \
  --queue-name dev-vendor-leads-event-dlq \
  --region us-west-2 --profile emc-sf-integrations-dev \
  --query QueueUrl --output text)

aws sqs receive-message \
  --queue-url "$DLQ_URL" \
  --region us-west-2 --profile emc-sf-integrations-dev \
  --max-number-of-messages 10 \
  --message-attribute-names All \
  --attribute-names All
```

After inspection, decide:
- **Bug in our code or config** → fix, redeploy, and replay the event (re-POST to the API, or `aws sqs send-message` back to the source queue, or use EventBridge `start-replay` from the archive).
- **Permanent vendor problem** → `aws sqs delete-message --region us-west-2 --profile emc-sf-integrations-dev` to drop.

### Replay events from the 90-day EventBridge archive

```bash
ACCOUNT=$(aws sts get-caller-identity --profile emc-sf-integrations-dev --query Account --output text)

aws events start-replay \
  --replay-name "replay-$(date +%s)" \
  --event-source-arn "arn:aws:events:us-west-2:${ACCOUNT}:archive/dev-salesforce-event-bus-archive" \
  --event-start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ) \
  --event-end-time   $(date -u           +%Y-%m-%dT%H:%M:%SZ) \
  --destination "ArnReference=arn:aws:events:us-west-2:${ACCOUNT}:event-bus/dev-salesforce-event-bus,FilterArns=[]" \
  --region us-west-2 --profile emc-sf-integrations-dev
```

Adjust time window with `-v-1H` (last hour), `-v-1d` (last day), etc. On Linux, replace `date -u -v-1H` with `date -u -d '1 hour ago'`.

### Trace a single request end-to-end

```bash
# Replace YOUR-CORRELATION-ID below:
aws logs start-query \
  --region us-west-2 --profile emc-sf-integrations-dev \
  --log-group-names \
    /aws/lambda/dev-vendor-leads-post-router \
    /aws/lambda/dev-live-transfer-router \
    /aws/lambda/dev-vendor-leads-ddb-writer \
    /aws/events/dev-salesforce-event-bus \
  --start-time $(($(date +%s) - 3600)) --end-time $(date +%s) \
  --query-string 'fields @timestamp, @log, @message | filter @message like /YOUR-CORRELATION-ID/ | sort @timestamp asc'

# Then:
# aws logs get-query-results --query-id <queryId> --region us-west-2 --profile emc-sf-integrations-dev
```

---

## Rollback plan

```bash
# Hard rollback to the previous deployed CFN template:
npx cdk deploy "dev/*" --rollback --profile emc-sf-integrations-dev

# Or via CFN directly (only if CDK rollback won't work):
aws cloudformation cancel-update-stack \
  --stack-name dev-VendorLeadsMain \
  --region us-west-2 --profile emc-sf-integrations-dev

# If a fresh first-deploy ended in ROLLBACK_COMPLETE, you must delete the stack
# shell before re-attempting; CFN won't allow updates from that state:
aws cloudformation delete-stack \
  --stack-name dev-VendorLeadsMain \
  --region us-west-2 --profile emc-sf-integrations-dev
aws cloudformation wait stack-delete-complete \
  --stack-name dev-VendorLeadsMain \
  --region us-west-2 --profile emc-sf-integrations-dev
```

After a rollback, the previous Lambda code and CFN template are restored. SSM parameters and Secrets Manager secrets are NOT touched by CFN — they remain as-is. If you need to revert SSM/Secrets changes, do that manually with `aws ssm put-parameter --overwrite` or `aws secretsmanager put-secret-value`.
