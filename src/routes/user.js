const express = require("express");
const router = express.Router();

const { db } = require("../app");
const { generateRouteHash } = require("../utils/routeMatching");

// Start search (both driver and passenger)
router.post("/start-search", async (req, res) => {
  try {
    const userData = req.body;
    const { userId, userType, rideType } = userData;

    if (!userId || !userType || !rideType) {
      return res.status(400).json({
        success: false,
        error: "userId, userType, and rideType are required"
      });
    }

    // Generate route hash
    const routeHash = generateRouteHash(userData.pickupLocation, userData.destinationLocation);

    const searchData = {
      ...userData,
      routeHash: routeHash,
      status: 'searching',
      createdAt: new Date()
    };

    // Determine collection based on user type and ride type
    let collectionName;
    if (userType === 'driver') {
      collectionName = rideType === 'immediate' ? 'active_drivers' : 'scheduled_drivers';
    } else {
      collectionName = rideType === 'immediate' ? 'active_passengers' : 'scheduled_passengers';
    }

    await db.collection(collectionName).doc(userId).set(searchData);

    res.json({
      success: true,
      message: `${userType} ${rideType} search started`,
      collection: collectionName
    });

  } catch (error) {
    console.error('Error starting search:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Stop search
router.post("/stop-search", async (req, res) => {
  try {
    const { userId, userType, rideType } = req.body;

    let collectionName;
    if (userType === 'driver') {
      collectionName = rideType === 'immediate' ? 'active_drivers' : 'scheduled_drivers';
    } else {
      collectionName = rideType === 'immediate' ? 'active_passengers' : 'scheduled_passengers';
    }

    await db.collection(collectionName).doc(userId).delete();

    res.json({ success: true, message: `${userType} ${rideType} search stopped` });

  } catch (error) {
    console.error('Error stopping search:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
