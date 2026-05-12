import { getNestedProperty } from './object-utils.js';
import { getVendorLeadConfig } from './vendors-config.js';

function getVendorsLeadId(data, vendorsConfig, vendorName = null, leadType = 'internet') {
  if (!data) {
    return generateUniqueLeadId(data);
  }

  const vendorLeadConfig = getVendorLeadConfig(vendorsConfig, vendorName, leadType);
  const idPropertyName = vendorLeadConfig?.leadIdProperty;

  let leadId;

  if (idPropertyName) {
    if (idPropertyName.includes('.')) {
      leadId = getNestedProperty(data, idPropertyName);
    } else {
      leadId = data[idPropertyName];
    }
  }

  return leadId || generateUniqueLeadId(data);
}

function generateUniqueLeadId(data) {
  if (data && data.requestId) {
    return `${data.requestId}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }
  return `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

export { getVendorsLeadId };
