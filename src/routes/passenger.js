const express = require("express");
const router = express.Router();
const { db } = require("../app");

// Passenger starts searching
router.post("/start-search", async (req, res) => {
  try {
    const passengerData = req.body;
    await db.collection('passenger_active_searches').doc(passengerData.passengerId).set({
      ...passengerData,
      status: 'searching',
      createdAt: new Date()
    });
    
    res.json({ success: true, message: 'Passenger search started' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
