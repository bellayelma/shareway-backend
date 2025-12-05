const express = require('express');
const router = express.Router();

let services = null;

const init = (injectedServices) => {
  services = injectedServices;
  
  // Start passenger search endpoint (Fixed to ensure userId is always set)
  router.post('/search', async (req, res) => {
    try {
      const { userId, passengerName, passengerPhone, passengerPhotoUrl, passengerCount, rideType, ...otherData } = req.body;
      
      // FIX: Ensure userId is always set
      const validUserId = userId || `passenger_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      const passengerData = {
        userId: validUserId, // ✅ Always include userId
        passengerId: validUserId, // Also set as passengerId for consistency
        passengerName,
        passengerPhone,
        passengerPhotoUrl,
        passengerCount: passengerCount || 1,
        rideType: rideType || 'standard',
        ...otherData,
        createdAt: new Date().toISOString(),
        status: 'searching',
        matchStatus: 'searching',
        tripStatus: 'waiting'
      };
      
      console.log(`🚗 Starting passenger search for: ${validUserId} (${passengerName})`);
      
      // Save to Firestore
      const searchId = await services.firestoreService.startPassengerSearch(passengerData);
      
      // Add searchId to passenger data
      passengerData.searchId = searchId;
      
      // Notify via WebSocket if available
      if (services.wsService) {
        services.wsService.sendToUser(validUserId, {
          type: 'SEARCH_STARTED',
          data: { ...passengerData, searchId: searchId }
        });
      }
      
      res.json({ 
        success: true, 
        userId: validUserId,
        passengerId: validUserId,
        searchId: searchId,
        message: 'Passenger search started successfully' 
      });
      
    } catch (error) {
      console.error('❌ Error starting passenger search:', error);
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  });
  
  // Cancel passenger search endpoint
  router.post('/cancel-search', async (req, res) => {
    try {
      const { userId, passengerId, reason } = req.body;
      
      const actualUserId = passengerId || userId;
      
      if (!actualUserId) {
        return res.status(400).json({ 
          success: false, 
          error: 'passengerId or userId is required' 
        });
      }
      
      console.log(`🚫 Cancelling passenger search for: ${actualUserId}`);
      
      const result = await services.firestoreService.cancelPassengerSearch(actualUserId, reason);
      
      // Notify via WebSocket if available
      if (services.wsService && result.success) {
        services.wsService.sendToUser(actualUserId, {
          type: 'SEARCH_CANCELLED',
          data: { 
            passengerId: actualUserId,
            reason: reason,
            cancelledAt: new Date().toISOString()
          }
        });
      }
      
      res.json(result);
      
    } catch (error) {
      console.error('❌ Error cancelling passenger search:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // Passenger status endpoint
  router.get('/status/:passengerId', async (req, res) => {
    try {
      const { passengerId } = req.params;
      
      const passengerData = await services.firestoreService.getPassengerSearch(passengerId);
      
      if (!passengerData) {
        return res.json({
          success: true,
          exists: false,
          message: 'Passenger not found in active searches',
          passengerId: passengerId
        });
      }
      
      let matchData = null;
      let rideData = null;
      
      if (passengerData.matchId) {
        matchData = await services.firestoreService.getMatch(passengerData.matchId);
      }
      
      if (passengerData.rideId) {
        const rideDoc = await services.db.collection('active_rides').doc(passengerData.rideId).get();
        if (rideDoc.exists) {
          rideData = rideDoc.data();
        }
      }
      
      const status = {
        success: true,
        exists: true,
        userId: passengerData.userId || passengerId,
        passengerId: passengerData.passengerId || passengerId,
        passengerName: passengerData.passengerName,
        passengerPhone: passengerData.passengerPhone,
        passengerPhotoUrl: passengerData.passengerPhotoUrl,
        matchStatus: passengerData.matchStatus,
        matchId: passengerData.matchId,
        matchedWith: passengerData.matchedWith,
        tripStatus: passengerData.tripStatus,
        rideId: passengerData.rideId,
        passengerCount: passengerData.passengerCount || 1,
        acceptedAt: passengerData.acceptedAt,
        driver: passengerData.driver,
        matchData: matchData,
        rideData: rideData,
        searchId: passengerData.searchId,
        status: passengerData.status,
        rideType: passengerData.rideType,
        createdAt: passengerData.createdAt
      };
      
      res.json(status);
      
    } catch (error) {
      console.error('❌ Error getting passenger status:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // Passenger location update endpoint
  router.post('/update-location', async (req, res) => {
    try {
      const { 
        userId, 
        passengerId, 
        location, 
        address 
      } = req.body;
      
      const actualUserId = passengerId || userId;
      
      if (!actualUserId) {
        return res.status(400).json({ 
          success: false, 
          error: 'passengerId or userId is required' 
        });
      }
      
      if (!location || !location.latitude || !location.longitude) {
        return res.status(400).json({ 
          success: false, 
          error: 'Valid location with latitude and longitude is required' 
        });
      }
      
      console.log(`📍 Passenger location update: ${actualUserId}`, location);
      
      const result = await services.rideService.updateLocation(
        actualUserId, 
        'passenger', 
        location, 
        address
      );
      
      // Notify via WebSocket if available
      if (services.wsService && result.success) {
        services.wsService.broadcastLocationUpdate({
          userId: actualUserId,
          userType: 'passenger',
          location: location,
          address: address,
          timestamp: new Date().toISOString()
        });
      }
      
      res.json(result);
      
    } catch (error) {
      console.error('❌ Error updating passenger location:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // Get all active passenger searches
  router.get('/active-searches', async (req, res) => {
    try {
      const searches = await services.firestoreService.getActivePassengerSearches();
      
      res.json({
        success: true,
        count: searches.length,
        searches: searches
      });
      
    } catch (error) {
      console.error('❌ Error getting active passenger searches:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // Update passenger profile endpoint
  router.post('/update-profile', async (req, res) => {
    try {
      const { 
        userId, 
        passengerId,
        passengerName,
        passengerPhone,
        passengerPhotoUrl,
        preferences
      } = req.body;
      
      const actualUserId = passengerId || userId;
      
      if (!actualUserId) {
        return res.status(400).json({ 
          success: false, 
          error: 'passengerId or userId is required' 
        });
      }
      
      console.log(`👤 Updating passenger profile: ${actualUserId}`);
      
      const updateData = {};
      if (passengerName) updateData.passengerName = passengerName;
      if (passengerPhone) updateData.passengerPhone = passengerPhone;
      if (passengerPhotoUrl) updateData.passengerPhotoUrl = passengerPhotoUrl;
      if (preferences) updateData.preferences = preferences;
      
      const result = await services.firestoreService.updatePassengerProfile(actualUserId, updateData);
      
      // Notify via WebSocket if available
      if (services.wsService && result.success) {
        services.wsService.sendToUser(actualUserId, {
          type: 'PROFILE_UPDATED',
          data: { 
            passengerId: actualUserId,
            ...updateData,
            updatedAt: new Date().toISOString()
          }
        });
      }
      
      res.json(result);
      
    } catch (error) {
      console.error('❌ Error updating passenger profile:', error);
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
