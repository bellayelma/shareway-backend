const express = require('express');
const router = express.Router();

let services = null;

const init = (injectedServices) => {
  services = injectedServices;
  
  // Match search endpoint
  router.post('/search', async (req, res) => {
    try {
      const { 
        userId, 
        userType,
        driverName,
        passengerName,
        pickupLocation,
        destinationLocation,
        pickupName,
        destinationName,
        routePoints,
        capacity,
        passengerCount,
        vehicleInfo,
        distance,
        duration,
        fare,
        estimatedFare,
        rideType = 'immediate',
        scheduledTime,
        searchId
      } = req.body;
      
      const actualUserId = userId;
      
      if (!actualUserId) {
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
      
      const searchData = {
        userId: actualUserId,
        userType: userType,
        driverName: driverName,
        passengerName: passengerName,
        pickupLocation: pickupLocation,
        destinationLocation: destinationLocation,
        pickupName: pickupName,
        destinationName: destinationName,
        routePoints: routePoints,
        capacity: capacity,
        passengerCount: passengerCount,
        vehicleInfo: vehicleInfo,
        distance: distance,
        duration: duration,
        fare: fare,
        estimatedFare: estimatedFare,
        rideType: rideType,
        scheduledTime: scheduledTime,
        searchId: searchId
      };
      
      // Save to appropriate collection
      if (userType === 'driver') {
        await services.firestoreService.saveDriverSearch(searchData);
      } else if (userType === 'passenger') {
        await services.firestoreService.savePassengerSearch(searchData);
      }
      
      // Also store in memory for immediate access
      const memorySearch = services.searchService.storeSearchInMemory(searchData);
      
      res.json({
        success: true,
        message: `${userType} search started successfully`,
        searchId: memorySearch.searchId,
        userId: actualUserId,
        userType: userType,
        rideType: rideType,
        timeout: '5 minutes (or until match found)',
        testMode: services.constants.TEST_MODE
      });
      
    } catch (error) {
      console.error('❌ Error in match search:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // Driver accept passenger endpoint
  router.post('/accept', async (req, res) => {
    try {
      const { 
        driverId, 
        userId,
        matchId,
        passengerId 
      } = req.body;
      
      const actualDriverId = driverId || userId;
      
      if (!actualDriverId) {
        return res.status(400).json({ 
          success: false, 
          error: 'driverId or userId is required' 
        });
      }
      
      if (!matchId) {
        return res.status(400).json({ 
          success: false, 
          error: 'matchId is required' 
        });
      }
      
      if (!passengerId) {
        return res.status(400).json({ 
          success: false, 
          error: 'passengerId is required' 
        });
      }
      
      const result = await services.rideService.acceptPassenger(actualDriverId, passengerId, matchId);
      
      res.json(result);
      
    } catch (error) {
      console.error('❌ Error accepting passenger:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // Reject match endpoint
  router.post('/reject', async (req, res) => {
    try {
      const { 
        driverId, 
        userId,
        matchId,
        passengerId,
        userType = 'driver'
      } = req.body;
      
      const actualUserId = driverId || userId;
      
      if (!actualUserId) {
        return res.status(400).json({ 
          success: false, 
          error: 'userId or driverId is required' 
        });
      }
      
      if (!matchId) {
        return res.status(400).json({ 
          success: false, 
          error: 'matchId is required' 
        });
      }
      
      await services.rideService.rejectMatch(actualUserId, userType, matchId);
      
      res.json({
        success: true,
        message: 'Match rejected successfully',
        matchId: matchId,
        userId: actualUserId,
        userType: userType
      });
      
    } catch (error) {
      console.error('❌ Error rejecting match:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // Get match status endpoint
  router.get('/status/:userId', async (req, res) => {
    try {
      const { userId } = req.params;
      
      // Get from Firestore
      let userData = await services.firestoreService.getDriverSearch(userId);
      let userType = 'driver';
      
      if (!userData) {
        userData = await services.firestoreService.getPassengerSearch(userId);
        userType = 'passenger';
      }
      
      if (!userData) {
        return res.json({
          success: true,
          exists: false,
          message: 'User not found in active searches'
        });
      }
      
      let matchData = null;
      let rideData = null;
      
      if (userData.matchId) {
        matchData = await services.firestoreService.getMatch(userData.matchId);
      }
      
      if (userData.rideId) {
        rideData = await services.firestoreService.db.collection('active_rides').doc(userData.rideId).get();
        if (rideData.exists) {
          rideData = rideData.data();
        }
      }
      
      const status = {
        success: true,
        userId: userId,
        userType: userType,
        matchStatus: userData.matchStatus,
        matchId: userData.matchId,
        matchedWith: userData.matchedWith,
        tripStatus: userData.tripStatus,
        rideId: userData.rideId,
        currentPassengers: userData.currentPassengers || 0,
        availableSeats: userData.availableSeats || (userData.capacity || 4),
        matchData: matchData,
        rideData: rideData,
        embeddedData: userType === 'driver' ? userData.passenger : userData.driver
      };
      
      res.json(status);
      
    } catch (error) {
      console.error('❌ Error getting match status:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // Stop search endpoint
  router.post('/stop-search', async (req, res) => {
    try {
      const { userId, userType, driverId, passengerId } = req.body;
      const actualUserId = userId || driverId || passengerId;
      
      if (!actualUserId) {
        return res.status(400).json({ 
          success: false, 
          error: 'userId, driverId, or passengerId is required' 
        });
      }
      
      if (!userType) {
        return res.status(400).json({ 
          success: false, 
          error: 'userType is required (driver or passenger)' 
        });
      }
      
      console.log(`🛑 Stopping search for ${userType}: ${actualUserId}`);
      
      // Stop from memory
      const stoppedFromMemory = services.searchService.stopUserSearch(actualUserId);
      
      // Stop from Firestore
      let stoppedFromFirestore = false;
      if (userType === 'driver') {
        await services.firestoreService.updateDriverSearch(actualUserId, {
          status: 'stopped',
          isSearching: false,
          updatedAt: services.admin.firestore.FieldValue.serverTimestamp()
        }, { immediate: true });
        stoppedFromFirestore = true;
      } else if (userType === 'passenger') {
        await services.firestoreService.updatePassengerSearch(actualUserId, {
          status: 'stopped',
          updatedAt: services.admin.firestore.FieldValue.serverTimestamp()
        }, { immediate: true });
        stoppedFromFirestore = true;
      }
      
      res.json({
        success: true,
        message: 'Search stopped successfully',
        userId: actualUserId,
        userType: userType,
        stoppedFromMemory: !!stoppedFromMemory,
        stoppedFromFirestore: stoppedFromFirestore
      });
      
    } catch (error) {
      console.error('❌ Error stopping search:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // Cleanup expired matches endpoint
  router.post('/cleanup-expired', async (req, res) => {
    try {
      console.log('🧹 Manual cleanup of expired matches');
      
      const clearedCount = await services.matchingService.clearExpiredMatchProposals();
      
      res.json({
        success: true,
        message: 'Manual cleanup completed',
        stats: {
          expiredMatchesCleared: clearedCount
        }
      });
      
    } catch (error) {
      console.error('❌ Error in manual cleanup:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // Get search status endpoint
  router.get('/search-status/:userId', async (req, res) => {
    try {
      const { userId } = req.params;
      
      const searchStatus = services.searchService.getSearchStatus(userId);
      
      const status = {
        success: true,
        userId: userId,
        ...searchStatus,
        websocketConnected: services.websocketServer ? services.websocketServer.isUserConnected(userId) : false
      };
      
      res.json(status);
      
    } catch (error) {
      console.error('❌ Error getting search status:', error);
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
