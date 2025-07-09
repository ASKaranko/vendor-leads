import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const BAD_REQUEST_CODE = 400;
const INTERNAL_SERVER_ERROR_REQUEST_CODE = 500;

/**
 * Lambda handler for processing leads from external vendors
 * @param {Object} event - The event object containing the request data
 * @param {Object} context - The context object containing information about the invocation, function, and execution environment
 * @returns
 */
export const handler = async (event, context) => {
  const res = {
    headers: {
      'Content-Type': 'application/json'
    }
  };

  console.log('Received event:', JSON.stringify(event, null, 2));

  try {
    let vendor = getVendor(event);
    console.log('Vendor:', vendor);

    if (!vendor) {
      res.statusCode = BAD_REQUEST_CODE;
      res.body = JSON.stringify({ message: 'Vendor name cannot be empty.' });
      return res;
    }
    const leadsData = getLeadsData(event);

    if (leadsData === null) {
      res.statusCode = BAD_REQUEST_CODE;
      res.body = JSON.stringify({ message: 'Bad Request: No lead data provided in body or query parameters.' });
      return res;
    }

    await sendLeadsToSQS(context.awsRequestId, vendor, leadsData);
    await sendLeadsToEventBridge(vendor, leadsData);
    res.statusCode = 200;
    res.body = JSON.stringify({ message: 'Leads processed asynchronously.' });
  } catch (error) {
    console.log('Error: ', error);
    res.statusCode = INTERNAL_SERVER_ERROR_REQUEST_CODE;
    res.body = JSON.stringify({ message: 'Failed to process leads request. Internal Server Error' });
  }
  return res;
};

/**
 * Send leads to SQS in batches respecting the 10-entry limit
 * @param requestId - The request identifier
 * @param {string} vendor - The vendor identifier
 * @param {string|object|Array[Object]} leadsData - The request body containing leads
 * @returns {Promise<void>}
 */
async function sendLeadsToSQS(requestId, vendor, leadsData) {
  const sqsClient = new SQSClient({});
  const QUEUE_URL = process.env.LEADS_TO_DYNAMODB_SQS_URL;
  const MAX_MESSAGES_PER_BATCH = 10;

  // Parse body if needed
  const parsedLeadsData = typeof leadsData === 'string' ? JSON.parse(leadsData) : leadsData;

  const leads = Array.isArray(parsedLeadsData) ? parsedLeadsData : [parsedLeadsData];

  // Split into chunks of 10 for SQS's batch limit
  const leadChunks = [];
  for (let i = 0; i < leads.length; i += MAX_MESSAGES_PER_BATCH) {
    leadChunks.push(leads.slice(i, i + MAX_MESSAGES_PER_BATCH));
  }

  for (const chunk of leadChunks) {
    try {
      const entries = chunk.map((lead, index) => ({
        Id: `${requestId}${index}`,
        MessageBody: JSON.stringify({
          requestId,
          vendor,
          lead
        })
      }));

      console.log('sqs entries size', entries.length);

      const command = new SendMessageBatchCommand({
        QueueUrl: QUEUE_URL,
        Entries: entries
      });

      const response = await sqsClient.send(command);

      console.log('SQS response: ', response);

      if (response.Failed && response.Failed.length > 0) {
        console.error('Failed to send some messages:', response.Failed);
      }
    } catch (error) {
      console.error('Error sending messages to SQS:', error);
    }
  }
}

/**
 * Send leads to EventBridge in batches respecting the 10-entry limit
 * @param {string} vendor - The vendor identifier
 * @param {string|object|Array[Object]} leadsData - The request body containing leads
 * @returns {Promise<void>}
 */
