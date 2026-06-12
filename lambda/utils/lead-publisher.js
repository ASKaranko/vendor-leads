import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { randomUUID } from 'crypto';

const MAX_BATCH = 10;
const PAYLOAD_VERSION = '1';

function toLeadsArray(leadsData) {
  const parsed = typeof leadsData === 'string' ? JSON.parse(leadsData) : leadsData;
  return Array.isArray(parsed) ? parsed : [parsed];
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Send leads to SQS in batches of 10. Each message body carries the
 * correlationId, vendor, leadType, and the lead payload itself.
 * @param {Object} params
 * @param {string} params.correlationId
 * @param {string} params.vendor
 * @param {string} params.leadType - 'internet' | 'live_transfer' | 'direct_lead'
 * @param {string|object|Array<object>} params.leadsData
 * @param {string} params.queueUrl - SQS queue URL
 * @param {string} [params.emcBranch] - opaque branch routing code (direct-leads only);
 *   omitted from the message body when undefined.
 * @param {string} [params.emcUser] - opaque user routing code (direct-leads only);
 *   omitted from the message body when undefined.
 * @returns {Promise<void>}
 */
async function sendLeadsToSQS({ correlationId, vendor, leadType, leadsData, queueUrl, emcBranch, emcUser }) {
  const sqsClient = new SQSClient({});
  const leads = toLeadsArray(leadsData);
  const leadChunks = chunkArray(leads, MAX_BATCH);

  for (const chunk of leadChunks) {
    try {
      const entries = chunk.map((lead, index) => ({
        Id: `${correlationId}${index}`,
        MessageBody: JSON.stringify({
          requestId: correlationId,
          correlationId,
          vendor,
          leadType,
          ...(emcBranch !== undefined ? { emcBranch } : {}),
          ...(emcUser !== undefined ? { emcUser } : {}),
          lead
        })
      }));

      console.log('sqs entries size', entries.length);

      const command = new SendMessageBatchCommand({
        QueueUrl: queueUrl,
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
 * Send leads to EventBridge in batches of 10. Wraps each batch in the
 * standard metadata envelope so consumers can correlate, deduplicate,
 * and version events.
 * @param {Object} params
 * @param {string} params.correlationId
 * @param {string} params.vendor
 * @param {string} params.leadType - 'internet' | 'live_transfer' | 'direct_lead'
 * @param {string|object|Array<object>} params.leadsData
 * @param {string} params.eventBusName
 * @param {string} params.eventSource
 * @param {string} params.detailType - e.g. 'LeadsReceived.v1'
 * @param {string} params.serviceName - emitter identifier for metadata.service
 * @param {string} [params.emcBranch] - opaque branch routing code (direct-leads only);
 *   carried in detail.data so the rule target can map it to ?emc_branch=. Omitted when undefined.
 * @param {string} [params.emcUser] - opaque user routing code (direct-leads only);
 *   carried in detail.data so the rule target can map it to ?emc_user=. Omitted when undefined.
 * @returns {Promise<void>}
 */
async function sendLeadsToEventBridge({ correlationId, vendor, leadType, leadsData, eventBusName, eventSource, detailType, serviceName, emcBranch, emcUser }) {
  const ebClient = new EventBridgeClient({});
  const leads = toLeadsArray(leadsData);
  const leadChunks = chunkArray(leads, MAX_BATCH);

  for (const chunk of leadChunks) {
    try {
      console.log('EventBridge chunk size', chunk.length);
      console.log('EventBridge chunk', JSON.stringify(chunk, null, 2));

      const detail = buildEventDetail({ correlationId, vendor, leadType, leads: chunk, serviceName, emcBranch, emcUser });

      const command = new PutEventsCommand({
        Entries: [
          {
            EventBusName: eventBusName,
            Source: eventSource,
            DetailType: detailType,
            Detail: JSON.stringify(detail)
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

function buildEventDetail({ correlationId, vendor, leadType, leads, serviceName, emcBranch, emcUser }) {
  return {
    metadata: {
      id: randomUUID(),
      version: PAYLOAD_VERSION,
      timestamp: new Date().toISOString(),
      correlationId,
      service: serviceName
    },
    data: {
      vendor,
      leadType,
      ...(emcBranch !== undefined ? { emcBranch } : {}),
      ...(emcUser !== undefined ? { emcUser } : {}),
      leads
    }
  };
}

export { sendLeadsToSQS, sendLeadsToEventBridge };
