import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';

const vendorsParameterPath = `/${process.env.STAGE}/vendor-leads/vendors/`;
const ssmClient = new SSMClient({});

/**
 * Fetches per-vendor configuration parameters from SSM Parameter Store.
 * One parameter per vendor under /${STAGE}/vendor-leads/vendors/<vendor-name>.
 *
 * Each parameter value is JSON. Preferred shape:
 *   { "leadTypes": { "internet": { "leadIdProperty": "..." } } }
 *
 * Legacy flat shape is accepted for backward compatibility:
 *   { "leadIdProperty": "..." } → normalized to internet lead type.
 *
 * GetParametersByPath has a hard MaxResults cap of 10 on the AWS API.
 * The do/while loop paginates via NextToken — any number of vendors is supported.
 *
 * @returns {Promise<Object>} Normalized map { vendorName: { leadTypes: {...} } }
 */
async function getVendorsConfig() {
  const raw = {};
  let nextToken;

  try {
    do {
      const response = await ssmClient.send(
        new GetParametersByPathCommand({
          Path: vendorsParameterPath,
          Recursive: false,
          WithDecryption: false,
          MaxResults: 10,
          NextToken: nextToken
        })
      );

      for (const param of response.Parameters || []) {
        const vendor = param.Name.slice(vendorsParameterPath.length);
        try {
          raw[vendor] = JSON.parse(param.Value);
        } catch (parseError) {
          console.error(`Bad JSON for vendor parameter ${param.Name}:`, parseError.message);
        }
      }

      nextToken = response.NextToken;
    } while (nextToken);

    console.log(`Fetched ${Object.keys(raw).length} vendor parameters from SSM`);
  } catch (error) {
    console.error(`Error fetching SSM parameters under ${vendorsParameterPath}:`, error);
  }

  return normalizeVendorsConfig(raw);
}

function normalizeVendorsConfig(raw) {
  const out = {};
  for (const [vendor, cfg] of Object.entries(raw)) {
    if (cfg?.leadTypes && typeof cfg.leadTypes === 'object') {
      out[vendor] = cfg;
    } else if (cfg?.leadIdProperty) {
      out[vendor] = { leadTypes: { internet: cfg } };
    } else {
      out[vendor] = cfg;
    }
  }
  return out;
}

/**
 * Look up the config for a vendor + lead type pair.
 * @param {Object} vendorsConfig - The normalized map returned by getVendorsConfig
 * @param {string} vendor - Vendor name (matches SSM parameter name segment)
 * @param {string} [leadType='internet'] - 'internet' | 'live_transfer'
 * @returns {Object|null} Vendor-leadType config or null if not configured
 */
function getVendorLeadConfig(vendorsConfig, vendor, leadType = 'internet') {
  return vendorsConfig?.[vendor]?.leadTypes?.[leadType] || null;
}

export { getVendorsConfig, getVendorLeadConfig };
