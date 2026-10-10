const mongoose = require("mongoose");

let pendingConnection;
const connectDB = async () => {
  if (mongoose.connection.readyState === 1) return mongoose;
  if (!pendingConnection) {
    pendingConnection = mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 })
      .then(() => { console.log("MongoDB Connected"); return mongoose; })
      .finally(() => { pendingConnection = undefined; });
  }
  return pendingConnection;
};

module.exports = connectDB;
