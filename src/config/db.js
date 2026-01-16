const mongoose = require("mongoose");

authenticateEnv();

function authenticateEnv() {
  // Throw early if MONGO_URI missing to avoid silent failures.
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is not set in environment variables.");
  }
}

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log(`MongoDB connected: ${conn.connection.name}`);
  } catch (error) {
    console.error("MongoDB connection error:", error);
    throw error;
  }
};

module.exports = { connectDB };
