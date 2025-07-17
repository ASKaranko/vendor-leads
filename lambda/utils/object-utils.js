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

export { getNestedProperty };