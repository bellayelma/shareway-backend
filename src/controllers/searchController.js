const express = require('express');
const router = express.Router();

let services = null;

const init = (injectedServices) => {
  services = injectedServices;
  
  // Search status endpoint
  router.get('/status/:userId', async (req, res) => {
    try {
      const { userId } = req.params;
      
      // Get search status from search service
      const searchStatus = services.searchService.getSearchStatus(userId);
      
      // Get scheduled search status
      let scheduledStatus = { exists: false };
      if (services.scheduledService) {
        scheduledStatus = await services.scheduledService.getScheduledSearchStatus(userId);
      }
      
      res.json({
        success: true,
        userId: userId,
        immediateSearch: searchStatus.memorySearch,
        scheduledSearch: scheduledStatus,
        matches: searchStatus.matches,
        timeout: searchStatus.timeout,
        websocketConnected: services.websocketServer ? services.websocketServer.isUserConnected(userId) : false,
        stats: searchStatus.stats
      });
      
    } catch (error) {
      console.error('❌ Error getting search status:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // Driver schedule endpoint
  router.post('/driver-schedule', async (req, res) => {
    try {
      const { 
        userId, 
        driverId,
        driverName,
        driverPhone,
        driverPhotoUrl,
        driverRating,
        vehicleInfo,
        pickupLocation,
        destinationLocation,
        pickupName,
        destinationName,
        routePoints,
        capacity,
        passengerCount,
        scheduledTime,
        vehicleType,
        distance,
        duration,
        fare,
        estimatedFare,
        maxWaitTime,
        preferredVehicleType,
        specialRequests,
        maxWalkDistance,
        activateImmediately = services.constants.TEST_MODE
      } = req.body;
      
      const actualDriverId = driverId || userId;
      
      if (!actualDriverId) {
        return res.status(400).json({ 
          success: false, 
          error: 'driverId or userId is required' 
        });
      }

      if (!scheduledTime) {
        return res.status(400).json({ 
          success: false, 
          error: 'scheduledTime is required for driver schedules' 
        });
      }

      const scheduleData = {
        userId: actualDriverId,
        userType: 'driver',
        driverName: driverName,
        driverPhone: driverPhone,
        driverPhotoUrl: driverPhotoUrl,
        driverRating: driverRating,
        vehicleInfo: vehicleInfo,
        pickupLocation: pickupLocation,
        destinationLocation: destinationLocation,
        pickupName: pickupName,
        destinationName: destinationName,
        routePoints: routePoints,
        capacity: capacity,
        passengerCount: passengerCount,
        distance: distance,
        duration: duration,
        fare: fare,
        estimatedFare: estimatedFare,
        maxWaitTime: maxWaitTime,
        preferredVehicleType: preferredVehicleType,
        specialRequests: specialRequests,
        maxWalkDistance: maxWalkDistance,
        scheduledTime: scheduledTime,
        activateImmediately: activateImmediately
      };

      const savedSchedule = await services.scheduledService.initializeScheduledSearch(scheduleData);

      let immediateSearchData = null;
      
      if (activateImmediately) {
        immediateSearchData = {
          userId: actualDriverId,
          userType: 'driver',
          driverName: driverName,
          driverPhone: driverPhone,
          driverPhotoUrl: driverPhotoUrl,
          driverRating: driverRating,
          vehicleInfo: vehicleInfo,
          pickupLocation: pickupLocation,
          destinationLocation: destinationLocation,
          pickupName: pickupName,
          destinationName: destinationName,
          routePoints: routePoints,
          capacity: capacity,
          passengerCount: passengerCount,
          distance: distance,
          duration: duration,
          fare: fare,
          estimatedFare: estimatedFare,
          maxWaitTime: maxWaitTime,
          preferredVehicleType: preferredVehicleType,
          specialRequests: specialRequests,
          maxWalkDistance: maxWalkDistance,
          rideType: 'scheduled',
          scheduledTime: scheduledTime,
          vehicleType: vehicleType,
          activateImmediately: true
        };

        await services.firestoreService.saveDriverSearch(immediateSearchData);
        services.searchService.storeSearchInMemory(immediateSearchData);
      }

      res.json({
        success: true,
        message: activateImmediately ? 
          'Driver schedule created and ACTIVATED IMMEDIATELY!' : 
          'Driver schedule created successfully',
        scheduleId: savedSchedule.searchId,
        driverId: actualDriverId,
        driverName: driverName,
        driverRating: driverRating,
        vehicleInfo: vehicleInfo,
        scheduledTime: scheduledTime,
        status: activateImmediately ? 'active' : 'scheduled',
        availableSeats: capacity || 4,
        activationTime: activateImmediately ? 'IMMEDIATELY' : '30 minutes before scheduled time',
        immediateSearch: activateImmediately ? 'Created' : 'Not created',
        testMode: services.constants.TEST_MODE
      });
      
    } catch (error) {
      console.error('❌ Error creating driver schedule:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // Get driver schedule endpoint
  router.get('/driver-schedule/:driverId', async (req, res) => {
    try {
      const { driverId } = req.params;
      
      const schedule = await services.scheduledService.getScheduledSearchStatus(driverId);
      
      if (!schedule.exists) {
        return res.json({
          success: true,
          exists: false,
          message: 'No driver schedule found',
          driverId: driverId
        });
      }

      const now = new Date();
      const timeUntilRide = new Date(schedule.scheduledTime).getTime() - now.getTime();
      
      res.json({
        success: true,
        exists: true,
        scheduleId: schedule.searchId,
        driverId: schedule.userId,
        driverName: schedule.driverName,
        driverPhone: schedule.driverPhone,
        driverPhotoUrl: schedule.driverPhotoUrl,
        driverRating: schedule.driverRating,
        vehicleInfo: schedule.vehicleInfo,
        scheduledTime: schedule.scheduledTime,
        status: schedule.status,
        timeUntilRide: Math.round(timeUntilRide / 60000),
        pickupName: schedule.pickupName,
        destinationName: schedule.destinationName,
        capacity: schedule.capacity,
        distance: schedule.distance,
        duration: schedule.duration,
        fare: schedule.fare,
        testMode: services.constants.TEST_MODE
      });
      
    } catch (error) {
      console.error('❌ Error getting driver schedule:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // Debug endpoint
  router.get('/debug/status', async (req, res) => {
    try {
      const memoryStats = services.searchService.getStats();
      const firestoreStats = services.firestoreService.getStats();
      const scheduledStats = services.scheduledService ? 
        services.scheduledService.getScheduledMatchingStats() : 
        { totalScheduledSearches: 0 };
      
      const debugInfo = {
        server: {
          timestamp: new Date().toISOString(),
          testMode: services.constants.TEST_MODE,
          websocketConnections: services.websocketServer ? services.websocketServer.getConnectedCount() : 0
        },
        memory: memoryStats,
        firestore: firestoreStats,
        scheduled: scheduledStats,
        cache: require('../utils/cache').stats()
      };
      
      res.json(debugInfo);
      
    } catch (error) {
      console.error('❌ Error in debug endpoint:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });

  // Start search endpoint
  router.post('/start', async (req, res) => {
    try {
      const searchData = req.body;
      
      // Validate required fields
      if (!searchData.userType || !searchData.userId) {
        return res.status(400).json({ 
          success: false, 
          error: 'userType and userId are required' 
        });
      }

      // Check if user exists by phone
      const phoneNumber = searchData.driverPhone || searchData.passengerPhone || searchData.phone;

      if (!phoneNumber) {
        return res.status(400).json({ 
          success: false, 
          error: 'Phone number is required' 
        });
      }

      console.log(`🔍 Starting search for phone: ${phoneNumber}`);

      // Try to get user by phone (returns null if not found)
      let user = null;
      try {
        user = await services.firestoreService.getUserByPhone(phoneNumber);
        
        if (user) {
          console.log(`✅ User found in database: ${user.id} (${user.collection})`);
        } else {
          console.log(`⚠️ User not found in main user/driver collections`);
          console.log(`   ⚡ Allowing search anyway - user will be created in active_searches collection`);
        }
        
      } catch (phoneError) {
        console.error('❌ Error checking user by phone:', phoneError.message);
        // Even on error, continue with the search
        console.log(`⚠️ Phone check error, but continuing with search: ${phoneError.message}`);
      }

      // 🚀 Continue with search creation regardless of user existence
      // This allows new users to start searches without being in the main collections

      let savedSearch;
      if (searchData.userType === 'driver') {
        savedSearch = await services.firestoreService.saveDriverSearch(searchData, { immediate: true });
      } else {
        savedSearch = await services.firestoreService.savePassengerSearch(searchData, { immediate: true });
      }

      // Store in memory cache
      services.searchService.storeSearchInMemory(savedSearch);

      // Send success response
      res.json({
        success: true,
        message: user ? 'Search started successfully' : 'Search started (new user)',
        search: savedSearch,
        userExists: !!user,
        searchId: savedSearch.searchId
      });
      
    } catch (error) {
      console.error('❌ Error starting search:', error);
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
