import { DynamoDBClient, BatchWriteItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const parameterStoreNameForVendorsConfig = `/${process.env.STAGE}/vendor-leads/vendors-config`;

/**
 * Lambda handler for processing leads from external vendors
 * @param {Object} event - The event object containing the request data
 * @param {Object} context - The context object containing information about the invocation, function, and execution environment
 * @returns
 */
export const handler = async (event) => {
  console.log('Received event:', JSON.stringify(event, null, 2));

  if (!event.Records || event.Records.length === 0) {
    console.log('No records found in the event');
    return;
  }

  const messages = [];

  try {
    for (const record of event.Records) {
      messages.push(JSON.parse(record.body));
    }
    console.log(`Successfully processed ${messages.length} records`);
  } catch (error) {
    console.error('Error processing SQS messages:', error);
    throw error;
  }

  try {
    await saveToDynamoDB(messages);
    console.log('Successfully saved leads to DynamoDB');
  } catch (error) {
    console.error('Error saving leads to DynamoDB:', error);
    throw error;
  }
};

/**
 * Helper function to insert leads into DynamoDB
 * @param {Array} messages - An array of lead objects to be inserted into DynamoDB
 * @returns {Promise<void>}
 */
async function saveToDynamoDB(messages) {
  const ddb = new DynamoDBClient({});
  const MAX_RETRIES = 3;

  /**
   * Fetches the vendor configuration from SSM Parameter Store
   * Format should be like:
   * {
      "lendingtree": {
        "leadIdProperty": "Internal_LeadID"
      },
      "lendgo": {
        "leadIdProperty": "universal_leadid"
      },
      "testurl": {
        "leadIdProperty": "id"
      }
    }
   */
  const vendorsConfig = await getVendorsConfig();

  console.log('Vendors Config:', vendorsConfig);

  const putRequests = messages.map((message) => {
    // Get the vendor-specific ID property name or default to a fallback
    let idPropertyName = vendorsConfig[message.vendor.toLowerCase()]?.leadIdProperty;

    let leadId;

    if (idPropertyName) {
      if (idPropertyName.includes('.')) {
        // Traverse nested object properties
        leadId = getNestedProperty(message.lead, idPropertyName);
      } else {
        // Simple property access
        leadId = message.lead[idPropertyName];
      }
    }

    if (!leadId) {
      leadId = `${message.requestId}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    }

    return {
      PutRequest: {
        Item: {
          LeadId: { S: `Lead#${leadId}` },
          VendorName: { S: `Vendor#${message.vendor}` },
          Vendor: { S: message.vendor },
          ReceivedAt: { S: new Date().toISOString() },
          Lead: { M: marshall(message.lead) }
        }
      }
    };
  });

  let unprocessedItems = { [process.env.VENDOR_LEADS_TABLE_NAME]: putRequests };
  let retryCount = 0;

  while (Object.keys(unprocessedItems).length > 0 && retryCount < MAX_RETRIES) {
    try {
      // Exponential backoff for retries
      if (retryCount > 0) {
        const delay = Math.min(100 * Math.pow(2, retryCount), 2000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const response = await ddb.send(
        new BatchWriteItemCommand({
          RequestItems: unprocessedItems
        })
      );
      console.log('DB Save response: ', response);

      unprocessedItems = response.UnprocessedItems || {};
      if (Object.keys(unprocessedItems).length > 0) {
        retryCount++;
        console.log(`Retrying ${Object.values(unprocessedItems).flat().length} items`);
      }
    } catch (error) {
      retryCount++;
      console.error(`Batch write error: ${error.message}`);

      if (retryCount >= MAX_RETRIES) {
        throw error;
      }
    }
  }

  if (Object.keys(unprocessedItems).length > 0) {
    console.error(`Failed to process ${Object.values(unprocessedItems).flat().length} items after ${MAX_RETRIES} retries`);
  }
}

/**
 * Fetches the vendor configuration from SSM Parameter Store
 * @returns {Promise<Object>} The parsed vendor configuration object
 */
async function getVendorsConfig() {
  try {
    const command = new GetParameterCommand({
      Name: parameterStoreNameForVendorsConfig,
      WithDecryption: false
    });
    const response = await new SSMClient().send(command);
    if (response.Parameter && response.Parameter.Value) {
      return JSON.parse(response.Parameter.Value);
    } else {
      throw new Error(`Parameter ${parameterStoreNameForVendorsConfig} not found or has no value.`);
    }
  } catch (error) {
    console.error(`Error fetching or parsing SSM parameter ${parameterStoreNameForVendorsConfig}:`, error);
  }
  return {};
}

/**
 * Helper function to get nested property value from an object using dot notation
 * @param {Object} obj - The object to traverse
 * @param {string} path - The dot-separated path (e.g., "user.profile.id")
 * @returns {*} The value at the specified path, or undefined if not found
 */
function getNestedProperty(obj, path) {
  if (!obj || !path) return undefined;

  const keys = path.split('.');
  let current = obj;

  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = current[key];
  }

  return current;
}
