/**
 * Shared request parsing utilities for vendor lead routers.
 * Handles vendor extraction (header or query) and body parsing
 * (JSON, application/x-www-form-urlencoded, or query string fallback).
 */

function getVendor(event) {
  if (event.headers?.vendor) {
    return event.headers.vendor;
  }
  if (event.queryStringParameters?.vendor) {
    return event.queryStringParameters.vendor;
  }
}

/**
 * Parse the lead payload out of the request.
 * @param {Object} event - API Gateway event
 * @param {string[]} [reservedKeys=['vendor']] - query/form keys that are routing
 *   metadata, not lead fields, and must be stripped before normalization.
 *   Defaults to ['vendor'] so internet-leads and live-transfers are unchanged;
 *   direct-leads passes ['vendor', 'emc_branch', 'emc_user'].
 */
function getLeadsData(event, reservedKeys = ['vendor']) {
  if (event.body && event.body.length > 0) {
    const contentType = event.headers?.['Content-type'] || event.headers?.['content-type'] || event.headers?.['Content-Type'] || '';

    console.log('Content-Type:', contentType);

    if (contentType.includes('application/x-www-form-urlencoded')) {
      const bodyParams = decodeURLParamsInBody(event.body);

      for (const key of reservedKeys) {
        delete bodyParams[key];
      }

      if (Object.keys(bodyParams).length === 0) {
        return null;
      }

      return JSON.stringify(bodyParams);
    } else {
      return event.body;
    }
  } else {
    const queryParams = { ...event.queryStringParameters };
    for (const key of reservedKeys) {
      delete queryParams[key];
    }
    if (Object.keys(queryParams).length === 0) {
      return null;
    }

    console.log('Query parameters without reserved keys:', queryParams);
    return JSON.stringify(decodeURLParams(queryParams));
  }
}

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

function decodeURLParams(params) {
  const decodedParams = {};

  for (const [key, value] of Object.entries(params)) {
    const [decodedKey, decodedValue] = decodeKeyValuePair(key, value);
    decodedParams[decodedKey] = decodedValue;
  }

  return decodedParams;
}

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

  let decoded = value;
  let previousDecoded = '';

  // Keep decoding until no more changes occur (handles multiple encoding levels)
  while (decoded !== previousDecoded) {
    previousDecoded = decoded;
    try {
      decoded = decodeURIComponent(decoded.replace(/\+/g, ' '));
    } catch (error) {
      console.warn(`Failed to decode value: ${decoded}`, error);
      break;
    }
  }

  return decoded;
}

export { getVendor, getLeadsData };
