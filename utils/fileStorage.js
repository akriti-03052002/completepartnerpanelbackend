const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const cloudinary = require("cloudinary").v2;

/* ============================================================
   FILE STORAGE — CLOUDINARY ONLY
   Every uploaded KYC document, settlement bill and generated
   agreement PDF (for every partner type) is stored in Cloudinary.
   Nothing is kept on this server's disk: an upload passes through
   a temp file only for as long as it takes to send it on, and
   generated PDFs go straight from memory.

   Files are uploaded as private "raw" assets: they have no public
   URL, and are only ever fetched by this backend with a short-lived
   signed link, then streamed to the signed-in user.
============================================================ */

// Where multer parks an upload while it is being sent to Cloudinary.
const TEMP_UPLOAD_DIR = path.join(os.tmpdir(), "spotx-partner-uploads");

const ROOT_FOLDER = process.env.CLOUDINARY_FOLDER || "spotx-partner-platform";

class FileStorageError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 503;
  }
}

const isCloudinaryConfigured = () =>
  Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

let configured = false;
const client = () => {
  if (!isCloudinaryConfigured()) {
    throw new FileStorageError("File storage isn't configured — set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.");
  }
  if (!configured) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true
    });
    configured = true;
  }
  return cloudinary;
};

const UPLOAD_OPTIONS = { resource_type: "raw", type: "private", overwrite: false };

// ("<partnerId>/bills", "1700000-123.pdf") -> "spotx-partner-platform/partners/<partnerId>/bills/1700000-123.pdf"
const publicIdFor = (subfolder, filename) =>
  [ROOT_FOLDER, "partners", subfolder, filename].join("/").replace(/\\/g, "/");

const removeTempFile = (filePath) => fs.promises.unlink(filePath).catch(() => {});

/**
 * Sends a file multer just received to Cloudinary and returns the `file`
 * shape saved on PartnerDocument / PartnerSettlementBill. `subfolder` is
 * "<partnerId>" or "<partnerId>/bills". The temp copy is always removed,
 * whether the upload succeeded or not.
 */
const storeUploadedFile = async (multerFile, subfolder) => {
  try {
    const header = Buffer.alloc(8);
    const handle = await fs.promises.open(multerFile.path, "r");
    try { await handle.read(header, 0, 8, 0); } finally { await handle.close(); }
    const detected = header.subarray(0, 5).toString() === "%PDF-" ? "application/pdf"
      : header.equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png"
      : header[0] === 255 && header[1] === 216 && header[2] === 255 ? "image/jpeg" : null;
    if (!detected || detected !== multerFile.mimetype) {
      const error = new Error("The file contents do not match a supported PDF, PNG or JPG. Choose a valid document.");
      error.statusCode = 400;
      throw error;
    }
    const result = await client().uploader.upload(multerFile.path, {
      ...UPLOAD_OPTIONS,
      public_id: publicIdFor(subfolder, multerFile.filename)
    });
    return {
      storageProvider: "cloudinary",
      objectKey: result.public_id,
      originalName: multerFile.originalname,
      mimeType: multerFile.mimetype,
      size: multerFile.size
    };
  } finally {
    removeTempFile(multerFile.path);
  }
};

/** Stores a generated file (e.g. an agreement PDF) straight from memory. */
const storeBuffer = async (buffer, { subfolder, filename, originalName, mimeType }) => {
  const uploader = client().uploader;
  const result = await new Promise((resolve, reject) => {
    const stream = uploader.upload_stream(
      { ...UPLOAD_OPTIONS, public_id: publicIdFor(subfolder, filename) },
      (error, uploaded) => (error ? reject(error) : resolve(uploaded))
    );
    Readable.from(buffer).pipe(stream);
  });
  return { storageProvider: "cloudinary", objectKey: result.public_id, originalName, mimeType, size: buffer.length };
};

/**
 * Streams a stored file to the client as a download. Returns false when the
 * file can't be found, so the caller can send a 404.
 */
const sendStoredFile = async (res, file) => {
  if (!file?.objectKey) return false;

  // Cloudinary is the only place a file can be.
  if (file.storageProvider !== "cloudinary") return false;

  const url = client().utils.private_download_url(file.objectKey, "", {
    resource_type: "raw",
    type: "private",
    expires_at: Math.floor(Date.now() / 1000) + 60
  });
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`sendStoredFile: Cloudinary returned ${response.status} for ${file.objectKey}`);
    return false;
  }
  res.setHeader("Content-Type", file.mimeType || response.headers.get("content-type") || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(file.originalName || "document")}"`);
  res.send(Buffer.from(await response.arrayBuffer()));
  return true;
};

/** Mounted before multer on upload routes, so an unconfigured server says so up front. */
const requireFileStorage = (req, res, next) => {
  if (!isCloudinaryConfigured()) {
    return res.status(503).json({
      success: false,
      message: "File uploads are unavailable — Cloudinary storage isn't configured on the server."
    });
  }
  next();
};

module.exports = {
  FileStorageError,
  isCloudinaryConfigured,
  requireFileStorage,
  storeUploadedFile,
  storeBuffer,
  sendStoredFile,
  TEMP_UPLOAD_DIR
};
