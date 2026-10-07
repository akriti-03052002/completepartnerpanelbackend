module.exports = (query = {}) => {
  const integer = (value, fallback, max) => /^\d+$/.test(String(value)) && Number(value) > 0 ? Math.min(Number(value), max) : fallback;
  const page = integer(query.page, 1, 100000);
  const limit = integer(query.limit, 50, 100);
  return { page, limit, skip: (page - 1) * limit };
};
