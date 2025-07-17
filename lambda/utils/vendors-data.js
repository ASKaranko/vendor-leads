import { getNestedProperty } from './object-utils.js';

function getVendorsLeadId(data, vendorsConfig, vendorName = null) {
  if (!data) {
    return generateUniqueLeadId(data);
  }

  let idPropertyName = vendorsConfig[vendorName]?.leadIdProperty;

  let leadId;

  if (idPropertyName) {
    if (idPropertyName.includes('.')) {
      // Traverse nested object properties
      leadId = getNestedProperty(data, idPropertyName);
    } else {
      // Simple property access
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