async function sendLeadsToEventBridge(vendor, leadsData) {
  const ebClient = new EventBridgeClient({});
  const MAX_EVENTS_PER_BATCH = 10;

  // Parse body if needed
  const parsedLeadsData = typeof leadsData === 'string' ? JSON.parse(leadsData) : leadsData;

  // Ensure we handle both single leads and arrays of leads
  const leads = Array.isArray(parsedLeadsData) ? parsedLeadsData : [parsedLeadsData];

  // Split into chunks of 10 for EventBridge's batch limit
  const leadChunks = [];
  for (let i = 0; i < leads.length; i += MAX_EVENTS_PER_BATCH) {
    leadChunks.push(leads.slice(i, i + MAX_EVENTS_PER_BATCH));
  }

  for (const chunk of leadChunks) {
    try {
      console.log('EventBridge chunk size', chunk.length);
      console.log('EventBridge chunk', JSON.stringify(chunk, null, 2));

      const command = new PutEventsCommand({
        Entries: [
          {
            EventBusName: process.env.SALESFORCE_EVENT_BUS_NAME,
            Source: process.env.SALESFORCE_EVENT_BUS_RULE_SOURCE,
            DetailType: process.env.SALESFORCE_EVENT_BUS_RULE_DETAIL_TYPE,
            Detail: JSON.stringify({
              vendor,
              leads: chunk
            })
          }
        ]
      });

      const response = await ebClient.send(command);
      console.log('EventBridge response:', response);

      if (response.FailedEntryCount > 0) {
        console.error(
          'Failed to send some events:',
          response.Entries.filter((e) => e.ErrorCode)
        );
      }
    } catch (error) {
      console.error('Error sending events to EventBridge:', error);
      throw error;
    }
  }
}

function getVendor(event) {
  if (event.headers?.vendor) {
    return event.headers.vendor;
  }
  if (event.queryStringParameters?.vendor) {
    return event.queryStringParameters.vendor;
  }
}

function getLeadsData(event) {
  if (event.body && event.body.length > 0) {
    const contentType = event.headers?.['Content-type'] || event.headers?.['content-type'] || event.headers?.['Content-Type'] || '';

    if (contentType.includes('application/x-www-form-urlencoded')) {
      // Parse URL-encoded body data
      const bodyParams = decodeURLParamsInBody(event.body);

      if (bodyParams.vendor) {
        delete bodyParams.vendor;
      }

      if (Object.keys(bodyParams).length === 0) {
        return null;
      }

      return JSON.stringify(bodyParams);
    } else {
      // Assume JSON body
      return event.body;
    }
  } else {
    const queryParamsWithoutVendor = { ...event.queryStringParameters };
    if (queryParamsWithoutVendor.vendor) {
      delete queryParamsWithoutVendor.vendor;
    }
    if (Object.keys(queryParamsWithoutVendor).length === 0) {
      return null;
    }

    console.log('Query parameters without vendor:', queryParamsWithoutVendor);
    return JSON.stringify(decodeURLParams(queryParamsWithoutVendor));
  }
}

/**
 * Shared helper function to decode URL-encoded key-value pairs
 * @param {string} key - The key to decode
 * @param {string} value - The value to decode
 * @returns {Array} - [decodedKey, decodedValue]
 */
function decodeKeyValuePair(key, value) {
  try {
    const decodedKey = decodeFormValue(key);
    const decodedValue = decodeFormValue(value);
    return [decodedKey, decodedValue];
  } catch (error) {
    console.warn(`Failed to decode parameter ${key}=${value}:`, error);
    return [key, value];
  }
}

/**
 * Helper function to decode URL-encoded parameters
 * @param {Object} params - Object with potentially URL-encoded values
 * @returns {Object} - Object with decoded values
 */
function decodeURLParams(params) {
  const decodedParams = {};

  for (const [key, value] of Object.entries(params)) {
    const [decodedKey, decodedValue] = decodeKeyValuePair(key, value);
    decodedParams[decodedKey] = decodedValue;
  }

  return decodedParams;
}

/**
 * Parse URL-encoded body data (e.g., "key1=value1&key2=value2")
 * @param {string} body - URL-encoded string
 * @returns {Object} - Parsed and decoded parameters
 */
function decodeURLParamsInBody(body) {
  const params = {};

  if (!body || body.trim() === '') {
    return params;
  }

  const pairs = body.split('&');

  for (const pair of pairs) {
    const [key, value = null] = pair.split('=');
    if (!key) {
      continue;
    }
    const actualValue = value === null || value === '' ? null : value;
    const [decodedKey, decodedValue] = decodeKeyValuePair(key, actualValue);
    params[decodedKey] = decodedValue;
  }

  return params;
}

function decodeFormValue(value) {
  if (value === null || value === undefined) return value;
  return decodeURIComponent(value.replace(/\+/g, ' '));
}
