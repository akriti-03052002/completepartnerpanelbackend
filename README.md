# SPOTX Partner Platform — Backend

One Express API and one MongoDB database for all four partner types — **Influencer, Affiliate, Vendor and Reseller** — plus the admin panel, vendor customers and reseller customers. Deployed on **Render**. This is its own repository; the web app that talks to it is a separate repository, deployed on Vercel.

## Structure

```text
.
├─ config/        database connection, partner types, roles and permissions
├─ controller/    request handlers (shared, and per partner type)
├─ middleware/    partner / admin / customer auth, partner-type guards, uploads
├─ models/        Mongoose models — one Partner model, `partnerType` decides the rest
├─ router/        the API route tree
├─ services/      agreements, commissions, settlements, social sync, reseller billing
├─ utils/         mail, Razorpay, file storage, encryption, logging
├─ validations/   request validation for the auth routes
├─ seed/          admin / tier seed scripts
├─ test/          automated tests
└─ index.js       the API process
```

## How each partner type works

A partner is one record in the `partners` collection. Its `partnerType` — chosen at sign-up and never changed — decides which features it gets. The API enforces this on every request; hiding a menu in the web app is never the only protection.

### Steps every partner goes through

1. **Sign up** — `POST /api/partner/auth/send-otp` emails a 6-digit code, `verify-otp` confirms the email, `register` creates the partner (type, name, email, phone, password) and its owner login.
2. **Complete the profile** — `PATCH /api/partner/profile`. Business (or creator) name and address.
3. **Upload KYC documents** — `POST /api/partner/documents`. Everyone needs a PAN card and a cancelled cheque. GST and MSME / Udyam certificates depend on the type: **compulsory** for Vendor and Reseller; **optional** for Affiliate (may be uploaded, never needed for verification); **not applicable** to Influencer — the documents are not shown and the API refuses them. This is about the *documents* only: GST itself still applies to an Influencer's payouts (see "Getting paid").
4. **Add a bank account and prove it** — `PUT /api/partner/bank`, then a ₹1 Razorpay payment (`/bank/verify`, `/bank/verify/confirm`).
5. **Admin review** — an admin verifies each document and the bank account. When the last one is verified the partner becomes **active** automatically and its **agreement** is generated.

Until a partner is active, everything except profile, documents, bank, dashboard and notifications answers `403` with `locked: true`.

Every active partner, whatever its type, can also invite teammates with a role (`/api/partner/team`) and read its notifications.

### Influencer — paid per approved post or reel

1. Adds a social account (Instagram, Facebook or YouTube): manually with `POST /api/partner/social/accounts`, or by connecting it with OAuth (`/api/partner/social/:platform/start`).
2. An admin **verifies** the account and sets its **price per post and per reel** (`/api/admin/social-media/accounts/...`). Each price change reissues the influencer's agreement, which lists the rates.
3. The influencer submits the link to a published post or reel (`POST /api/partner/social/posts`). Only verified accounts can be used and the same link cannot be submitted twice.
4. An admin approves or rejects it (`/api/admin/social-media/posts/:id/review`). Approval creates an **earning** for that account's rate.
5. Earnings are paid through settlements (see *Getting paid* below).

**Agreement:** the shared Influencer template, editable by an admin at `/api/admin/config/agreement-template`, filled in with this influencer's accounts and rates.

### Affiliate — a reward for each lead SPOTX closes

1. Submits a lead: the customer's company and how many screens they need (`POST /api/partner/referrals`).
2. SPOTX's own team works the lead. An admin marks it **contacted**, then **won** or **rejected** (`/api/admin/leads/:id/...`).
3. On **won**, the admin enters the plan, the screens sold and a one-time **Referral Reward**. That creates the reward in the affiliate's ledger. The affiliate sees the reward but never SPOTX's deal value.
4. Rewards are paid through settlements.

**Agreement:** Referral Reward terms — a reward decided per won deal, nothing payable on rejected or lost leads.

### Vendor — commission on customers it brings in

