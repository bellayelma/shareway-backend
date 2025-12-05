// controllers/driverController.js - FIXED VERSION
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

// Services
let services;
let firestoreService;
let db;
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
  firestoreService = serviceContainer.firestoreService;
  searchService = serviceContainer.searchService;
  rideService = serviceContainer.rideService;
  matchingService = serviceContainer.matchingService;
  websocketServer = serviceContainer.websocketServer;
  
  console.log('✅ DriverController initialized with services:');
  console.log('- firestoreService:', firestoreService ? '✅' : '❌');
  console.log('- db:', db ? '✅' : '❌');
  console.log('- searchService:', searchService ? '✅' : '❌');
  console.log('- websocketServer:', websocketServer ? '✅' : '❌');
};

// ========== ✅ ENDPOINT 1: /api/driver/start-search ==========
router.post('/start-search', async (req, res) => {
  try {
    console.log('🚗 === DRIVER START-SEARCH ENDPOINT ===');
    
    // DEBUG: Log everything received
    console.log('📦 Full request body:');
    console.log(JSON.stringify(req.body, null, 2));
    
    console.log('🔍 Checking driver data in request:');
    console.log('- driverName from request:', req.body.driverName);
    console.log('- driverPhone from request:', req.body.driverPhone);
    console.log('- driverPhotoUrl from request:', req.body.driverPhotoUrl);
    console.log('- vehicleInfo from request:', req.body.vehicleInfo);
    
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
    
    // Determine actual driver ID
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
    console.log(`   - Driver ID (document ID): ${actualUserId}`);

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
      
      // Vehicle information
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
      
      // System data
      createdAt: new Date(),
      updatedAt: new Date(),
      lastUpdated: Date.now()
    };

    console.log('📋 Prepared driver search data:', JSON.stringify(searchData, null, 2));

    // Use FirestoreService to save with immediate option
    if (firestoreService) {
      console.log('⚡ Using FirestoreService with immediate save');
      const savedData = await firestoreService.saveDriverSearch(searchData, { immediate: true });
      console.log(`✅ Driver search saved: ${savedData.driverName}`);
      
      // Verify it was saved
      const verification = await firestoreService.verifyDocumentExists(
        ACTIVE_SEARCHES_DRIVER_COLLECTION, 
        actualUserId
      );
      
      if (verification.exists) {
        console.log('✅ VERIFIED - Driver data saved to Firestore');
        console.log('- Document ID:', actualUserId);
        console.log('- Driver Phone in DB:', verification.data.driverPhone);
        console.log('- Driver Photo in DB:', verification.data.driverPhotoUrl);
      } else {
        console.log('❌ VERIFICATION FAILED - Driver data not saved');
      }
    } else {
      console.warn('⚠️ FirestoreService not available, using direct Firestore');
      await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(actualUserId).set(searchData);
    }
    
    // Also add to search service for in-memory matching
    if (searchService) {
      await searchService.addSearch(searchData);
      console.log('✅ Added to in-memory search service');
    }

    // Return response with all driver data
    res.json({
      success: true,
      message: 'Driver search started successfully',
      searchId: searchData.searchId,
      userId: actualUserId,
      documentId: actualUserId,  // IMPORTANT: Return the document ID
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
      importantNote: 'Use this documentId for all subsequent API calls'
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
        collection: ACTIVE_SEARCHES_DRIVER_COLLECTION,
        suggestion: 'Make sure driver has started search first'
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
      documentId: driverId,  // Return the document ID
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
      isOnline: driverData.isOnline,
      importantNote: 'Use this documentId for all API calls'
    });

  } catch (error) {
    console.error('❌ Error getting driver search status:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// ========== ✅ ENDPOINT 4: /api/driver/update-location ==========
router.post('/update-location', async (req, res) => {
  try {
    console.log('📍 === DRIVER UPDATE LOCATION ENDPOINT ===');
    
    const { userId, driverId, location, address } = req.body;
    
    console.log('📦 Request body:', JSON.stringify(req.body, null, 2));
    
    // FIRST: Try to get the actual driver document ID from Firestore
    let actualDriverId = driverId || userId;
    
    if (!actualDriverId) {
      return res.status(400).json({
        success: false,
        error: 'driverId or userId is required'
      });
    }
    
    if (!location || !location.lat || !location.lng) {
      return res.status(400).json({
        success: false,
        error: 'Valid location with lat and lng is required'
      });
    }
    
    console.log(`📍 Updating driver location: ${actualDriverId}`);
    console.log(`   Location: ${location.lat}, ${location.lng}`);
    
    // CRITICAL FIX: Check if document exists with this ID
    const driverDoc = await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(actualDriverId).get();
    
    if (!driverDoc.exists) {
      console.log(`⚠️ Document not found with ID: ${actualDriverId}`);
      
      // Try to find driver by phone number
      console.log('🔍 Searching for driver by phone number...');
      
      const querySnapshot = await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION)
        .where('driverPhone', '==', actualDriverId)
        .limit(1)
        .get();
      
      if (!querySnapshot.empty) {
        // Found by phone number
        const foundDriver = querySnapshot.docs[0];
        actualDriverId = foundDriver.id;
        console.log(`✅ Found driver by phone: ${actualDriverId}`);
      } else {
        // Try searching by userId field
        const userIdQuery = await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION)
          .where('userId', '==', actualDriverId)
          .limit(1)
          .get();
          
        if (!userIdQuery.empty) {
          const foundDriver = userIdQuery.docs[0];
          actualDriverId = foundDriver.id;
          console.log(`✅ Found driver by userId: ${actualDriverId}`);
        } else {
          return res.status(404).json({
            success: false,
            error: `Driver document not found with ID: ${actualDriverId}`,
            suggestion: 'Make sure driver search is active first using /api/driver/start-search'
          });
        }
      }
    }
    
    console.log(`📍 Using actual driver document ID: ${actualDriverId}`);
    
    // Update driver location in Firestore
    await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(actualDriverId).update({
      currentLocation: {
        latitude: location.lat,
        longitude: location.lng,
        accuracy: location.accuracy || 0,
        address: address || '',
        timestamp: new Date()
      },
      updatedAt: new Date(),
      lastUpdated: Date.now()
    });

    // If driver has a passenger, update passenger's embedded driver location
    const updatedDriverDoc = await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(actualDriverId).get();
    if (updatedDriverDoc.exists) {
      const driverData = updatedDriverDoc.data();
      
      if (driverData.matchedWith && driverData.passenger) {
        await db.collection(ACTIVE_SEARCHES_PASSENGER_COLLECTION).doc(driverData.matchedWith).update({
          'driver.currentLocation': {
            latitude: location.lat,
            longitude: location.lng,
            timestamp: new Date()
          },
          updatedAt: new Date()
        });
        
        // Notify passenger via WebSocket
        if (websocketServer) {
          websocketServer.sendDriverLocationUpdate(driverData.matchedWith, {
            driverId: actualDriverId,
            driverName: driverData.driverName,
            location: {
              lat: location.lat,
              lng: location.lng
            },
            timestamp: new Date().toISOString()
          });
        }
        
        console.log(`✅ Passenger notified of driver location update: ${driverData.matchedWith}`);
      }
    }

    res.json({
      success: true,
      message: 'Driver location updated successfully',
      driverId: actualDriverId,
      originalDriverId: driverId || userId,
      location: {
        lat: location.lat,
        lng: location.lng
      },
      address: address || '',
      timestamp: new Date().toISOString(),
      passengerNotified: true,
      note: `Use '${actualDriverId}' as driverId for future calls`
    });

  } catch (error) {
    console.error('❌ Error updating driver location:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// ========== ✅ ENDPOINT 5: /api/driver/availability ==========
router.post('/availability', async (req, res) => {
  try {
    const { userId, driverId, isAvailable } = req.body;
    
    const actualDriverId = driverId || userId;
    
    if (!actualDriverId) {
      return res.status(400).json({
        success: false,
        error: 'driverId or userId is required'
      });
    }

    if (isAvailable === undefined) {
      return res.status(400).json({
        success: false,
        error: 'isAvailable is required'
      });
    }

    console.log(`🔄 Setting driver availability: ${actualDriverId} = ${isAvailable}`);

    await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(actualDriverId).update({
      isOnline: isAvailable,
      isSearching: isAvailable,
      updatedAt: new Date(),
      lastUpdated: Date.now()
    });

    // Notify via WebSocket if going offline
    if (!isAvailable && websocketServer) {
      websocketServer.sendSearchStopped(actualDriverId, {
        userType: 'driver',
        reason: 'driver_went_offline',
        message: 'Driver is now offline'
      });
    }

    res.json({
      success: true,
      driverId: actualDriverId,
      isAvailable: isAvailable,
      isOnline: isAvailable,
      isSearching: isAvailable,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error setting driver availability:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// ========== ✅ ENDPOINT 6: /api/driver/accept-match ==========
router.post('/accept-match', async (req, res) => {
  try {
    console.log('✅ === DRIVER ACCEPT MATCH ENDPOINT ===');
    
    const { driverId, userId, matchId, passengerId } = req.body;
    
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
    
    console.log(`🤝 Driver ${actualDriverId} accepting match ${matchId} with passenger ${passengerId}`);

    // Get driver document
    const driverDoc = await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(actualDriverId).get();
    if (!driverDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Driver not found in active searches'
      });
    }
    
    const driverData = driverDoc.data();
    
    // Verify match exists and is proposed
    if (driverData.matchId !== matchId || driverData.matchStatus !== 'proposed') {
      return res.status(400).json({
        success: false,
        error: 'Invalid match or match already processed'
      });
    }
    
    // Verify matched with correct passenger
    if (driverData.matchedWith !== passengerId) {
      return res.status(400).json({
        success: false,
        error: 'Passenger ID does not match proposed match'
      });
    }
    
    // Get passenger document
    const passengerDoc = await db.collection(ACTIVE_SEARCHES_PASSENGER_COLLECTION).doc(passengerId).get();
    if (!passengerDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Passenger not found in active searches'
      });
    }
    
    const passengerData = passengerDoc.data();
    
    // Check if driver has available seats
    const passengerCount = passengerData.passengerCount || 1;
    const availableSeats = driverData.availableSeats || driverData.capacity || 4;
    if (availableSeats < passengerCount) {
      return res.status(400).json({
        success: false,
        error: `Not enough available seats. Available: ${availableSeats}, Needed: ${passengerCount}`
      });
    }
    
    // Generate ride ID
    const rideId = `ride_${uuidv4()}`;
    
    // Create active ride
    const rideData = {
      rideId: rideId,
      driverId: actualDriverId,
      driverName: driverData.driverName,
      driverPhone: driverData.driverPhone,
      driverPhotoUrl: driverData.driverPhotoUrl,
      driverRating: driverData.driverRating,
      vehicleInfo: driverData.vehicleInfo,
      passengerId: passengerId,
      passengerName: passengerData.passengerName,
      passengerPhone: passengerData.passengerPhone,
      passengerPhotoUrl: passengerData.passengerPhotoUrl,
      pickupLocation: passengerData.pickupLocation || driverData.pickupLocation,
      pickupName: passengerData.pickupName || driverData.pickupName,
      destinationLocation: passengerData.destinationLocation || driverData.destinationLocation,
      destinationName: passengerData.destinationName || driverData.destinationName,
      distance: passengerData.distance || driverData.distance,
      duration: passengerData.duration || driverData.duration,
      estimatedFare: passengerData.estimatedFare || driverData.estimatedFare,
      rideType: driverData.rideType || passengerData.rideType || 'immediate',
      scheduledTime: driverData.scheduledTime || passengerData.scheduledTime,
      status: 'driver_accepted',
      matchId: matchId,
      tripStatus: 'driver_accepted',
      acceptedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await db.collection(ACTIVE_RIDES_COLLECTION).doc(rideId).set(rideData);
    console.log(`✅ Created active ride: ${rideId}`);
    
    // Update driver document
    const driverUpdates = {
      matchId: matchId,
      matchedWith: passengerId,
      matchStatus: 'accepted',
      rideId: rideId,
      tripStatus: 'driver_accepted',
      passenger: {
        passengerId: passengerId,
        passengerName: passengerData.passengerName,
        passengerPhone: passengerData.passengerPhone,
        passengerPhotoUrl: passengerData.passengerPhotoUrl,
        pickupLocation: passengerData.pickupLocation,
        pickupName: passengerData.pickupName,
        destinationLocation: passengerData.destinationLocation,
        destinationName: passengerData.destinationName,
        passengerCount: passengerCount,
        matchAcceptedAt: new Date()
      },
      currentPassengers: (driverData.currentPassengers || 0) + passengerCount,
      availableSeats: Math.max(0, availableSeats - passengerCount),
      acceptedAt: new Date(),
      lastUpdated: Date.now()
    };

    await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(actualDriverId).update(driverUpdates);
    console.log(`✅ Updated driver ${actualDriverId} with passenger acceptance`);
    
    // Update passenger document
    const passengerUpdates = {
      matchId: matchId,
      matchedWith: actualDriverId,
      matchStatus: 'accepted',
      rideId: rideId,
      tripStatus: 'driver_accepted',
      driver: {
        driverId: actualDriverId,
        driverName: driverData.driverName,
        driverPhone: driverData.driverPhone,
        driverPhotoUrl: driverData.driverPhotoUrl,
        driverRating: driverData.driverRating,
        vehicleInfo: driverData.vehicleInfo,
        vehicleType: driverData.vehicleType,
        capacity: driverData.capacity,
        currentPassengers: driverUpdates.currentPassengers,
        availableSeats: driverUpdates.availableSeats,
        matchAcceptedAt: new Date()
      },
      acceptedAt: new Date(),
      lastUpdated: Date.now()
    };

    await db.collection(ACTIVE_SEARCHES_PASSENGER_COLLECTION).doc(passengerId).update(passengerUpdates);
    console.log(`✅ Updated passenger ${passengerId} with driver acceptance`);
    
    // Update match document
    await db.collection(ACTIVE_MATCHES_COLLECTION).doc(matchId).update({
      matchStatus: 'accepted',
      rideId: rideId,
      acceptedAt: new Date(),
      updatedAt: new Date()
    });
    
    // Stop searching for passenger
    if (searchService) {
      await searchService.removeSearch(passengerId, 'passenger');
    }
    
    // Notify both users via WebSocket
    if (websocketServer) {
      // Notify driver
      websocketServer.sendMatchAccepted(actualDriverId, {
        matchId: matchId,
        rideId: rideId,
        passengerId: passengerId,
        passengerName: passengerData.passengerName,
        passengerPhone: passengerData.passengerPhone,
        pickupName: passengerData.pickupName || driverData.pickupName,
        destinationName: passengerData.destinationName || driverData.destinationName,
        passengerCount: passengerCount,
        message: 'Passenger accepted successfully!',
        nextStep: 'Proceed to pickup location'
      });
      
      // Notify passenger
      websocketServer.sendMatchAccepted(passengerId, {
        matchId: matchId,
        rideId: rideId,
        driverId: actualDriverId,
        driverName: driverData.driverName,
        driverPhone: driverData.driverPhone,
        driverPhotoUrl: driverData.driverPhotoUrl,
        driverRating: driverData.driverRating,
        vehicleInfo: driverData.vehicleInfo,
        pickupName: passengerData.pickupName || driverData.pickupName,
        destinationName: passengerData.destinationName || driverData.destinationName,
        estimatedFare: passengerData.estimatedFare || driverData.estimatedFare,
        message: 'Driver has accepted your ride!',
        nextStep: 'Wait for driver to arrive'
      });
    }
    
    res.json({
      success: true,
      message: 'Passenger accepted successfully',
      matchId: matchId,
      rideId: rideId,
      driverId: actualDriverId,
      driverName: driverData.driverName,
      passengerId: passengerId,
      passengerName: passengerData.passengerName,
      passengerCount: passengerCount,
      availableSeats: driverUpdates.availableSeats,
      currentPassengers: driverUpdates.currentPassengers,
      rideData: rideData,
      nextStep: 'Proceed to pickup location',
      websocketNotification: true
    });
    
  } catch (error) {
    console.error('❌ Error accepting passenger:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// ========== ✅ ENDPOINT 7: /api/driver/reject-match ==========
router.post('/reject-match', async (req, res) => {
  try {
    const { driverId, userId, matchId, passengerId, userType = 'driver' } = req.body;
    
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
    
    console.log(`❌ Driver ${actualUserId} rejecting match ${matchId}`);

    // Clear from Firestore first
    await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(actualUserId).update({
      matchId: null,
      matchedWith: null,
      matchStatus: null,
      passenger: null,
      lastUpdated: Date.now()
    });
    
    // Update match document
    await db.collection(ACTIVE_MATCHES_COLLECTION).doc(matchId).update({
      matchStatus: 'rejected',
      rejectedAt: new Date(),
      updatedAt: new Date(),
      rejectedBy: userType,
      rejectedByUserId: actualUserId
    });
    
    console.log(`✅ Match ${matchId} rejected by driver ${actualUserId}`);

    // Also update passenger if match existed
    if (passengerId) {
      await db.collection(ACTIVE_SEARCHES_PASSENGER_COLLECTION).doc(passengerId).update({
        matchId: null,
        matchedWith: null,
        matchStatus: null,
        driver: null,
        lastUpdated: Date.now()
      });
      
      // Notify passenger
      if (websocketServer) {
        websocketServer.sendMatchRejected(passengerId, {
          matchId: matchId,
          driverId: actualUserId,
          message: 'Driver rejected the match proposal'
        });
      }
    }

    res.json({
      success: true,
      message: 'Match rejected successfully',
      matchId: matchId,
      driverId: actualUserId,
      userType: userType,
      websocketNotification: true
    });

  } catch (error) {
    console.error('❌ Error rejecting match:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// ========== ✅ ENDPOINT 8: /api/driver/status/:driverId ==========
router.get('/status/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    
    console.log(`🔍 Getting driver status: ${driverId}`);

    if (!driverId) {
      return res.status(400).json({
        success: false,
        error: 'driverId parameter is required'
      });
    }

    const driverDoc = await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(driverId).get();
    
    if (!driverDoc.exists) {
      return res.json({
        success: true,
        exists: false,
        message: 'Driver not found',
        driverId: driverId
      });
    }

    const driverData = driverDoc.data();
    
    // Get match and ride data
    let matchData = null;
    let rideData = null;
    
    if (driverData.matchId) {
      const matchDoc = await db.collection(ACTIVE_MATCHES_COLLECTION).doc(driverData.matchId).get();
      if (matchDoc.exists) {
        matchData = matchDoc.data();
      }
    }
    
    if (driverData.rideId) {
      const rideDoc = await db.collection(ACTIVE_RIDES_COLLECTION).doc(driverData.rideId).get();
      if (rideDoc.exists) {
        rideData = rideDoc.data();
      }
    }

    res.json({
      success: true,
      driver: {
        id: driverId,
        name: driverData.driverName,
        phone: driverData.driverPhone,
        photoUrl: driverData.driverPhotoUrl,
        rating: driverData.driverRating,
        vehicleInfo: driverData.vehicleInfo,
        isOnline: driverData.isOnline,
        isSearching: driverData.isSearching,
        status: driverData.status,
        matchStatus: driverData.matchStatus,
        currentPassengers: driverData.currentPassengers || 0,
        availableSeats: driverData.availableSeats || driverData.capacity || 4,
        capacity: driverData.capacity || 4
      },
      match: matchData ? {
        id: matchData.matchId,
        status: matchData.matchStatus,
        passengerId: matchData.passengerId,
        passengerName: matchData.passengerName,
        createdAt: matchData.createdAt
      } : null,
      ride: rideData ? {
        id: rideData.rideId,
        status: rideData.status,
        passengerName: rideData.passengerName,
        pickupName: rideData.pickupName,
        destinationName: rideData.destinationName
      } : null,
      passenger: driverData.passenger,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error getting driver status:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// ========== ✅ ENDPOINT 9: /api/driver/find-by-phone/:phone ==========
router.get('/find-by-phone/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    
    console.log(`🔍 Finding driver by phone: ${phone}`);

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: 'Phone number is required'
      });
    }

    // Search for driver by phone
    const querySnapshot = await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION)
      .where('driverPhone', '==', phone)
      .limit(1)
      .get();
    
    if (querySnapshot.empty) {
      return res.json({
        success: true,
        found: false,
        message: 'Driver not found with this phone number',
        phone: phone
      });
    }

    const driverDoc = querySnapshot.docs[0];
    const driverData = driverDoc.data();
    
    res.json({
      success: true,
      found: true,
      driverId: driverDoc.id,
      driver: {
        name: driverData.driverName,
        phone: driverData.driverPhone,
        photoUrl: driverData.driverPhotoUrl,
        rating: driverData.driverRating,
        isOnline: driverData.isOnline,
        isSearching: driverData.isSearching,
        status: driverData.status
      },
      note: `Use '${driverDoc.id}' as driverId for API calls`
    });

  } catch (error) {
    console.error('❌ Error finding driver by phone:', error);
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
