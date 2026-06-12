import { createHttpResponse } from '../utils/vendors-response.js';
import { getVendorsConfig, getVendorLeadConfig } from '../utils/vendors-config.js';
import { getVendor, getLeadsData } from '../utils/request-parser.js';
import { sendLeadsToSQS, sendLeadsToEventBridge } from '../utils/lead-publisher.js';

const ACCEPTED_RESPONSE_CODE = 202;
const BAD_REQUEST_RESPONSE_CODE = 400;
const INTERNAL_SERVER_ERROR_RESPONSE_CODE = 500;

const LEAD_TYPE = 'direct_lead';
const EVENT_DETAIL_TYPE = 'DirectLeadReceived.v1';
const SERVICE_NAME = 'direct-leads-router';
const CONFIG_TTL_MS = 60_000;

// Routing metadata stripped from the lead payload (some vendors send lead fields
// as query params or form bodies). `emc_*` params are EMC-owned routing codes.
const RESERVED_QUERY_PARAMS = ['vendor', 'emc_branch', 'emc_user'];

let cachedVendorsConfig = null;
let cachedAt = 0;

/**
 * Lambda handler for direct leads from external vendors.
 *
 * Direct leads route to a specific branch and/or loan officer that pays the vendor
 * directly — no Lead_Store_Lead__c is created. The destination is supplied via the
 * EMC-namespaced query params `emc_branch` and/or `emc_user`, each holding an opaque
 * synthetic routing code (never a Salesforce record id).
 *
 * AWS treats the codes as verbatim pass-through: no lowercasing, no format validation.
 * At least one of the two params must be non-empty — both missing means the vendor's
 * URL was mangled (EMC always generates URLs with a destination), so the request is
 * rejected with 400 at the door. Both codes are always populated downstream (empty
 * string when absent) so the EventBridge rule target paths `$.detail.data.emcBranch`
 * and `$.detail.data.emcUser` always resolve. A present-but-unresolvable code is
 * still accepted; Salesforce routes it to a default queue (branch takes priority
 * when both resolve).
 *
 * Validates the vendor against the SSM allowlist for the `direct_lead` lead type,
 * fans the payload out to SQS (DDB archive) and EventBridge (Salesforce delivery),
 * and acknowledges with HTTP 202.
 */
export const handler = async (event, context) => {
  console.log('Received event:', JSON.stringify(event, null, 2));
  const correlationId = context.awsRequestId;
  const receivedAt = new Date().toISOString();
  let response;
  let vendor;

  try {
    vendor = getVendor(event);
    console.log('Vendor: ', vendor);

    if (!vendor) {
      response = createHttpResponse(BAD_REQUEST_RESPONSE_CODE, 'unknown', { error: 'Vendor name cannot be empty.' }, false);
      console.log('Response: ', response);
      return response;
    }

    const vendorsConfig = await getCachedVendorsConfig();
    if (!getVendorLeadConfig(vendorsConfig, vendor, LEAD_TYPE)) {
      response = createHttpResponse(BAD_REQUEST_RESPONSE_CODE, vendor, { error: `Vendor '${vendor}' is not configured for direct leads.` }, false);
      console.log('Response: ', response);
      return response;
    }

    // Verbatim pass-through; always strings so the EventBridge target paths resolve.
    const emcBranch = event.queryStringParameters?.emc_branch ?? '';
    const emcUser = event.queryStringParameters?.emc_user ?? '';
    console.log('Routing codes: ', JSON.stringify({ emcBranch, emcUser }));

    if (!emcBranch && !emcUser) {
      response = createHttpResponse(
        BAD_REQUEST_RESPONSE_CODE,
        vendor,
        { error: 'URL is missing the emc_branch or emc_user parameter. Use the posting URL exactly as provided by eMortgage Capital.' },
        false
      );
      console.log('Response: ', response);
      return response;
    }

    const leadsData = getLeadsData(event, RESERVED_QUERY_PARAMS);
    if (leadsData === null) {
      response = createHttpResponse(BAD_REQUEST_RESPONSE_CODE, vendor, { error: 'No lead data provided in body or query parameters.' }, false);
      console.log('Response: ', response);
      return response;
    }

    await Promise.all([
      sendLeadsToSQS({
        correlationId,
        vendor,
        leadType: LEAD_TYPE,
        leadsData,
        emcBranch,
        emcUser,
        queueUrl: process.env.LEADS_TO_DYNAMODB_SQS_URL
      }),
      sendLeadsToEventBridge({
        correlationId,
        vendor,
        leadType: LEAD_TYPE,
        leadsData,
        emcBranch,
        emcUser,
        eventBusName: process.env.SALESFORCE_EVENT_BUS_NAME,
        eventSource: process.env.SALESFORCE_EVENT_BUS_RULE_SOURCE,
        detailType: EVENT_DETAIL_TYPE,
        serviceName: SERVICE_NAME
      })
    ]);

    response = createHttpResponse(ACCEPTED_RESPONSE_CODE, vendor, { correlationId, receivedAt }, true);
  } catch (error) {
    console.log('Error: ', error);
    response = createHttpResponse(
      INTERNAL_SERVER_ERROR_RESPONSE_CODE,
      vendor || 'unknown',
      { errorMessage: error.message || 'Internal Server Error', correlationId },
      false
    );
  }

  console.log('Response: ', response);
  return response;
};

async function getCachedVendorsConfig() {
  const now = Date.now();
  if (cachedVendorsConfig && now - cachedAt < CONFIG_TTL_MS) {
    return cachedVendorsConfig;
  }
  cachedVendorsConfig = await getVendorsConfig();
  cachedAt = now;
  return cachedVendorsConfig;
}
