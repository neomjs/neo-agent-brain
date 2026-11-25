/**
 * `.catch()` handler for a lookup whose target may not exist: GitHub answers a number that is no
 * issue with a `NOT_FOUND` error beside the null field, and `GraphqlService.query` throws on it.
 * @param {Error} error
 * @returns {null} For `NOT_FOUND`; any other error is rethrown.
 */
const nullIfNotFound = error => {
    if (error?.graphqlErrors?.some(item => item.type === 'NOT_FOUND')) {
        return null
    }

    throw error
};

export default nullIfNotFound;