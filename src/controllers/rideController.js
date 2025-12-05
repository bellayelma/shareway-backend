const express = require('express');
const router = express.Router();

let services = null;

const init = (injectedServices) => {
  services = injectedServices;
  
  // Trip status update endpoint
  router.post('/update-status', async (req, res) => {
    try {
      const { userId, userType, tripStatus, location } = req.body;
      
      if (!userId) {
        return res.status(400).json({ 
          success: false, 
          error: 'userId is required' 
        });
      }
      
      if (!userType) {
        return res.status(400).json({ 
          success: false, 
          error: 'userType is required (driver or passenger)' 
        });
      }
      
      if (!tripStatus) {
        return res.status(400).json({ 
          success: false, 
          error: 'tripStatus is required' 
        });
      }
      
      console.log(`🔄 Trip status update: ${userId} (${userType}) → ${tripStatus}`);
      
      const result = await services.rideService.updateTripStatus(
        userId, 
        userType, 
        tripStatus, 
        location
      );
      
      res.json(result);
      
    } catch (error) {
      console.error('❌ Error updating trip status:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // Force activate scheduled searches (for testing)
  router.post('/force-activate-scheduled', async (req, res) => {
    try {
      if (!services.constants.TEST_MODE) {
        return res.status(403).json({ 
          success: false, 
          error: 'This endpoint is only available in TEST_MODE' 
        });
      }
      
      const activatedCount = await services.scheduledService.forceActivateAllScheduledSearches();
      
      res.json({
        success: true,
        message: 'Force activated scheduled searches',
        activatedCount: activatedCount,
        testMode: true
      });
      
    } catch (error) {
      console.error('❌ Error force activating scheduled searches:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
};

module.exports = {
  init,
  router
};