1. An admin assigns the vendor's **commission** (percentage, fixed per deal, per screen, recurring or hybrid) at `POST /api/admin/partners/:id/commission-assignment`. This issues the vendor's agreement.
2. On activation the vendor gets a **customer referral code**. Customers arrive in two ways: the vendor registers them (`POST /api/partner/customers`, the customer is emailed a link to set a password), or they register themselves with the code (`POST /api/public/customers/register`).
3. Each customer starts a 30-day trial, then subscribes from their own panel: plan, number of screens and term, paid through Razorpay (`/api/customer/subscription/checkout` and `/verify`). An admin can also record a payment received outside the gateway (`/api/admin/customers/:id/mark-paid`).
4. Every confirmed payment issues the customer an invoice. Commission is worked out **per customer**, on what that customer paid before GST. How often depends on the type the admin assigned. A **one-time** type (percentage, fixed per customer, per screen, hybrid) is earned once per customer, on their **first payment only**: 50 screens at ₹999 = ₹49,950, so at 10% the vendor earns ₹4,995. Nothing after that earns again — not renewals, and not screens the customer adds later. A **recurring** type (recurring percentage, recurring fixed) is earned on every payment. A customer who registered but never paid earns nothing.
5. Commissions are paid through settlements. Because a vendor is GST-registered, each settlement waits on hold until the vendor uploads a **bill** for it and an admin verifies it.

**Agreement:** commission terms taken from the rule or custom commission configured for that vendor.

### Reseller — buys licenses and pays SPOTX

A reseller earns no commission; money flows the other way. It has no commissions or settlements.

1. An admin sets the reseller's **pricing plan** (discount off the standard price, or a fixed price, with a minimum quantity and tax rate) and **billing cycle**, then a one-time **prepayment** amount (`/api/admin/reseller/partners/:id/...`).
2. The reseller pays the prepayment (`/api/partner/reseller/prepayment/pay` and `/verify`). Nothing can be bought before that.
3. The reseller **requests licenses** (`POST /api/partner/reseller/license-orders`). An admin accepts or rejects the request. Accepting adds the licenses to the reseller's inventory.
4. The reseller adds its own **customers** — itself, or by sharing a referral link where the customer registers and verifies their email — and **allocates** licenses to each (`/api/partner/reseller/allocations`). It can release, suspend, reactivate or cancel an allocation.
5. Each reseller customer signs in to their own portal and **registers screens** up to their allocation (`/api/customer-portal/screens`). They never see pricing or billing.
6. **Every purchase is its own bill**, with its own billing cycle starting on the day it was bought (`services/resellerBilling.js`). Example: 200 licenses at ₹300 per screen per month, bought on 6 Oct 2026 on a quarterly cycle, is ₹60,000 a month and ₹7,20,000 + GST for the 12-month term, paid as four bills of ₹1,80,000 + GST raised on 6 Oct, 6 Jan, 6 Apr and 6 Jul. The first is raised the day the request is accepted; each later one on the first day of the cycle it covers (the daily job, or "Run Reseller Billing Now"). Buying more licenses later creates a **new** bill at that day's price with its own dates; purchases are never merged. Price, tax rate and cycle are locked on the purchase, and billing carries on cycle after cycle while the licenses are held. `GET /api/partner/reseller/invoices/current-due` returns every bill with its instalments. The reseller pays an invoice online, or an admin records an offline payment; `dueDays` is how long they have. An invoice left overdue past the grace period blocks new purchases and allocations until it is paid.

**Agreement:** license purchase and invoicing terms with the reseller's live pricing and billing table, reissued whenever an admin changes them. No commission wording.

### Getting paid (Influencer, Affiliate, Vendor)

There is no "create settlement" step. The admin does two things: **approve**, then **pay**.

1. Each reward or commission starts **pending**; a finance admin **approves** it. An influencer's earning is approved together with its post or reel.
2. Approval puts it **straight into a settlement** that is already approved and ready to pay (`services/autoSettlement.js`). If that partner already has an unpaid settlement with no bill against it, the new item joins it and the total is recalculated; otherwise a new settlement is opened. The partner sees it immediately.
3. Putting a commission on hold, or reversing it, takes it back out of its unpaid settlement (an emptied settlement is cancelled).
4. The settlement is **marked paid** one of three ways: offline with a reference number; from a Razorpay payment ID; or from a RazorpayX payout ID (`pout_…`), which is accepted only if the payout was processed, for the right amount, to that partner's bank account.
5. A settlement is put **on hold** automatically when it cannot safely be paid: the bank account is unverified or was just changed, the partner is suspended, or a GST bill is still needed (vendors). **GST applies to every paid type, Influencer included:** any of them can submit a bill with their GSTIN for a settlement (`POST /api/partner/settlements/:id/bill`), and once an admin verifies it GST at the configured rate is added to what is paid. For an Influencer or Affiliate this is optional and needs no GST certificate; for a Vendor it is compulsory. Once a bill is submitted the settlement's amount is fixed, so anything approved later opens a new one.

