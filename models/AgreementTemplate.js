const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

/* ============================================================
   AGREEMENT TEMPLATE (single document)
   The admin-editable wording of the Influencer Agreement PDF.
   Text may contain {{placeholders}} filled per influencer (see
   services/generatePartnerAgreement.js). The influencer's details and
   each account's rates are always generated, never typed in here.
============================================================ */

const SectionSchema = new Schema(
  {
    // "payment_rates" is the one section the per-account rate list is
    // printed in; every template has exactly one.
    kind: { type: String, enum: ["text", "payment_rates"], default: "text" },
    heading: { type: String, required: true, trim: true },
    body: { type: String, default: "" },
    bullets: [{ type: String, trim: true }],
    // Paragraph printed after the bullets / rate list.
    note: { type: String, default: "" },
    // payment_rates only: shown instead of the list when no rates are set.
    noRatesText: { type: String, default: "" }
  },
  { _id: false }
);

const AgreementTemplateSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    companyName: { type: String, default: "SPOTX", trim: true },
    registeredAddress: { type: String, default: "", trim: true },
    intro: { type: String, default: "" },
    sections: [SectionSchema],
    footerNote: { type: String, default: "" },
    updatedBy: { type: ObjectId, ref: "User" }
  },
  { timestamps: true }
);

module.exports = model("AgreementTemplate", AgreementTemplateSchema);
