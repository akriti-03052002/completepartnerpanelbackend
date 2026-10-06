const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";

const getKey = () => {
  const key = process.env.BANK_ENC_KEY;

  if (!key || key.length !== 64) {
    throw new Error(
      "BANK_ENC_KEY must be set in .env as a 64-character hex string (32 bytes)."
    );
  }

  return Buffer.from(key, "hex");
};

/**
 * Encrypts plaintext into a single "iv:authTag:ciphertext" hex string.
 */
const encrypt = (plaintext) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);

  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  return [iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")].join(":");
};

/**
 * Reverses encrypt(). Throws if the payload was tampered with or the
 * key is wrong (GCM auth tag check fails).
 */
const decrypt = (payload) => {
  const [ivHex, authTagHex, dataHex] = String(payload).split(":");

  if (!ivHex || !authTagHex || !dataHex) {
    throw new Error("Invalid encrypted payload format.");
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
};

const maskAccountNumber = (accountNumber) => accountNumber.slice(-4);

const maskIfsc = (ifsc) => ifsc.slice(0, 4) + "XXXXXXX".slice(0, Math.max(0, ifsc.length - 5)) + ifsc.slice(-1);

module.exports = {
  encrypt,
  decrypt,
  maskAccountNumber,
  maskIfsc
};