Commissions that were approved before this became automatic are given a settlement the next time the server starts.

### What only some types can call

| API | Influencer | Affiliate | Vendor | Reseller |
| --- | :-: | :-: | :-: | :-: |
| `/api/partner/social/*` | yes | – | – | – |
| `/api/partner/referrals`, `/api/partner/opportunities` | – | yes | – | – |
| `/api/partner/customers` | – | – | yes | – |
| `/api/partner/commissions`, `/api/partner/settlements` | yes | yes | yes | – |
| `/api/partner/reseller/*` | – | – | – | yes |

A call from the wrong type answers `403`.

### Other rules worth knowing

- **Agreements differ per type** and must stay distinct. Each is its own form, with its own name, opening paragraph and a "How payment works" box saying which way money moves: **Influencer Agreement** (paid per approved post or reel, from the editable template), **Affiliate Referral Agreement** (SPOTX pays a one-time reward for each lead it closes as a won deal), **Vendor Commission Agreement** (SPOTX pays commission on what the vendor's customers pay), **Reseller Licence Purchase Agreement** (the reseller pays SPOTX's invoices and earns no commission). The forms are `AGREEMENT_FORMS` in `services/generatePartnerAgreement.js`. For Vendor, Affiliate and Reseller an admin can also override any section for one partner and reissue the PDF (`/api/admin/partners/:id/agreement-terms`).
- **Bank changes:** an Influencer, Affiliate or Vendor who changes a verified account has payouts held until the new one is verified. A Reseller's change is staged instead: it pays ₹1 from the new account, and the change applies only when an admin approves it.
- **Partner notifications:** a partner is told about everything that happens to its own kind of work, through `utils/notifyPartner.js`. Affiliate: lead submitted, contacted, won (with the reward) or rejected. Influencer: social account submitted, verified or rejected, rates set, post / reel submitted, approved or rejected. Vendor: customer registered, commission earned on each payment, subscription cancelled or expired. Reseller: prepayment, license request submitted, approved or rejected, inventory adjusted, invoice raised, paid or failed, customer signed up. The types that get paid are also told when an earning is approved, held or reversed and when a settlement is created, approved, held, released, failed, retried or paid — worded as "content earning", "referral reward" or "commission" to match the type. Every type hears about KYC, bank, agreement, account-status and team changes.
- **Per-type overview:** `GET /api/admin/stats/type/:partnerType` gives one type's quick overview, also computed live: its partner counts, what is waiting on SPOTX (posts and accounts to approve, new leads, licence requests, unpaid invoices), and its earnings paid and still to pay (none for a Reseller). `GET /api/admin/social-media/posts?partnerId=` narrows post / reel review to one influencer.
- **Admin dashboard:** `GET /api/admin/stats/dashboard` computes every figure live from the records — nothing is stored or hardcoded. Money in: Reseller = licence invoices and prepayments paid; Vendor = what their customers paid for subscriptions (before GST); Affiliate = the value of deals won from their leads. Money out: commission, referral rewards and content payments, split into paid and still to pay. Partner counts: by type and status, plus "KYC pending" (not every document required for the type is verified) and "bank pending" (no verified bank account), both excluding rejected and inactive partners.
- **Admin notifications:** sign-ups, KYC uploads, bank submissions, leads, bills and social / content submissions from every type, addressed to the admin roles that can act on them.

## Setup

Requirements: Node.js 22.12+ and a MongoDB database (a replica set / Atlas — transactions are used).

```powershell
npm install
Copy-Item .env.example .env   # then fill it in
npm run seed:admin -- "Admin Name" admin@example.com "strong-password"
npm run dev
```

