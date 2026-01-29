require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const { connectDB } = require("./src/config/db");
const authRoutes = require("./src/routes/auth.routes");
const experienceRoutes = require("./src/routes/experience.routes");
const bookingRoutes = require("./src/routes/booking.routes");
const messageRoutes = require("./src/routes/message.routes");
const notificationsRoutes = require("./src/routes/notifications.routes");
const paymentRoutes = require("./src/routes/payment.routes");
const walletRoutes = require("./src/routes/wallet.routes");
const geoRoutes = require("./src/routes/geo.routes");
const hostsRoutes = require("./src/routes/hosts.routes");
const mediaRoutes = require("./src/routes/media.routes");
const uploadRoutes = require("./src/routes/upload.routes");
const { router: stripeRouter, webhookRouter } = require("./src/routes/stripe.routes");
const healthRoutes = require("./src/routes/health.routes");
const reportRoutes = require("./src/routes/report.routes");
const pushRoutes = require("./src/routes/push.routes");
const userRoutes = require("./src/routes/user.routes");
const adminRoutes = require("./src/routes/admin.routes");
const setupReminderJob = require("./src/jobs/reminders");
const setupCleanupJob = require("./src/jobs/cleanup");
const setupAttendanceJob = require("./src/jobs/attendance");
const setupReconcilePaymentsJob = require("./src/jobs/reconcilePayments");
const setupChatArchiveJob = require("./src/jobs/chat-archive");
const setupRefundRetryJob = require("./src/jobs/refund-retry");
const setupFavoritesCleanupJob = require("./src/jobs/favorites-cleanup");

const app = express();
const PORT = process.env.PORT || 4000;

// Stripe webhook must remain before JSON body parsing so signature verification works
app.use("/stripe", webhookRouter);

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.use("/health", healthRoutes);
app.use("/auth", authRoutes);
app.use("/experiences", experienceRoutes);
app.use("/bookings", bookingRoutes);
app.use("/messages", messageRoutes);
app.use("/notifications", notificationsRoutes);
app.use("/payments", paymentRoutes);
app.use("/wallet", walletRoutes);
app.use("/geo", geoRoutes);
app.use("/hosts", hostsRoutes);
app.use("/media", mediaRoutes);
app.use("/upload", uploadRoutes);
app.use("/stripe", stripeRouter);
app.use("/reports", reportRoutes);
app.use("/push", pushRoutes);
app.use("/users", userRoutes);
app.use("/admin", adminRoutes);

app.use((req, res) => {
  res.status(404).json({ message: "Not found" });
});

const start = async () => {
  try {
    await connectDB();
    app.listen(PORT, () => console.log(`API running on port ${PORT}`));
    setupReminderJob();
    setupCleanupJob();
    setupAttendanceJob();
    setupReconcilePaymentsJob();
    setupChatArchiveJob();
    setupFavoritesCleanupJob();
    setupRefundRetryJob();
  } catch (err) {
    console.error("Server start failed", err);
    process.exit(1);
  }
};

start();
