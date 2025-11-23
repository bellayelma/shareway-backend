const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
});

const db = admin.firestore();

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ status: "ShareWay Backend is running!" });
});

const PORT = process.env.PORT || 3000;

// Export db before requiring routes to avoid circular dependencies
module.exports = { app, db, admin };

// Import and use routes AFTER exporting
const matchRoutes = require("./routes/match");
const userRoutes = require("./routes/user");

app.use("/match", matchRoutes);
app.use("/user", userRoutes);

// Start server only if this file is run directly
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}