The API listens on `PORT` (default 5000). Health check: `GET /health`.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `MONGO_URI` | yes | The one database for everything |
| `JWT_SECRET` | yes | Partner sessions and vendor-customer sessions |
| `ADMIN_JWT_SECRET` | yes | Admin sessions |
| `CUSTOMER_JWT_SECRET` | yes | Reseller-customer portal sessions |
| `BANK_ENC_KEY` | yes | 64 hex characters; encrypts bank account numbers |
| `CLIENT_URL` | yes | The frontend's address — used in emailed links |
| `CLIENT_URLS` | yes | Comma-separated origins allowed to call the API (CORS) |
| `API_PUBLIC_URL` | for social login | This API's public address, for OAuth callbacks |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | yes | File storage (see below) |
| `CLOUDINARY_FOLDER` | no | Folder name inside Cloudinary |
| `SMTP_USER`, `SMTP_PASS` | for email | Gmail address and a Google App Password. Without them, emails (OTPs, links) are only printed to the server log |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | for payments | Bank ₹1 check, customer subscriptions, reseller payments |
| `RAZORPAYX_KEY_ID`, `RAZORPAYX_KEY_SECRET`, `RAZORPAYX_ACCOUNT_NUMBER` | no | Payout verification; falls back to the Razorpay keys |
| `INSTAGRAM_*`, `META_*`, `GOOGLE_*` | no | Influencer social login. Without them, influencers enter accounts manually |

Never commit `.env`. On Render, set these in the service's Environment settings.

### File storage

Every KYC document, settlement bill and agreement PDF is stored in **Cloudinary** as a private file — nothing is kept on the server's disk. Uploads pass through the system temp folder only while being sent on, and agreement PDFs are generated in memory. Without the Cloudinary variables, uploads return an error and agreements cannot be issued. Files are served only through this API, to a signed-in partner or admin.

## Tests

```powershell
npm test
```

- `test/partnerPlatform.test.js` — fast checks of the rules that keep the partner types apart.
- `test/e2e.test.js` — every partner type end to end through the real API (sign-up with OTP, KYC, activation, each type's own flow, settlements and payouts, bank-change approval, the Razorpay webhook, admin endpoints).

The end-to-end suite starts its own in-memory MongoDB and stubs email, Cloudinary and Razorpay, so it never touches a real database or account and needs no `.env`. The first run downloads a MongoDB binary.

## Deploying to Render

`render.yaml` in this repository describes the service.

1. In Render, create a **Blueprint** from this repository, or a **Web Service** with build command `npm ci`, start command `npm start`, health check path `/health` (leave Root Directory empty).
2. Set the environment variables above. `CLIENT_URL` / `CLIENT_URLS` must be the Vercel address of the frontend.
3. In Razorpay, point the webhook at `https://<your-render-service>/api/webhooks/razorpay` and use the same secret as `RAZORPAY_WEBHOOK_SECRET`.
4. For social login, register `https://<your-render-service>/api/partner/social/{instagram|facebook|youtube}/callback` with each provider.

Request logs are written to the console and to `logs/<date>.log`.


### Scaling API instances

Admin leads and social posts accept `page` and `limit` (default 50, maximum 100) and return `pagination` metadata. Leads also return whole-partner status summaries; social posts return status counts. The frontend uses these summaries for overview totals. Social review search and dropdown filters apply to the current page.

Authentication, OTP and customer checkout limiters share atomic MongoDB counters across instances. Their collection has a TTL index to clean expired counters; window resets do not depend on TTL cleanup timing. All instances must use the same database. This adds a database write per rate-limited request.

Social synchronization now uses a shared database lease, like billing, and streams partners through a cursor. Jobs still execute inside API processes; a dedicated worker and durable retry queue remain future improvements for heavier workloads.

Run `node --test test/scalability.test.js` to verify pagination totals, shared counter concurrency, counter expiry, lease exclusion and social credential handling. Capacity has not been load-tested. Existing health endpoints and request timing logs help inspect behavior, but production latency percentiles, error-rate alerts and realistic load tests are still required before setting a capacity target.


### Individual vendor commissions

Vendors now earn strictly from their active `PartnerCommissionAssignment`. Vendor tier and generic rules are ignored, and the agreement uses the same assignment. Configure each vendor's commission from their admin partner record before processing customer payments. Missing assignments stop commission generation with an explicit error; no fallback rate is inferred. Existing ledger entries, settlements and stored tier records are preserved. Active agreements are not automatically rewritten: reissue them through the existing admin action if their wording needs updating.

Vendor activation and customer payment/subscription changes still refresh screen counts, but no longer assign tiers. The public vendor description now describes individually assigned terms, and admin configuration contains only Screen Pricing.
