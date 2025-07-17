import { DynamoDBClient, BatchWriteItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { getVendorsConfig } from '../utils/vendors-config.js';
import { getVendorsLeadId } from '../utils/vendors-data.js';

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

  const vendorsConfig = await getVendorsConfig();

  const putRequests = messages.map((message) => {
    const leadId = getVendorsLeadId(message.lead, vendorsConfig, message.vendor);

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
