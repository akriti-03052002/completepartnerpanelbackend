const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { TEMP_UPLOAD_DIR } = require("../utils/fileStorage");

const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg"
];

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

// Uploads are never kept on this server: multer parks the file in the OS
// temp folder just long enough for the controller to send it to Cloudinary
// (utils/fileStorage.storeUploadedFile), which then deletes the temp copy.
// Which partner / folder it belongs to is decided there, not here — so one
// storage config serves KYC documents (partner or admin upload) and
// settlement bills alike.
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });

    cb(null, TEMP_UPLOAD_DIR);
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);

    cb(null, `${unique}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(new Error("Only PDF, PNG and JPG files are allowed."));
  }

  cb(null, true);
};

const createUpload = () => multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE }
});

// A partner uploading their own KYC document.
const uploadDocument = createUpload();

// An admin uploading on a partner's behalf (e.g. when onboarding one
// directly) — the partnerId comes from the route params.
const uploadDocumentAsAdmin = createUpload();

// A partner's settlement bill — stored under its own "bills" subfolder so
// it doesn't mix with KYC documents.
const uploadBill = createUpload();

module.exports = { uploadDocument, uploadDocumentAsAdmin, uploadBill };
