const express = require("express");
const router = express.Router();
const { db } = require("../app");

// Driver starts searching
router.post("/start-search", async (req, res) => {
  try {
    const driverData = req.body;
    await db.collection('active_searches').doc(driverData.driverId).set({
      ...driverData,
      status: 'searching',
      createdAt: new Date()
    });
    
    res.json({ success: true, message: 'Driver search started' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Driver stops searching
router.post("/stop-search/:driverId", async (req, res) => {
  try {
    await db.collection('active_searches').doc(req.params.driverId).delete();
    res.json({ success: true, message: 'Driver search stopped' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
