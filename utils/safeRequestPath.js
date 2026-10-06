module.exports = (url) => url.split("?")[0]
  .replace(/(\/(?:reset-password|verify-email|verify)\/)[^/]+/g, "$1[redacted]");
