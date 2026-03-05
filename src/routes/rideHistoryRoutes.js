// routes/rideHistoryRoutes.js

const express = require('express');
const router = express.Router();

module.exports = (rideHistoryService) => {
  
  // Get passenger ride history
  router.get('/passenger/:phone', async (req, res) => {
    try {
      const { phone } = req.params;
      const { 
        status, 
        fromDate, 
        toDate, 
        limit, 
        startAfter,
        sortBy 
      } = req.query;
      
      const result = await rideHistoryService.getPassengerRides(phone, {
        status,
        fromDate,
        toDate,
        limit: limit ? parseInt(limit) : undefined,
        startAfter,
        sortBy
      });
      
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // Get driver ride history
  router.get('/driver/:phone', async (req, res) => {
    try {
      const { phone } = req.params;
      const { 
        status, 
        fromDate, 
        toDate, 
        limit, 
        startAfter,
        sortBy 
      } = req.query;
      
      const result = await rideHistoryService.getDriverRides(phone, {
        status,
        fromDate,
        toDate,
        limit: limit ? parseInt(limit) : undefined,
        startAfter,
        sortBy
      });
      
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // Get single ride details
  router.get('/:rideId', async (req, res) => {
    try {
      const { rideId } = req.params;
      const ride = await rideHistoryService.getRideDetails(rideId);
      
      if (!ride) {
        return res.status(404).json({ success: false, error: 'Ride not found' });
      }
      
      res.json({ success: true, ride });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // Get user ride statistics
  router.get('/stats/:phone/:userType', async (req, res) => {
    try {
      const { phone, userType } = req.params;
      
      if (!['driver', 'passenger'].includes(userType)) {
        return res.status(400).json({ success: false, error: 'Invalid user type' });
      }
      
      const stats = await rideHistoryService.getUserRideStats(phone, userType);
      res.json(stats);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // Add feedback
  router.post('/:rideId/feedback', async (req, res) => {
    try {
      const { rideId } = req.params;
      const { userPhone, userType, rating, review } = req.body;
      
      const result = await rideHistoryService.addRideFeedback(
        rideId, 
        userPhone, 
        userType, 
        rating, 
        review
      );
      
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  return router;
};
