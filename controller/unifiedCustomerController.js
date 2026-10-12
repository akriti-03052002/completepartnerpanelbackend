const bcrypt = require('bcryptjs');
const { Customer, Partner } = require('../models/Index');
const ResellerCustomer = require('../models/ResellerCustomer');
const vendor = require('./customerPublicController');
const reseller = require('./publicResellerCustomerController');
const { googleLogin } = require('../utils/googleIdentity');

const accountsForEmail = async email => {
  const [direct, portal] = await Promise.all([
    Customer.findOne({ email }).select('+auth.passwordHash +auth.googleSub'),
    ResellerCustomer.findOne({ 'contactDetails.email': email }).select('+auth.passwordHash +auth.googleSub')
  ]);
  return [direct && { type: 'vendor', account: direct }, portal && { type: 'reseller', account: portal }].filter(Boolean);
};
const tagResponse = (res, type) => {
  const json = res.json.bind(res);
  res.json = body => json(body.success && body.data ? { ...body, data: { ...body.data, customerType: type } } : body);
};
exports.login = async (req, res, next) => {
  try {
    if (typeof req.body.email !== 'string' || typeof req.body.password !== 'string' || !req.body.password) return res.status(400).json({ success: false, message: 'Email and password are required.' });
    const matches = await accountsForEmail(req.body.email.trim().toLowerCase());
    const valid = [];
    for (const item of matches) if (item.account.auth?.passwordHash && await bcrypt.compare(req.body.password, item.account.auth.passwordHash)) valid.push(item);
    if (!valid.length) return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    if (valid.length !== 1) return res.status(409).json({ success: false, message: 'This email matches more than one customer account. Contact SPOTX to resolve the accounts.' });
    tagResponse(res, valid[0].type);
    return (valid[0].type === 'reseller' ? reseller.loginCustomer : vendor.loginCustomer)(req, res, next);
  } catch (error) { next(error); }
};
exports.googleLogin = async (req, res, next) => {
  try {
    const matches = await accountsForEmail(req.body.email);
    if (!matches.length) return res.status(404).json({ success: false, message: 'Register first using your partner referral code.' });
    if (matches.length !== 1) return res.status(409).json({ success: false, message: 'Multiple customer accounts use this email. Sign in with your password or contact SPOTX.' });
    const type = matches[0].type;
    tagResponse(res, type);
    return googleLogin(type === 'reseller' ? ResellerCustomer : Customer, type === 'reseller' ? 'contactDetails.email' : 'email', type === 'reseller' ? reseller.loginCustomer : vendor.loginCustomer)(req, res, next);
  } catch (error) { next(error); }
};
exports.referral = async (req, res, next) => {
  try {
    const matches = await Partner.find({ 'referral.referralCode': req.params.code.trim(), partnerType: { $in: ['vendor', 'reseller'] }, status: 'active' }).select('partnerType legalEntity.businessName').limit(2);
    if (matches.length !== 1) return res.status(404).json({ success: false, message: 'This referral code is invalid or no longer active.' });
    res.json({ success: true, data: { customerType: matches[0].partnerType, businessName: matches[0].legalEntity.businessName } });
  } catch (error) { next(error); }
};
exports.forgotPassword = async (req, res, next) => {
  try {
    if (typeof req.body.email !== 'string' || !req.body.email.trim()) return res.status(400).json({ success: false, message: 'Enter your email.' });
    const matches = await accountsForEmail(req.body.email.trim().toLowerCase());
    if (matches.length !== 1) return res.json({ success: true, message: 'If an eligible account exists, you will receive an email link. Contact SPOTX if no link arrives.' });
    return (matches[0].type === 'reseller' ? reseller.requestPasswordLink : vendor.forgotCustomerPassword)(req, res, next);
  } catch (error) { next(error); }
};
