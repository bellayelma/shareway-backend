// controllers/driverController.js - FIXED VERSION
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

// Services
let services;
let firestoreService;  // Add this
let db;
let admin;  // You might not need this if using regular Firebase SDK
let searchService;
let rideService;
let matchingService;
let websocketServer;

// Collection names
const ACTIVE_SEARCHES_DRIVER_COLLECTION = 'active_searches_driver';
const ACTIVE_SEARCHES_PASSENGER_COLLECTION = 'active_searches_passenger';
const ACTIVE_MATCHES_COLLECTION = 'active_matches';
const ACTIVE_RIDES_COLLECTION = 'active_rides';

// Initialize controller with services
const init = (serviceContainer) => {
  services = serviceContainer;
  db = serviceContainer.db;
  admin = serviceContainer.admin;
  firestoreService = serviceContainer.firestoreService;  // Add this
  searchService = serviceContainer.searchService;
  rideService = serviceContainer.rideService;
  matchingService = serviceContainer.matchingService;
  websocketServer = serviceContainer.websocketServer;
};

// ========== ✅ ENDPOINT 1: /api/driver/start-search ==========
router.post('/start-search', async (req, res) => {
  try {
    console.log('🚗 === DRIVER START-SEARCH ENDPOINT ===');
    console.log('📦 Request body keys:', Object.keys(req.body));
    console.log('📦 Request body:', JSON.stringify(req.body, null, 2));
    
    const { 
      userId, 
      userType = 'driver',
      driverId,
      driverName,
      driverPhone,
      driverPhotoUrl,
      driverRating,
      totalRides,
      isVerified,
      totalEarnings,
      completedRides,
      isOnline,
      isSearching,
      vehicleInfo,
      pickupLocation,
      destinationLocation,
      pickupName,
      destinationName,
      routePoints,
      capacity,
      passengerCount,
      distance,
      duration,
      fare,
      estimatedFare,
      maxWaitTime,
      preferredVehicleType,
      specialRequests,
      maxWalkDistance,
      rideType = 'immediate',
      scheduledTime,
      searchId
    } = req.body;
    
    const actualUserId = userId || driverId;
    
    if (!actualUserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId or driverId is required' 
      });
    }

    if (!pickupLocation || !destinationLocation) {
      return res.status(400).json({ 
        success: false, 
        error: 'pickupLocation and destinationLocation are required' 
      });
    }

    console.log(`🎯 Starting driver search: ${driverName || actualUserId}`);
    console.log(`   - Driver Name: ${driverName || 'Unknown'}`);
    console.log(`   - Driver Phone: ${driverPhone || 'Not provided'}`);
    console.log(`   - Driver Photo: ${driverPhotoUrl || 'No photo'}`);
    console.log(`   - Pickup: ${pickupName || 'Unknown'}`);
    console.log(`   - Destination: ${destinationName || 'Unknown'}`);
    console.log(`   - Capacity: ${capacity || 4} seats`);
    console.log(`   - Ride Type: ${rideType}`);

    // Create search data - Pass ALL data correctly
    const searchData = {
      // Basic identification
      userId: actualUserId,
      userType: 'driver',
      driverId: actualUserId,
      
      // Driver profile data - MAKE SURE THESE ARE PASSED
      driverName: driverName || 'Unknown Driver',
      driverPhone: driverPhone || 'Not provided',
      driverPhotoUrl: driverPhotoUrl || '',
      driverRating: driverRating || 5.0,
      totalRides: totalRides || 0,
      isVerified: isVerified || false,
      totalEarnings: totalEarnings || 0.0,
      completedRides: completedRides || 0,
      isOnline: isOnline !== undefined ? isOnline : true,
      isSearching: isSearching !== undefined ? isSearching : true,
      
      // Vehicle information - Pass as object if provided
      vehicleInfo: vehicleInfo || {
        model: 'Car Model',
        plate: 'ABC123',
        color: 'Unknown',
        type: 'car',
        year: 'Unknown',
        passengerCapacity: capacity || 4
      },
      
      // Location data
      pickupLocation: pickupLocation,
      destinationLocation: destinationLocation,
      pickupName: pickupName || 'Unknown Pickup',
      destinationName: destinationName || 'Unknown Destination',
      
      // Route geometry
      routePoints: routePoints || [],
      
      // Vehicle & capacity data
      passengerCount: passengerCount || 0,
      capacity: capacity || 4,
      vehicleType: preferredVehicleType || 'car',
      availableSeats: capacity || 4,
      currentPassengers: 0,
      
      // Match acceptance fields
      matchId: null,
      matchedWith: null,
      matchStatus: null,
      tripStatus: null,
      rideId: null,
      passenger: null,
      acceptedAt: null,
      
      // Route information
      distance: distance || 0,
      duration: duration || 0,
      fare: fare || 0,
      estimatedFare: estimatedFare || 0,
      
      // Preferences & settings
      maxWaitTime: maxWaitTime || 30,
      preferredVehicleType: preferredVehicleType || 'car',
      specialRequests: specialRequests || '',
      maxWalkDistance: maxWalkDistance || 0.5,
      
      // Search metadata
      rideType: rideType,
      scheduledTime: scheduledTime,
      searchId: searchId || `driver_search_${actualUserId}_${Date.now()}`,
      status: 'searching',
      
      // System data - Use simple Date objects
      createdAt: new Date(),
      updatedAt: new Date(),
      lastUpdated: Date.now()
    };

    console.log('📋 Prepared driver search data:', JSON.stringify(searchData, null, 2));

    // Use FirestoreService to save - This is the key fix
    if (firestoreService) {
      const savedData = await firestoreService.saveDriverSearch(searchData);
      console.log(`✅ Driver search saved via FirestoreService: ${savedData.driverName}`);
    } else {
      // Fallback to direct Firestore
      console.warn('⚠️ FirestoreService not available, using direct Firestore');
      await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(actualUserId).set(searchData);
    }
    
    // Also add to search service for in-memory matching
    if (searchService) {
      await searchService.addSearch(searchData);
    }

    // Return response with all driver data
    res.json({
      success: true,
      message: 'Driver search started successfully',
      searchId: searchData.searchId,
      userId: actualUserId,
      driverProfile: {
        driverName: searchData.driverName,
        driverPhone: searchData.driverPhone,
        driverPhotoUrl: searchData.driverPhotoUrl,
        driverRating: searchData.driverRating
      },
      vehicleInfo: searchData.vehicleInfo,
      rideType: rideType,
      availableSeats: searchData.availableSeats,
      capacity: searchData.capacity,
      timeout: '5 minutes (or until match found)',
      storage: ACTIVE_SEARCHES_DRIVER_COLLECTION,
      websocketConnected: websocketServer ? websocketServer.isUserConnected(actualUserId) : false
    });

  } catch (error) {
    console.error('❌ Error in driver start-search:', error);
    console.error('❌ Error stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// ========== ✅ ENDPOINT 2: /api/driver/stop-search ==========
router.post('/stop-search', async (req, res) => {
  try {
    console.log('🛑 === DRIVER STOP-SEARCH ENDPOINT ===');
    
    const { userId, userType = 'driver', rideType = 'immediate', driverId } = req.body;
    
    const actualUserId = userId || driverId;
    
    if (!actualUserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId or driverId is required' 
      });
    }

    console.log(`🛑 Stopping driver search: ${actualUserId}`);

    // Use FirestoreService to update
    if (firestoreService) {
      await firestoreService.updateDriverSearch(actualUserId, {
        status: 'stopped',
        isSearching: false,
        lastUpdated: Date.now()
      }, { immediate: true });
    } else {
      // Fallback
      await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(actualUserId).update({
        status: 'stopped',
        isSearching: false,
        updatedAt: new Date(),
        lastUpdated: Date.now()
      });
    }
    
    console.log(`✅ Stopped driver search in ${ACTIVE_SEARCHES_DRIVER_COLLECTION}: ${actualUserId}`);

    // Remove from search service
    let memoryRemoved = false;
    if (searchService) {
      memoryRemoved = await searchService.removeSearch(actualUserId, 'driver');
    }

    // Notify via WebSocket
    if (websocketServer) {
      websocketServer.sendSearchStopped(actualUserId, {
        userType: 'driver',
        reason: 'user_requested',
        message: 'Driver search stopped successfully',
        stoppedFromFirestore: true,
        stoppedFromMemory: memoryRemoved
      });
    }

    res.json({
      success: true,
      message: 'Driver search stopped successfully',
      driverId: actualUserId,
      stoppedFromFirestore: true,
      stoppedFromMemory: memoryRemoved,
      collection: ACTIVE_SEARCHES_DRIVER_COLLECTION
    });

  } catch (error) {
    console.error('❌ Error stopping driver search:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// ========== ✅ ENDPOINT 3: /api/driver/search-status/:driverId ==========
router.get('/search-status/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    
    console.log(`🔍 Getting driver search status: ${driverId}`);

    if (!driverId) {
      return res.status(400).json({
        success: false,
        error: 'driverId parameter is required'
      });
    }

    // Use FirestoreService to get data
    let driverData;
    if (firestoreService) {
      driverData = await firestoreService.getDriverSearch(driverId);
    } else {
      const driverDoc = await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(driverId).get();
      driverData = driverDoc.exists ? { id: driverDoc.id, ...driverDoc.data() } : null;
    }
    
    if (!driverData) {
      return res.json({
        success: true,
        exists: false,
        message: 'Driver not found in active searches',
        driverId: driverId,
        collection: ACTIVE_SEARCHES_DRIVER_COLLECTION
      });
    }

    // Get match and ride data if exists
    let matchData = null;
    let rideData = null;
    
    if (driverData.matchId) {
      if (firestoreService) {
        matchData = await firestoreService.getMatch(driverData.matchId);
      } else {
        const matchDoc = await db.collection(ACTIVE_MATCHES_COLLECTION).doc(driverData.matchId).get();
        if (matchDoc.exists) {
          matchData = { id: matchDoc.id, ...matchDoc.data() };
        }
      }
    }
    
    if (driverData.rideId) {
      const rideDoc = await db.collection(ACTIVE_RIDES_COLLECTION).doc(driverData.rideId).get();
      if (rideDoc.exists) {
        rideData = { id: rideDoc.id, ...rideDoc.data() };
      }
    }

    res.json({
      success: true,
      exists: true,
      driverId: driverId,
      driverProfile: {
        driverName: driverData.driverName,
        driverPhone: driverData.driverPhone,
        driverPhotoUrl: driverData.driverPhotoUrl,
        driverRating: driverData.driverRating
      },
      vehicleInfo: driverData.vehicleInfo,
      matchStatus: driverData.matchStatus,
      matchId: driverData.matchId,
      matchedWith: driverData.matchedWith,
      tripStatus: driverData.tripStatus,
      rideId: driverData.rideId,
      currentPassengers: driverData.currentPassengers || 0,
      availableSeats: driverData.availableSeats || driverData.capacity || 4,
      capacity: driverData.capacity || 4,
      acceptedAt: driverData.acceptedAt,
      passenger: driverData.passenger,
      matchData: matchData,
      rideData: rideData,
      collection: ACTIVE_SEARCHES_DRIVER_COLLECTION,
      searchId: driverData.searchId,
      status: driverData.status,
      rideType: driverData.rideType,
      isSearching: driverData.isSearching,
      isOnline: driverData.isOnline
    });

  } catch (error) {
    console.error('❌ Error getting driver search status:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// ... [Keep the rest of the endpoints, but replace all admin.firestore.FieldValue.serverTimestamp() with new Date()]

module.exports = {
  router,
  init
};
