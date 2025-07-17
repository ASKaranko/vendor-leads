import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const parameterStoreNameForVendorsConfig = `/${process.env.STAGE}/vendor-leads/vendors-config`;

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
async function getVendorsConfig() {
  let vendorsConfig = {};
  try {
    const command = new GetParameterCommand({
      Name: parameterStoreNameForVendorsConfig,
      WithDecryption: false
    });
    const response = await new SSMClient().send(command);
    if (response.Parameter && response.Parameter.Value) {
      vendorsConfig = JSON.parse(response.Parameter.Value);
      console.log(`Fetched vendors config from SSM: ${JSON.stringify(vendorsConfig)}`);
    } else {
      throw new Error(`Parameter ${parameterStoreNameForVendorsConfig} not found or has no value.`);
    }
  } catch (error) {
    console.error(`Error fetching or parsing SSM parameter ${parameterStoreNameForVendorsConfig}:`, error);
  }
  return vendorsConfig;
}

export { getVendorsConfig };
