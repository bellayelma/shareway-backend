const express = require('express');
const router = express.Router();

let services = null;

class MatchController {
  constructor(matchingService, firestoreService) {
    this.matchingService = matchingService;
    this.firestoreService = firestoreService;
  }
  
  // Accept match (triggers location sharing)
  async acceptMatch(req, res) {
    try {
      const { matchId, userId, userType } = req.body;
      
      console.log(`🎯 Match acceptance request: ${matchId} by ${userType} ${userId}`);
      
      // Validate input
      if (!matchId || !userId || !userType) {
        return res.status(400).json({
          success: false,
          error: 'matchId, userId, and userType are required'
        });
      }
      
      if (userType !== 'driver' && userType !== 'passenger') {
        return res.status(400).json({
          success: false,
          error: 'userType must be "driver" or "passenger"'
        });
      }
      
      // FIXED: Use correct method name - acceptIndividualMatch
      const result = await this.matchingService.acceptIndividualMatch(matchId, userId, userType);
      
      res.json(result);
      
    } catch (error) {
      console.error('❌ Error accepting match:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to accept match'
      });
    }
  }
  
  // Reject match
  async rejectMatch(req, res) {
    try {
      const { matchId, userId, userType } = req.body;
      
      if (!matchId || !userId || !userType) {
        return res.status(400).json({
          success: false,
          error: 'matchId, userId, and userType are required'
        });
      }
      
      console.log(`❌ Match rejection request: ${matchId} by ${userType} ${userId}`);
      
      // FIXED: Use correct method name - declineIndividualMatch
      const result = await this.matchingService.declineIndividualMatch(matchId, userId, userType);
      
      res.json(result);
      
    } catch (error) {
      console.error('❌ Error rejecting match:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
  
  // Get match details
  async getMatchDetails(req, res) {
    try {
      const { matchId } = req.params;
      
      const match = await this.firestoreService.getMatch(matchId);
      
      if (!match) {
        return res.status(404).json({
          success: false,
          error: 'Match not found'
        });
      }
      
      res.json({
        success: true,
        match,
        locationSharing: {
          enabled: match.locationSharingEnabled || false,
          sessionId: match.locationSessionId,
          startedAt: match.locationSharingStarted,
          expiresAt: match.locationSharingExpires
        }
      });
      
    } catch (error) {
      console.error('❌ Error getting match details:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
  
  // NEW: Accept all passengers for a driver
  async acceptAllPassengers(req, res) {
    try {
      const { driverId } = req.body;
      
      if (!driverId) {
        return res.status(400).json({
          success: false,
          error: 'driverId is required'
        });
      }
      
      console.log(`🤖 Accepting all passengers for driver: ${driverId}`);
      
      // Check if method exists in matching service
      if (typeof this.matchingService.autoAcceptAllPassengersForDriver === 'function') {
        await this.matchingService.autoAcceptAllPassengersForDriver(driverId);
      } else {
        console.log('⚠️ autoAcceptAllPassengersForDriver method not available');
        
        // Fallback: Manually accept all passengers
        const driverDoc = await this.firestoreService.db.collection('active_searches_driver').doc(driverId).get();
        if (!driverDoc.exists) {
          return res.status(404).json({
            success: false,
            error: 'Driver not found'
          });
        }
        
        const driverData = driverDoc.data();
        const capacity = driverData.capacity || 4;
        let acceptedCount = 0;
        
        for (let i = 1; i <= capacity; i++) {
          const fieldName = `passenger${i}`;
          const passengerData = driverData[fieldName];
          
          if (passengerData && passengerData.passengerId && passengerData.matchStatus === 'proposed') {
            // Update passenger field to accepted
            const updatedPassengerData = {
              ...passengerData,
              matchStatus: 'accepted',
              acceptedAt: new Date().toISOString()
            };
            
            await driverDoc.ref.update({
              [fieldName]: updatedPassengerData,
              lastUpdated: Date.now()
            });
            
            // Update passenger document
            await this.firestoreService.db.collection('active_searches_passenger')
              .doc(passengerData.passengerId).update({
                matchStatus: 'accepted',
                status: 'accepted',
                matchAcceptedAt: new Date(),
                lastUpdated: Date.now()
              });
            
            acceptedCount++;
          }
        }
        
        // Update driver overall status
        await this.matchingService.updateDriverOverallStatus(driverId);
      }
      
      res.json({
        success: true,
        message: 'All passengers accepted successfully',
        driverId: driverId
      });
      
    } catch (error) {
      console.error('❌ Error accepting all passengers:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
  
  // NEW: Get driver's passenger configuration
  async getDriverPassengers(req, res) {
    try {
      const { driverId } = req.params;
      
      if (!driverId) {
        return res.status(400).json({
          success: false,
          error: 'driverId is required'
        });
      }
      
      // Check if method exists
      let passengerSummary;
      if (typeof this.matchingService.getDriverPassengerSummary === 'function') {
        passengerSummary = await this.matchingService.getDriverPassengerSummary(driverId);
      } else {
        // Fallback implementation
        const driverDoc = await this.firestoreService.db.collection('active_searches_driver').doc(driverId).get();
        if (!driverDoc.exists) {
          return res.status(404).json({
            success: false,
            error: 'Driver not found'
          });
        }
        
        const driverData = driverDoc.data();
        const capacity = driverData.capacity || 4;
        
        const passengers = [];
        let totalPassengerCount = 0;
        let acceptedCount = 0;
        
        for (let i = 1; i <= capacity; i++) {
          const fieldName = `passenger${i}`;
          const passengerData = driverData[fieldName];
          
          if (passengerData && passengerData.passengerId) {
            passengers.push({
              field: fieldName,
              ...passengerData
            });
            
            totalPassengerCount += passengerData.passengerCount || 1;
            if (passengerData.matchStatus === 'accepted') {
              acceptedCount++;
            }
          }
        }
        
        passengerSummary = {
          driverId: driverId,
          driverName: driverData.driverName,
          currentPassengers: totalPassengerCount,
          capacity: capacity,
          availableSeats: capacity - totalPassengerCount,
          acceptedPassengers: acceptedCount,
          totalPassengers: passengers.length,
          passengers: passengers,
          driverStatus: driverData.status,
          driverMatchStatus: driverData.matchStatus || 'none'
        };
      }
      
      res.json({
        success: true,
        ...passengerSummary
      });
      
    } catch (error) {
      console.error('❌ Error getting driver passengers:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

const init = (injectedServices) => {
  services = injectedServices;
  
  // Initialize MatchController
  const matchController = new MatchController(
    services.matchingService,
    services.firestoreService
  );
  
  // Match search endpoint
  router.post('/search', async (req, res) => {
    try {
      const { 
        userId, 
        userType,
        driverName,
        driverPhone,
        driverPhoto,
        passengerName,
        passengerPhone,
        passengerPhoto,
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
      
      console.log('🔍 Match search request received:');
      console.log(`   User: ${actualUserId} (${userType})`);
      console.log(`   Ride Type: ${rideType}`);
      
      const searchData = {
        userId: actualUserId,
        userType: userType,
        driverName: driverName,
        driverPhone: driverPhone || '',
        driverPhoto: driverPhoto || '',
        passengerName: passengerName,
        passengerPhone: passengerPhone || '',
        passengerPhoto: passengerPhoto || '',
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
        searchId: searchId,
        status: 'searching',
        createdAt: new Date().toISOString()
      };
      
      // Save to appropriate collection
      if (userType === 'driver') {
        if (services.firestoreService && typeof services.firestoreService.saveDriverSearch === 'function') {
          if (!searchData.driverPhone) {
            console.warn('⚠️ Driver search without phone number, using empty string');
            searchData.driverPhone = '';
          }
          await services.firestoreService.saveDriverSearch(searchData);
        }
      } else if (userType === 'passenger') {
        if (services.firestoreService && typeof services.firestoreService.savePassengerSearch === 'function') {
          if (!searchData.passengerPhone) {
            console.warn('⚠️ Passenger search without phone number, using empty string');
            searchData.passengerPhone = '';
          }
          await services.firestoreService.savePassengerSearch(searchData);
        }
      }
      
      // Also store in memory for immediate access
      if (services.searchService && typeof services.searchService.storeSearchInMemory === 'function') {
        services.searchService.storeSearchInMemory(searchData);
      }
      
      // Send WebSocket notification if user is connected
      if (services.websocketServer && typeof services.websocketServer.isUserConnected === 'function' && 
          services.websocketServer.isUserConnected(actualUserId)) {
        services.websocketServer.sendToUser(actualUserId, {
          type: 'SEARCH_STARTED',
          data: {
            userId: actualUserId,
            userType: userType,
            searchType: rideType,
            timestamp: Date.now(),
            message: 'Search started successfully'
          }
        });
      }
      
      res.json({
        success: true,
        message: `${userType} search started successfully`,
        searchId: `search_${Date.now()}_${actualUserId}`,
        userId: actualUserId,
        userType: userType,
        rideType: rideType,
        timeout: '5 minutes (or until match found)'
      });
      
    } catch (error) {
      console.error('❌ Error in match search:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // Accept match endpoint using MatchController
  router.post('/accept-match', (req, res) => matchController.acceptMatch(req, res));
  
  // Reject match endpoint using MatchController
  router.post('/reject-match', (req, res) => matchController.rejectMatch(req, res));
  
  // NEW: Accept all passengers for a driver
  router.post('/accept-all-passengers', (req, res) => matchController.acceptAllPassengers(req, res));
  
  // Get match details endpoint
  router.get('/match-details/:matchId', (req, res) => matchController.getMatchDetails(req, res));
  
  // NEW: Get driver's passenger configuration
  router.get('/driver-passengers/:driverId', (req, res) => matchController.getDriverPassengers(req, res));
  
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
      
      if (userData.matchId) {
        matchData = await services.firestoreService.getMatch(userData.matchId);
      }
      
      // Extract passenger field information if driver
      let passengerFields = {};
      if (userType === 'driver' && userData.capacity) {
        const capacity = userData.capacity || 4;
        for (let i = 1; i <= capacity; i++) {
          const fieldName = `passenger${i}`;
          if (userData[fieldName]) {
            passengerFields[fieldName] = {
              passengerId: userData[fieldName].passengerId,
              passengerName: userData[fieldName].passengerName,
              matchStatus: userData[fieldName].matchStatus || 'none'
            };
          }
        }
      }
      
      const status = {
        success: true,
        userId: userId,
        userType: userType,
        matchStatus: userData.matchStatus,
        matchId: userData.matchId,
        matchedWith: userData.matchedWith,
        currentPassengers: userData.currentPassengers || 0,
        availableSeats: userData.availableSeats || (userData.capacity || 4),
        matchData: matchData,
        passengerFields: passengerFields
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
      const { userId, userType } = req.body;
      
      if (!userId || !userType) {
        return res.status(400).json({ 
          success: false, 
          error: 'userId and userType are required' 
        });
      }
      
      console.log(`🛑 Stopping search for ${userType}: ${userId}`);
      
      let stoppedFromFirestore = false;
      if (userType === 'driver') {
        await services.firestoreService.updateDriverSearch(userId, {
          status: 'stopped',
          isSearching: false,
          updatedAt: services.admin.firestore.FieldValue.serverTimestamp()
        }, { immediate: true });
        stoppedFromFirestore = true;
      } else if (userType === 'passenger') {
        await services.firestoreService.updatePassengerSearch(userId, {
          status: 'stopped',
          updatedAt: services.admin.firestore.FieldValue.serverTimestamp()
        }, { immediate: true });
        stoppedFromFirestore = true;
      }
      
      res.json({
        success: true,
        message: 'Search stopped successfully',
        userId: userId,
        userType: userType,
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
  
  // NEW: Force matching cycle (for testing)
  router.post('/force-match-cycle', async (req, res) => {
    try {
      console.log('⚡ Forcing matching cycle...');
      
      if (services.matchingService && typeof services.matchingService.performMatchingCycle === 'function') {
        await services.matchingService.performMatchingCycle();
        
        res.json({
          success: true,
          message: 'Matching cycle executed',
          timestamp: new Date().toISOString()
        });
      } else {
        res.status(500).json({
          success: false,
          error: 'Matching service not available'
        });
      }
      
    } catch (error) {
      console.error('❌ Error forcing match cycle:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
  
  // NEW: Auto-accept all proposed matches (for testing)
  router.post('/auto-accept-all', async (req, res) => {
    try {
      console.log('🤖 Auto-accepting all proposed matches...');
      
      const matchesSnapshot = await services.firestoreService.db.collection('active_matches')
        .where('status', '==', 'proposed').get();
      
      let acceptedCount = 0;
      
      for (const matchDoc of matchesSnapshot.docs) {
        const match = matchDoc.data();
        
        try {
          await services.matchingService.acceptIndividualMatch(
            match.matchId,
            match.driverId,
            'driver'
          );
          acceptedCount++;
        } catch (error) {
          console.error(`❌ Failed to auto-accept ${match.matchId}:`, error.message);
        }
      }
      
      res.json({
        success: true,
        message: `Auto-accepted ${acceptedCount} proposed matches`,
        acceptedCount: acceptedCount
      });
      
    } catch (error) {
      console.error('❌ Error auto-accepting all matches:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
};

module.exports = {
  init,
  router,
  MatchController
};
