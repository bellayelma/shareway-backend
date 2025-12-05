// controllers/driverController.js - FIXED VERSION WITH IMMEDIATE SAVE
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

// Services
let services;
let firestoreService;
let db;
let admin;
let searchService;
let rideService;
let matchingService;
let websocketServer;

// Collection names
const ACTIVE_SEARCHES_DRIVER_COLLECTION = 'active_searches_driver';
const ACTIVE_SEARCHES_PASSENGER_COLLECTION = 'active_searches_passenger';
const ACTIVE_MATCHES_COLLECTION = 'active_matches';
const ACTIVE_RIDES_COLLECTION = 'active_rides';

// Helper function to verify document exists
async function verifyDocumentExists(collection, docId) {
  try {
    const doc = await db.collection(collection).doc(docId).get();
    return {
      exists: doc.exists,
      data: doc.exists ? doc.data() : null,
      id: doc.id
    };
  } catch (error) {
    console.error('❌ Error verifying document:', error);
    return { exists: false, error: error.message };
  }
}

// Initialize controller with services
const init = (serviceContainer) => {
  services = serviceContainer;
  db = serviceContainer.db;
  admin = serviceContainer.admin;
  firestoreService = serviceContainer.firestoreService;
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

    // Use FirestoreService to save - With immediate option
    if (firestoreService) {
      // Use immediate save to ensure data is saved right away
      const savedData = await firestoreService.saveDriverSearch(searchData, { immediate: true });
      console.log(`✅ Driver search saved immediately: ${savedData.driverName}`);
      
      // Verify it was saved
      const verification = await verifyDocumentExists(
        ACTIVE_SEARCHES_DRIVER_COLLECTION, 
        actualUserId
      );
      
      if (verification.exists) {
        console.log('✅ VERIFIED - All driver data saved correctly');
        console.log('📊 Verification data:', {
          hasDriverName: !!verification.data.driverName,
          hasDriverPhone: !!verification.data.driverPhone,
          hasDriverPhoto: !!verification.data.driverPhotoUrl,
          hasVehicleInfo: !!verification.data.vehicleInfo
        });
      } else {
        console.log('⚠️ WARNING - Driver data may not have been saved');
      }
    } else {
      // Fallback to direct Firestore
      console.warn('⚠️ FirestoreService not available, using direct Firestore');
      await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(actualUserId).set(searchData);
      console.log('✅ Driver search saved via direct Firestore');
    }
    
    // Also add to search service for in-memory matching
    if (searchService) {
      await searchService.addSearch(searchData);
      console.log('✅ Driver search added to memory cache');
    }

    // Return response with all driver data
    const response = {
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
      websocketConnected: websocketServer ? websocketServer.isUserConnected(actualUserId) : false,
      immediateSave: true
    };

    console.log('📤 Sending response to client:', JSON.stringify(response, null, 2));
    res.json(response);

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

    // Use FirestoreService to update with immediate save
    if (firestoreService) {
      await firestoreService.updateDriverSearch(actualUserId, {
        status: 'stopped',
        isSearching: false,
        lastUpdated: Date.now(),
        updatedAt: new Date()
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
      collection: ACTIVE_SEARCHES_DRIVER_COLLECTION,
      immediateSave: true
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

// ========== ✅ ENDPOINT 4: /api/driver/get-match/:driverId ==========
router.get('/get-match/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    
    if (!driverId) {
      return res.status(400).json({
        success: false,
        error: 'driverId is required'
      });
    }

    // Get driver search data
    let driverData;
    if (firestoreService) {
      driverData = await firestoreService.getDriverSearch(driverId);
    } else {
      const driverDoc = await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(driverId).get();
      driverData = driverDoc.exists ? { id: driverDoc.id, ...driverDoc.data() } : null;
    }
    
    if (!driverData || !driverData.matchId) {
      return res.json({
        success: true,
        hasMatch: false,
        message: driverData ? 'No active match found' : 'Driver not found',
        driverId: driverId
      });
    }

    // Get match data
    let matchData;
    if (firestoreService) {
      matchData = await firestoreService.getMatch(driverData.matchId);
    } else {
      const matchDoc = await db.collection(ACTIVE_MATCHES_COLLECTION).doc(driverData.matchId).get();
      matchData = matchDoc.exists ? { id: matchDoc.id, ...matchDoc.data() } : null;
    }
    
    if (!matchData) {
      return res.json({
        success: true,
        hasMatch: false,
        message: 'Match data not found',
        driverId: driverId,
        matchId: driverData.matchId
      });
    }

    // Get passenger data
    let passengerData = null;
    if (matchData.passengerId) {
      if (firestoreService) {
        passengerData = await firestoreService.getPassengerSearch(matchData.passengerId);
      } else {
        const passengerDoc = await db.collection(ACTIVE_SEARCHES_PASSENGER_COLLECTION).doc(matchData.passengerId).get();
        passengerData = passengerDoc.exists ? { id: passengerDoc.id, ...passengerDoc.data() } : null;
      }
    }

    res.json({
      success: true,
      hasMatch: true,
      driverId: driverId,
      matchStatus: driverData.matchStatus,
      matchId: driverData.matchId,
      passengerId: matchData.passengerId,
      passengerData: passengerData,
      matchData: matchData,
      tripStatus: driverData.tripStatus,
      rideId: driverData.rideId,
      collection: ACTIVE_MATCHES_COLLECTION
    });

  } catch (error) {
    console.error('❌ Error getting driver match:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// ========== ✅ ENDPOINT 5: /api/driver/accept-match ==========
router.post('/accept-match', async (req, res) => {
  try {
    console.log('✅ === DRIVER ACCEPT MATCH ENDPOINT ===');
    
    const { driverId, matchId } = req.body;
    
    if (!driverId || !matchId) {
      return res.status(400).json({
        success: false,
        error: 'driverId and matchId are required'
      });
    }

    console.log(`✅ Driver accepting match: ${driverId}, match: ${matchId}`);

    // Get match data
    let matchData;
    if (firestoreService) {
      matchData = await firestoreService.getMatch(matchId);
    } else {
      const matchDoc = await db.collection(ACTIVE_MATCHES_COLLECTION).doc(matchId).get();
      matchData = matchDoc.exists ? { id: matchDoc.id, ...matchDoc.data() } : null;
    }
    
    if (!matchData) {
      return res.status(404).json({
        success: false,
        error: 'Match not found'
      });
    }

    // Update driver search with match acceptance
    const updates = {
      matchStatus: 'accepted',
      tripStatus: 'driver_accepted',
      acceptedAt: new Date(),
      lastUpdated: Date.now(),
      matchedWith: matchData.passengerId,
      matchId: matchId
    };

    if (firestoreService) {
      await firestoreService.updateDriverSearch(driverId, updates, { immediate: true });
    } else {
      await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(driverId).update({
        ...updates,
        updatedAt: new Date()
      });
    }

    // Update match status
    const matchUpdates = {
      driverStatus: 'accepted',
      status: 'driver_accepted',
      lastUpdated: Date.now()
    };

    if (firestoreService) {
      await firestoreService.queueWrite(
        ACTIVE_MATCHES_COLLECTION,
        matchId,
        { ...matchUpdates, updatedAt: new Date() },
        'update'
      );
    } else {
      await db.collection(ACTIVE_MATCHES_COLLECTION).doc(matchId).update({
        ...matchUpdates,
        updatedAt: new Date()
      });
    }

    // Create ride record
    const driverData = firestoreService 
      ? await firestoreService.getDriverSearch(driverId)
      : null;
    
    const passengerData = firestoreService && matchData.passengerId
      ? await firestoreService.getPassengerSearch(matchData.passengerId)
      : null;

    if (driverData && passengerData && rideService) {
      const rideId = await rideService.createRide(driverData, passengerData, matchId);
      
      // Update driver with rideId
      if (firestoreService) {
        await firestoreService.updateDriverSearch(driverId, { rideId }, { immediate: true });
      } else {
        await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(driverId).update({
          rideId: rideId,
          updatedAt: new Date()
        });
      }
    }

    // Notify via WebSocket
    if (websocketServer) {
      websocketServer.sendMatchAccepted(matchId, {
        driverId: driverId,
        passengerId: matchData.passengerId,
        status: 'driver_accepted',
        timestamp: new Date().toISOString()
      });
    }

    console.log(`✅ Driver ${driverId} accepted match ${matchId}`);

    res.json({
      success: true,
      message: 'Match accepted successfully',
      driverId: driverId,
      matchId: matchId,
      passengerId: matchData.passengerId,
      matchStatus: 'accepted',
      tripStatus: 'driver_accepted',
      immediateSave: true
    });

  } catch (error) {
    console.error('❌ Error accepting match:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// ========== ✅ ENDPOINT 6: /api/driver/reject-match ==========
router.post('/reject-match', async (req, res) => {
  try {
    console.log('❌ === DRIVER REJECT MATCH ENDPOINT ===');
    
    const { driverId, matchId } = req.body;
    
    if (!driverId || !matchId) {
      return res.status(400).json({
        success: false,
        error: 'driverId and matchId are required'
      });
    }

    console.log(`❌ Driver rejecting match: ${driverId}, match: ${matchId}`);

    // Update driver search to remove match
    const updates = {
      matchStatus: 'rejected',
      matchedWith: null,
      matchId: null,
      tripStatus: null,
      lastUpdated: Date.now()
    };

    if (firestoreService) {
      await firestoreService.updateDriverSearch(driverId, updates, { immediate: true });
    } else {
      await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(driverId).update({
        ...updates,
        updatedAt: new Date()
      });
    }

    // Update match status
    const matchUpdates = {
      driverStatus: 'rejected',
      status: 'rejected',
      lastUpdated: Date.now()
    };

    if (firestoreService) {
      await firestoreService.queueWrite(
        ACTIVE_MATCHES_COLLECTION,
        matchId,
        { ...matchUpdates, updatedAt: new Date() },
        'update'
      );
    } else {
      await db.collection(ACTIVE_MATCHES_COLLECTION).doc(matchId).update({
        ...matchUpdates,
        updatedAt: new Date()
      });
    }

    // Notify via WebSocket
    if (websocketServer) {
      websocketServer.sendMatchRejected(matchId, {
        driverId: driverId,
        status: 'rejected',
        reason: 'driver_rejected',
        timestamp: new Date().toISOString()
      });
    }

    console.log(`✅ Driver ${driverId} rejected match ${matchId}`);

    res.json({
      success: true,
      message: 'Match rejected successfully',
      driverId: driverId,
      matchId: matchId,
      immediateSave: true
    });

  } catch (error) {
    console.error('❌ Error rejecting match:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// ========== ✅ ENDPOINT 7: /api/driver/update-location ==========
router.post('/update-location', async (req, res) => {
  try {
    const { driverId, location, rideId } = req.body;
    
    if (!driverId || !location) {
      return res.status(400).json({
        success: false,
        error: 'driverId and location are required'
      });
    }

    console.log(`📍 Updating driver location: ${driverId}`);

    // Update driver search location
    const updates = {
      currentLocation: location,
      lastLocationUpdate: new Date(),
      lastUpdated: Date.now()
    };

    if (firestoreService) {
      await firestoreService.updateDriverSearch(driverId, updates, { immediate: true });
    } else {
      await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(driverId).update({
        ...updates,
        updatedAt: new Date()
      });
    }

    // If rideId exists, update ride location too
    if (rideId) {
      const rideUpdates = {
        driverLocation: location,
        lastLocationUpdate: new Date(),
        lastUpdated: Date.now()
      };

      if (firestoreService) {
        await firestoreService.queueWrite(
          ACTIVE_RIDES_COLLECTION,
          rideId,
          { ...rideUpdates, updatedAt: new Date() },
          'update'
        );
      } else {
        await db.collection(ACTIVE_RIDES_COLLECTION).doc(rideId).update({
          ...rideUpdates,
          updatedAt: new Date()
        });
      }
    }

    // Notify via WebSocket
    if (websocketServer) {
      websocketServer.sendLocationUpdate(driverId, {
        location: location,
        timestamp: new Date().toISOString(),
        rideId: rideId
      });
    }

    res.json({
      success: true,
      message: 'Location updated successfully',
      driverId: driverId,
      location: location,
      timestamp: new Date().toISOString(),
      immediateSave: true
    });

  } catch (error) {
    console.error('❌ Error updating location:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// ========== ✅ ENDPOINT 8: /api/driver/get-ride/:driverId ==========
router.get('/get-ride/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    
    if (!driverId) {
      return res.status(400).json({
        success: false,
        error: 'driverId is required'
      });
    }

    // Get driver search data
    let driverData;
    if (firestoreService) {
      driverData = await firestoreService.getDriverSearch(driverId);
    } else {
      const driverDoc = await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(driverId).get();
      driverData = driverDoc.exists ? { id: driverDoc.id, ...driverDoc.data() } : null;
    }
    
    if (!driverData || !driverData.rideId) {
      return res.json({
        success: true,
        hasRide: false,
        message: driverData ? 'No active ride found' : 'Driver not found',
        driverId: driverId
      });
    }

    // Get ride data
    const rideDoc = await db.collection(ACTIVE_RIDES_COLLECTION).doc(driverData.rideId).get();
    const rideData = rideDoc.exists ? { id: rideDoc.id, ...rideDoc.data() } : null;
    
    if (!rideData) {
      return res.json({
        success: true,
        hasRide: false,
        message: 'Ride data not found',
        driverId: driverId,
        rideId: driverData.rideId
      });
    }

    res.json({
      success: true,
      hasRide: true,
      driverId: driverId,
      rideId: driverData.rideId,
      rideData: rideData,
      passengerId: rideData.passengerId,
      pickupLocation: rideData.pickupLocation,
      destinationLocation: rideData.destinationLocation,
      status: rideData.status,
      tripStatus: rideData.tripStatus,
      estimatedFare: rideData.estimatedFare,
      collection: ACTIVE_RIDES_COLLECTION
    });

  } catch (error) {
    console.error('❌ Error getting driver ride:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// ========== ✅ ENDPOINT 9: /api/driver/update-status ==========
router.post('/update-status', async (req, res) => {
  try {
    const { driverId, isOnline, isSearching, status } = req.body;
    
    if (!driverId) {
      return res.status(400).json({
        success: false,
        error: 'driverId is required'
      });
    }

    console.log(`🔄 Updating driver status: ${driverId}`, { isOnline, isSearching, status });

    const updates = {
      lastUpdated: Date.now(),
      updatedAt: new Date()
    };

    if (isOnline !== undefined) updates.isOnline = isOnline;
    if (isSearching !== undefined) updates.isSearching = isSearching;
    if (status) updates.status = status;

    if (firestoreService) {
      await firestoreService.updateDriverSearch(driverId, updates, { immediate: true });
    } else {
      await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(driverId).update(updates);
    }

    res.json({
      success: true,
      message: 'Driver status updated successfully',
      driverId: driverId,
      updates: updates,
      immediateSave: true
    });

  } catch (error) {
    console.error('❌ Error updating driver status:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

module.exports = {
  router,
  init
};
