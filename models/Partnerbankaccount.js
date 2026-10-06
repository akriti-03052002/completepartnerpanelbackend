const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

const { VERIFICATION_STATUS } = require("../config/constant");

/* ============================================================
   SECURE PARTNER BANK DETAILS
   VERY IMPORTANT:
   This collection should have restricted application access.
   accountNumberEncrypted and ifscEncrypted should be encrypted
   BEFORE they reach MongoDB.
   Partner users should NOT be allowed to query this collection
   directly.
============================================================ */

const PartnerBankAccountSchema = new Schema(
  {
    partnerId: {
      type: ObjectId,
      ref: "Partner",
      required: true,
      unique: true,
      index: true
    },

    accountHolderName: {
      type: String,
      required: true
    },

    bankName: {
      type: String,
      required: true
    },

    /* SENSITIVE */
    accountNumberEncrypted: {
      type: String,
      required: true,
      select: false
    },

    accountNumberLast4: {
      type: String,
      required: true
    },

    ifscEncrypted: {
      type: String,
      required: true,
      select: false
    },

    ifscMasked: {
      type: String,
      default: ""
    },

    accountType: {
      type: String,
      enum: ["current", "savings", "other"],
      required: true
    },

    /* CANCELLED CHEQUE */
    cancelledChequeDocumentId: {
      type: ObjectId,
      ref: "PartnerDocument"
    },

    /* VERIFICATION */
    verification: {
      status: {
        type: String,
        enum: VERIFICATION_STATUS,
        default: "pending"
      },

      verifiedBy: {
        type: ObjectId,
        ref: "User"
      },

      verifiedAt: {
        type: Date
      },

      rejectionReason: {
        type: String,
        default: ""
      },

      // Set alongside a "verified" decision made without a Razorpay match
      // (razorpayCheck.nameMatchStatus !== "matched") — an admin's explicit
      // reason for overriding the automated check (e.g. maiden vs married
      // name). Logged to PartnerActivity too; kept here for a quick audit
      // trail on the account itself.
      overrideReason: {
        type: String,
        default: ""
      }
    },

    /* RAZORPAY ₹1 VERIFICATION PAYMENT (test-mode Checkout during dev)
       Populated by partnerBankController.initiateBankVerification (creates
       the ₹1 Order) and confirmBankVerification / razorpayWebhookController
       (fill in the result once the payment is confirmed captured — see
       services/partnerBankVerification.applyBankVerificationPayment, the
       shared logic both of those call). Purely informational until an
       admin acts on it via adminBankController.verifyBankAccount, which is
       the only thing that flips `verification.status` and
       `commissionEligibility` below. */
    razorpayCheck: {
      paymentStatus: {
        type: String,
        enum: ["not_initiated", "pending", "captured", "failed"],
        default: "not_initiated"
      },
      orderId: { type: String, default: "", index: true },
      paymentId: { type: String, default: "" },
      // Payment method the partner actually used (upi/card/netbanking/
      // wallet) — bank-name matching only works for netbanking, where
      // Razorpay reports which bank the test payment went through.
      method: { type: String, default: "" },
      bankCode: { type: String, default: "" },
      matchedBankName: { type: String, default: "" },
      nameMatchStatus: {
        type: String,
        enum: ["not_checked", "matched", "mismatched", "unverifiable"],
        default: "not_checked"
      },
      failureReason: { type: String, default: "" },
      completedAt: { type: Date }
    },

    // Only ever set to "eligible" by adminBankController.verifyBankAccount
    // once both the Razorpay check and the admin's own review pass —
    // commissionEngine.js refuses to generate commission for a partner
    // whose bank account isn't "eligible".
    commissionEligibility: {
      type: String,
      enum: ["not_eligible", "eligible"],
      default: "not_eligible"
    },

    /* A Reseller's proposed replacement for an already-verified account,
       staged here until an admin reviews it. The live fields above (and
       their verified status) stay untouched until an admin approves the
       proposal via adminBankController.approveBankAccountChange; rejecting
       it just clears this. While it is present, the ₹1 Razorpay
       verification runs against these fields instead of the live ones
       (see partnerBankController). Reseller-only: the commission-earning types
       replace the live account directly and have their payouts held
       instead (see partnerBankController.upsertBankAccount). */
    pendingChange: {
      type: new Schema(
        {
          accountHolderName: { type: String },
          bankName: { type: String },
          accountNumberEncrypted: { type: String, select: false },
          accountNumberLast4: { type: String },
          ifscEncrypted: { type: String, select: false },
          ifscMasked: { type: String, default: "" },
          accountType: { type: String, enum: ["current", "savings", "other"] },
          cancelledChequeDocumentId: { type: ObjectId, ref: "PartnerDocument" },
          submittedAt: { type: Date },

          // Same shape/meaning as the live razorpayCheck above, but scoped
          // to this proposed account — the ₹1 verification for a change
          // runs against the pending account, not the still-live one.
          razorpayCheck: {
            paymentStatus: {
              type: String,
              enum: ["not_initiated", "pending", "captured", "failed"],
              default: "not_initiated"
            },
            orderId: { type: String, default: "" },
            paymentId: { type: String, default: "" },
            method: { type: String, default: "" },
            bankCode: { type: String, default: "" },
            matchedBankName: { type: String, default: "" },
            nameMatchStatus: {
              type: String,
              enum: ["not_checked", "matched", "mismatched", "unverifiable"],
              default: "not_checked"
            },
            failureReason: { type: String, default: "" },
            completedAt: { type: Date }
          }
        },
        { _id: false }
      ),
      default: null
    },

    /* SECURITY AUDIT */
    security: {
      encryptedAt: {
        type: Date
      },

      keyVersion: {
        type: String
      },

      lastAccessedAt: {
        type: Date
      },

      lastAccessedBy: {
        type: ObjectId,
        ref: "User"
      }
    }
  },
  {
    timestamps: true
  }
);

module.exports = model("PartnerBankAccount", PartnerBankAccountSchema);