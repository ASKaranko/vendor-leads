import { createHttpResponse } from '../utils/vendors-response.js';
import { getVendorsConfig } from '../utils/vendors-config.js';
import { getVendorsLeadId } from '../utils/vendors-data.js';
import { getVendor, getLeadsData } from '../utils/request-parser.js';
import { sendLeadsToSQS, sendLeadsToEventBridge } from '../utils/lead-publisher.js';

const SUCCESS_RESPONSE_CODE = 200;
const BAD_REQUEST_RESPONSE_CODE = 400;
const INTERNAL_SERVER_ERROR_RESPONSE_CODE = 500;

const LEAD_TYPE = 'internet';
const EVENT_DETAIL_TYPE = 'LeadsReceived.v1';
const SERVICE_NAME = 'vendor-leads-router';

/**
 * Lambda handler for processing internet leads from external vendors
 * @param {Object} event - The event object containing the request data
 * @param {Object} context - The context object containing information about the invocation, function, and execution environment
 * @returns
 */
export const handler = async (event, context) => {
  console.log('Received event:', JSON.stringify(event, null, 2));
  const correlationId = context.awsRequestId;
  let response;
  let vendor;
  let leadId;

  try {
    vendor = getVendor(event);
    console.log('Vendor: ', vendor);

    if (!vendor) {
      response = createHttpResponse(BAD_REQUEST_RESPONSE_CODE, 'unknown', { error: 'Vendor name cannot be empty.' }, false);
      console.log('Response: ', response);
      return response;
    }
    const leadsData = getLeadsData(event);

    if (leadsData === null) {
      response = createHttpResponse(BAD_REQUEST_RESPONSE_CODE, vendor, { error: 'No lead data provided in body or query parameters.' }, false);
      console.log('Response: ', response);
      return response;
    }

    leadId = await extractLeadIdFromNonArrayData(leadsData, vendor);

    await sendLeadsToSQS({
      correlationId,
      vendor,
      leadType: LEAD_TYPE,
      leadsData,
      queueUrl: process.env.LEADS_TO_DYNAMODB_SQS_URL
    });

    await sendLeadsToEventBridge({
      correlationId,
      vendor,
      leadType: LEAD_TYPE,
      leadsData,
      eventBusName: process.env.SALESFORCE_EVENT_BUS_NAME,
      eventSource: process.env.SALESFORCE_EVENT_BUS_RULE_SOURCE,
      detailType: EVENT_DETAIL_TYPE,
      serviceName: SERVICE_NAME
    });

    response = createHttpResponse(SUCCESS_RESPONSE_CODE, vendor, { leadId, correlationId }, true);
  } catch (error) {
    console.log('Error: ', error);
    response = createHttpResponse(
      INTERNAL_SERVER_ERROR_RESPONSE_CODE,
      vendor || 'unknown',
      { errorMessage: error.message || 'Internal Server Error', leadId, correlationId },
      false
    );
  }

  console.log('Response: ', response);
  return response;
};

/**
 * Extracts the lead ID from non-array lead data
 * @param {*} leadsData - The lead data which can be an JSON object or a string
 * @param {*} vendorName - The name of the vendor
 * @returns
 */
async function extractLeadIdFromNonArrayData(leadsData, vendorName) {
  if (!leadsData) {
    return null;
  }

  const parsedLeadsData = typeof leadsData === 'string' ? JSON.parse(leadsData) : leadsData;

  if (typeof parsedLeadsData !== 'object' || Array.isArray(parsedLeadsData)) {
    return null;
  }

  const vendorsConfig = await getVendorsConfig();

  return getVendorsLeadId(parsedLeadsData, vendorsConfig, vendorName, LEAD_TYPE);
}
