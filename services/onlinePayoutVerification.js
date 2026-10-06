const { PartnerBankAccount } = require("../models/Index");
const { decrypt } = require("../utils/encryption");
const { fetchPayout, fetchFundAccount, RazorpayXError } = require("../utils/razorpayX");
const { computePayableAmount } = require("./settlementPayoutFulfillment");

/* ============================================================
   ONLINE PAYOUT VERIFICATION
   The admin pays the partner online through RazorpayX (seeing the
   partner's account number on the Pay screen), then enters the payout's
   transaction ID. Before the settlement is marked paid, the transaction is
   looked up in RazorpayX and must:
     1. be processed (money actually sent),
     2. be for the amount payable on this settlement, and
     3. have gone to this partner's bank account (account number + IFSC).
============================================================ */

const normalize = (v) => String(v || "").replace(/\s+/g, "").toUpperCase();

const last4 = (v) => (v ? String(v).slice(-4) : "");

// The partner's full bank details, for the admin to pay into.
const getPartnerBankDetails = async (partnerId) => {
  const account = await PartnerBankAccount.findOne({ partnerId }).select("+accountNumberEncrypted +ifscEncrypted");
  if (!account) return null;
  return {
    id: account._id,
    accountHolderName: account.accountHolderName,
    bankName: account.bankName,
    accountNumber: decrypt(account.accountNumberEncrypted),
    ifsc: decrypt(account.ifscEncrypted),
    verificationStatus: account.verification?.status
  };
};

/**
 * Looks up a RazorpayX payout and checks it against the settlement.
 * Returns { ok, payout, checks, problems } — never throws for a failed
 * check (only for RazorpayX being unreachable/misconfigured), so the same
 * result can drive both the preview and the final confirmation.
 */
const verifyOnlinePayout = async (settlement, transactionId) => {
  const id = String(transactionId || "").trim();
  if (!/^pout_[A-Za-z0-9]+$/.test(id)) {
    throw new RazorpayXError("Enter the RazorpayX payout transaction ID (it starts with \"pout_\").");
  }

  const [payout, bank, payable] = await Promise.all([
    fetchPayout(id),
    getPartnerBankDetails(settlement.partnerId),
    computePayableAmount(settlement)
  ]);
  if (!bank) throw new RazorpayXError("This partner has no bank account on file.");

  const fundAccount = payout.fund_account?.bank_account
    ? payout.fund_account
    : payout.fund_account_id ? await fetchFundAccount(payout.fund_account_id) : null;
  const paidTo = fundAccount?.bank_account || {};

  const paidAmount = (payout.amount || 0) / 100;
  const checks = {
    processed: payout.status === "processed",
    amountMatches: Math.abs(paidAmount - payable.total) <= 1,
    accountMatches: Boolean(paidTo.account_number) && normalize(paidTo.account_number) === normalize(bank.accountNumber),
    ifscMatches: !paidTo.ifsc || normalize(paidTo.ifsc) === normalize(bank.ifsc)
  };

  const problems = [];
  if (!checks.processed) problems.push(`Payout status is "${payout.status}", not processed yet.`);
  if (!checks.amountMatches) problems.push(`Amount paid ₹${paidAmount.toFixed(2)} doesn't match the ₹${payable.total.toFixed(2)} payable.`);
  if (!checks.accountMatches) problems.push(`Paid to account ending ${last4(paidTo.account_number) || "?"}, but the partner's account ends ${last4(bank.accountNumber)}.`);
  if (!checks.ifscMatches) problems.push(`Paid to IFSC ${paidTo.ifsc}, but the partner's IFSC is ${bank.ifsc}.`);

  return {
    ok: problems.length === 0,
    checks,
    problems,
    payout: {
      id: payout.id,
      status: payout.status,
      amount: paidAmount,
      expectedAmount: payable.total,
      mode: payout.mode || "",
      utr: payout.utr || "",
      paidToAccountLast4: last4(paidTo.account_number),
      paidToIfsc: paidTo.ifsc || "",
      paidToName: paidTo.name || "",
      createdAt: payout.created_at ? new Date(payout.created_at * 1000) : null
    }
  };
};

module.exports = { getPartnerBankDetails, verifyOnlinePayout };
