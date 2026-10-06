const { validationResult } = require("express-validator");

// Shared express-validator result handler. If any validation rule failed,
// respond 400 with the first error's message (keeping the existing
// { success: false, message } response shape); otherwise continue.
const handleValidation = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, message: errors.array()[0].msg });
  }

  next();
};

module.exports = handleValidation;
