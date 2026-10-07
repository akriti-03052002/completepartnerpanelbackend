const assert = require("node:assert/strict");
const test = require("node:test");
process.env.GOOGLE_CLIENT_ID = "test-google-client";
process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
process.env.JWT_SECRET = "test-social-state";
const { startConnection } = require("../controller/partnerSocialController");
test("YouTube OAuth callback uses the public API origin without duplicate slashes", () => {
  process.env.API_PUBLIC_URL = "https://completepartnerpanelbackend.onrender.com/";
  let response;
  startConnection({ params: { platform: "youtube" }, partner: { _id: "test-partner" }, query: {} }, { json: value => { response = value; } });
  const url = new URL(response.url);
  assert.equal(url.searchParams.get("redirect_uri"), "https://completepartnerpanelbackend.onrender.com/api/partner/social/youtube/callback");
  assert.equal(url.searchParams.get("client_id"), "test-google-client");
});
