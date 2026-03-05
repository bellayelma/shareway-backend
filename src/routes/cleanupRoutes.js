// routes/cleanupRoutes.js

const express = require('express');
const router = express.Router();

module.exports = (cleanupService) => {
  
  // Trigger cleanup manually (admin only - you should add auth middleware)
  router.post('/trigger', async (req, res) => {
    try {
      const results = await cleanupService.performCleanup();
      res.json({ success: true, results });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // Cleanup specific user data
  router.post('/user/:phone', async (req, res) => {
    try {
      const { phone } = req.params;
      const results = await cleanupService.cleanupUserData(phone);
      res.json({ success: true, results });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // Get collection stats
  router.get('/stats', async (req, res) => {
    try {
      const stats = await cleanupService.getCollectionStats();
      res.json({ success: true, stats });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  return router;
};
