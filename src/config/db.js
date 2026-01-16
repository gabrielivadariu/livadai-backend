const mongoose = require("mongoose");

authenticateEnv();

function authenticateEnv() {
  // Throw early if DB_URL missing to avoid silent failures.
  if (!process.env.DB_URL) {
    throw new Error("DB_URL is not set in environment variables.");
  }
}

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.DB_URL);
    console.log(`MongoDB connected: ${conn.connection.name}`);
  } catch (error) {
    console.error("MongoDB connection error:", error);
    throw error;
  }
};

module.exports = { connectDB };
