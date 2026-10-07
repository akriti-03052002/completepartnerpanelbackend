const { Partner } = require("../models/Index");
const { decrypt, encrypt } = require("../utils/encryption");

/* ============================================================
   SOCIAL ACCOUNT SYNC
   After an influencer connects Instagram/Facebook/YouTube once, the
   stored token is used to refresh their follower count without them
   logging in again. Instagram tokens last 60 days and are renewed
   here before they run out; Facebook Page tokens don't expire;
   YouTube access tokens last an hour and are re-minted from the
   stored Google refresh token.
============================================================ */

const META_VERSION = process.env.META_GRAPH_VERSION || "v21.0";

// Accounts older than this are refreshed automatically when viewed.
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
// Renew an Instagram token once it has less than this left.
const RENEW_BEFORE_MS = 15 * 24 * 60 * 60 * 1000;

const fetchJson = async (url, options) => {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error?.message || data.error_description || (typeof data.error === "string" ? data.error : "") || "Social provider request failed.");
    // Meta 190 / Google invalid_grant = the token is invalid, expired, or
    // the user removed access — only reconnecting fixes it.
    error.tokenInvalid = data.error?.code === 190 || data.error === "invalid_grant";
    throw error;
  }
  return data;
};

const expiryFrom = (expiresIn) => (expiresIn ? new Date(Date.now() + Number(expiresIn) * 1000) : undefined);

const fetchInstagramProfile = (accessToken) =>
  fetchJson(`https://graph.instagram.com/${META_VERSION}/me?fields=user_id,username,followers_count&access_token=${encodeURIComponent(accessToken)}`)
    .then((data) => ({ accountId: String(data.user_id || data.id), username: data.username || "", followers: Number(data.followers_count || 0) }));

const fetchFacebookPage = (pageId, pageToken) =>
  fetchJson(`https://graph.facebook.com/${META_VERSION}/${pageId}?fields=id,name,followers_count,fan_count&access_token=${encodeURIComponent(pageToken)}`)
    .then((page) => ({ accountId: page.id, username: page.name || "", followers: Number(page.followers_count ?? page.fan_count ?? 0) }));

const fetchYouTubeChannel = (accessToken) =>
  fetchJson("https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true", { headers: { Authorization: `Bearer ${accessToken}` } })
    .then((data) => {
      const channel = data.items?.[0];
      if (!channel) throw new Error("No YouTube channel was found for this Google account.");
      return { accountId: channel.id, username: channel.snippet?.title || "", followers: Number(channel.statistics?.subscriberCount || 0) };
    });

const refreshGoogleToken = async (refreshToken) => {
  const data = await fetchJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });
  return { accessToken: data.access_token, tokenExpiresAt: expiryFrom(data.expires_in) };
};

const refreshInstagramToken = async (accessToken) => {
  const data = await fetchJson(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(accessToken)}`);
  return { accessToken: data.access_token, tokenExpiresAt: expiryFrom(data.expires_in) };
};

/**
 * Fetches fresh profile data for one connected account (renewing its token
 * first if needed) and writes the result straight to that array element, so
 * no other account's stored token is touched.
 */
const syncSocialAccount = async (partnerId, accountId) => {
  const partner = await Partner.findById(partnerId).select("+socialAccounts.accessTokenEncrypted +socialAccounts.refreshTokenEncrypted");
  const account = partner?.socialAccounts.id(accountId);
  if (!account) throw new Error("Social account not found.");
  if (!account.connected || !account.accessTokenEncrypted) {
    throw new Error("This account isn't connected. Connect it again to refresh it automatically.");
  }

  const set = {};
  try {
    let accessToken = decrypt(account.accessTokenEncrypted);
    let profile;

    if (account.platform === "instagram") {
      if (account.tokenExpiresAt && account.tokenExpiresAt.getTime() - Date.now() < RENEW_BEFORE_MS) {
        const renewed = await refreshInstagramToken(accessToken);
        accessToken = renewed.accessToken;
        set["socialAccounts.$.accessTokenEncrypted"] = encrypt(accessToken);
        set["socialAccounts.$.tokenExpiresAt"] = renewed.tokenExpiresAt;
      }
      profile = await fetchInstagramProfile(accessToken);
    } else if (account.platform === "facebook") {
      profile = await fetchFacebookPage(account.accountId, accessToken);
    } else if (account.platform === "youtube") {
      // Google access tokens only last an hour; mint a fresh one from the
      // stored refresh token whenever the current one is (nearly) expired.
      if (!account.tokenExpiresAt || account.tokenExpiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
        if (!account.refreshTokenEncrypted) {
          const error = new Error("YouTube access expired. Connect it again to keep it updating.");
          error.tokenInvalid = true;
          throw error;
        }
        const renewed = await refreshGoogleToken(decrypt(account.refreshTokenEncrypted));
        accessToken = renewed.accessToken;
        set["socialAccounts.$.accessTokenEncrypted"] = encrypt(accessToken);
        set["socialAccounts.$.tokenExpiresAt"] = renewed.tokenExpiresAt;
      }
      profile = await fetchYouTubeChannel(accessToken);
    } else {
      throw new Error("Automatic refresh isn't available for this platform.");
    }

    Object.assign(set, {
      "socialAccounts.$.username": profile.username,
      "socialAccounts.$.followers": profile.followers,
      "socialAccounts.$.lastSyncedAt": new Date(),
      "socialAccounts.$.syncError": ""
    });
  } catch (error) {
    set["socialAccounts.$.syncError"] = error.message;
    if (error.tokenInvalid) set["socialAccounts.$.connected"] = false;
    await Partner.updateOne({ _id: partnerId, "socialAccounts._id": accountId }, { $set: set });
    throw error;
  }

  await Partner.updateOne({ _id: partnerId, "socialAccounts._id": accountId }, { $set: set });
  return Partner.findById(partnerId).select("socialAccounts").then((p) => p.socialAccounts.id(accountId));
};

/** Refreshes every connected account of this partner that's gone stale. Never throws. */
const syncStaleAccounts = async (partner) => {
  const stale = (partner.socialAccounts || []).filter((account) =>
    account.connected &&
    ["instagram", "facebook", "youtube"].includes(account.platform) &&
    (!account.lastSyncedAt || Date.now() - account.lastSyncedAt.getTime() > STALE_AFTER_MS)
  );
  await Promise.allSettled(stale.map((account) => syncSocialAccount(partner._id, account._id)));
  return stale.length > 0;
};

/** Background sweep over all partners — keeps admin views fresh too. */
const syncAllStaleAccounts = async () => {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS);
  const partners = await Partner.find({
    socialAccounts: { $elemMatch: { connected: true, $or: [{ lastSyncedAt: { $lt: cutoff } }, { lastSyncedAt: { $exists: false } }] } }
  }).select("socialAccounts").cursor();
  for await (const partner of partners) {
    // eslint-disable-next-line no-await-in-loop
    await syncStaleAccounts(partner);
  }
};

module.exports = {
  fetchInstagramProfile,
  fetchFacebookPage,
  fetchYouTubeChannel,
  expiryFrom,
  syncSocialAccount,
  syncStaleAccounts,
  syncAllStaleAccounts,
  STALE_AFTER_MS
};
