/**
 * Factory to create vendor-specific response formats
 * @param {string} vendor - The vendor identifier
 * @param {Object} responseData - Data to include in response
 * @param {boolean} isSuccess - Whether the operation was successful
 * @returns {Object} - Formatted response object
 */
function createVendorResponse(vendor, responseData, isSuccess = true) {
  switch (vendor.toLowerCase()) {
    case 'lendingtree':
      return buildLendingTreeResponse(responseData, isSuccess);

    default:
      return {
        status: isSuccess ? 'success' : 'error',
        message: isSuccess ? 'Leads processed asynchronously.' : responseData?.errorMessage || 'Failed to process leads request.'
      };
  }
}

/**
 * Create standardized HTTP response with vendor-specific body
 * @param {number} statusCode - HTTP status code
 * @param {string} vendor - The vendor identifier
 * @param {Object} responseData - Data to include in response
 * @param {boolean} isSuccess - Whether the operation was successful
 * @returns {Object} - API Gateway response object
 */
function createHttpResponse(statusCode, vendor, responseData, isSuccess = true) {
  const vendorResponseBody = createVendorResponse(vendor, responseData, isSuccess);

  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, vendor'
    },
    body: JSON.stringify(vendorResponseBody)
  };
}

function buildLendingTreeResponse(responseData, isSuccess = true) {
  const leadAcknowledgement = {
    leadExternalId: responseData?.leadId || null,
    partnerDecision: isSuccess ? 'accepted' : 'rejected',
    attemptRetransmit: !isSuccess
  };

  return {
    leadAcknowledgement
  };
}

export { createHttpResponse };
