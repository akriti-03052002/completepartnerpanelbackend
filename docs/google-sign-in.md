# Google registration and login

Google sign-in is available on partner registration/login, vendor customer
registration/login, and reseller customer registration/login. Existing email
and password flows continue to work.

## Configuration

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the backend environment,
locally and on Vercel. These belong to the same Google OAuth **Web application**
client. The secret stays on the backend; no Google secret belongs in Vite variables.

In Google Cloud → Google Auth Platform → Clients → this Web client, add the
exact frontend origins to **Authorized JavaScript origins**, including
`http://localhost`, your development origin (such as `http://localhost:5173`),
and production/testing frontend origins. Use origins without paths or trailing
slashes. Google does not support wildcard preview origins; register each
testing origin you use or use a stable testing domain.

Keep existing redirect URIs used for YouTube account connections. Add these
exact entries to **Authorized redirect URIs** for sign-in:

```
https://completepartnerpanelfrontend.vercel.app/api/auth/google/callback
http://localhost:5173/api/auth/google/callback
```

Add the corresponding callback for each preview origin you actually use, such as
`https://completepartnerpanelfrontend-git-main-aj-6bf9.vercel.app/api/auth/google/callback`.
The callback uses the frontend's API proxy so its cookie remains first-party.
Set `CLIENT_URL` to the primary frontend and `CLIENT_URLS` to the comma-separated
allowed frontend origins. Configure Branding/Audience
for the intended users; while the consent application is in Testing, add
test users as required by the Google project's configuration.

Deploy both backend and frontend after the environment is configured.

## Behavior

- Google proves the email address; new accounts don't need email OTP or a
  password. Partners still choose their type and provide a phone number.
- Vendor/reseller customers still need a valid referral code and company name.
  Google does not approve a partner, allocate screens, or activate subscriptions.
- New Google-only users can set a password later through the existing password
  recovery flow. Existing passwords are preserved when linking Google.
- Existing accounts link automatically only when Google is authoritative for
  the verified email (Gmail or a Google Workspace hosted domain). Other existing
  email accounts must use their password or contact support before linking.
- Subsequent Google logins match the Google subject ID. Conflicting identities,
  blocked partners, and suspended/cancelled customers are refused.
- Google credentials are verified on the backend with Google's library, including
  audience, issuer, signature, expiry and a nonce. Existing portal sessions and
  authentication rate limits are retained.
- The Google button opens Google's account chooser in the same tab. It no longer
  loads the GIS popup/FedCM library responsible for popup COOP and native nonce
  deprecation warnings. All three account types use the same redirect.
- Redirect attempts expire after ten minutes, bind to an HttpOnly cookie, and use
  one-time state, PKCE and nonce verification. Temporary ID tokens are encrypted
  and consumed once. Passwords are excluded from the registration fields saved
  temporarily in the current tab's session storage.

## Validation

`node --test test/googleAuth.test.js` exercises the real API routes and a temporary
database with Google's remote verification stubbed. It covers invalid credentials,
nonce mismatches, signup, referrals, existing account linking, duplicate registration,
cookie sessions, unchanged passwords, and unavailable accounts. A browser login
with a real Google account is still needed to verify the project's Google Cloud
origin and consent configuration.
