const { body } = require("express-validator");
const handleValidation = require("./handleValidation");

const loginAdminValidator = [
  body("email").exists({ checkFalsy: true }).withMessage("Email and password are required."),
  body("password").exists({ checkFalsy: true }).withMessage("Email and password are required."),
  handleValidation
];

module.exports = { loginAdminValidator };
