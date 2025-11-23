// routes/user.js
const express = require("express");
const router = express.Router();
const { db } = require("../app");
const { generateRouteHash } = require("../utils/routeMatching");

// Unified start search for both driver and passenger - UPDATED
router.post("/start-search", async (req, res) => {
  try {
    const {
      userId,
      userType,
      rideType,
      
      // User details
      driverName,
      driverPhone,
      driverPhotoUrl,
      passengerName,
      passengerPhone,
      passengerPhotoUrl,
      
      // Location data
      pickupLocation,
      destinationLocation,
      pickupName,
      destinationName,
      
      // Trip details
      capacity,
      currentPassengers = 0,
      passengerCount = 1,
      maxWalkDistance = 0.5,
      
      // Scheduling
      scheduledTime,
      
      // Preferences
      estimatedFare,
      specialRequests,
      preferredVehicleType,
      maxWaitTime = 30,
      
      // Route information
      distance,
      duration,
      fare,
      routePoints,
      
      // Vehicle info (for drivers)
      vehicleInfo
    } = req.body;

    console.log(`🚗 Starting ${userType} search:`, {
      userId,
      userType,
      rideType,
      route: `${pickupName} → ${destinationName}`
    });

    // Validate input
    if (!userId || !userType || !rideType || !pickupLocation || !destinationLocation) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: userId, userType, rideType, pickupLocation, destinationLocation"
      });
    }

    if (!['driver', 'passenger'].includes(userType)) {
      return res.status(400).json({
        success: false,
        error: "userType must be 'driver' or 'passenger'"
      });
    }

    if (!['immediate', 'scheduled'].includes(rideType)) {
      return res.status(400).json({
        success: false,
        error: "rideType must be 'immediate' or 'scheduled'"
      });
    }

    const isScheduled = rideType === 'scheduled';
    const now = new Date();
    
    // Determine expiry time
    let expiryDate;
    if (isScheduled && scheduledTime) {
      expiryDate = new Date(scheduledTime);
    } else {
      expiryDate = new Date(now.getTime() + 30 * 60000); // 30 minutes
    }

    // Build unified search data
    const searchData = {
      // User reference
      userId: userId,
      userType: userType,

      // User details based on type
      ...(userType === 'driver' ? {
        driverId: userId,
        driverPhone: driverPhone,
        driverName: driverName || 'Driver',
        driverPhotoUrl: driverPhotoUrl || '',
        driverContactPhone: driverPhone,
      } : {
        passengerId: userId,
        passengerPhone: passengerPhone,
        passengerName: passengerName || 'Passenger',
        passengerPhotoUrl: passengerPhotoUrl || '',
      }),

      // Search status
      isActive: true,
      searchType: isScheduled ? 'scheduled' : 'real_time',
      status: isScheduled ? 'scheduled' : 'searching',

      // Route information
      pickupName: pickupName || 'Pickup Location',
      destinationName: destinationName || 'Destination Location',
      pickupLocation: {
        lat: pickupLocation?.lat || 0,
        lng: pickupLocation?.lng || 0,
        address: pickupName || 'Pickup Location',
      },
      destinationLocation: {
        lat: destinationLocation?.lat || 0,
        lng: destinationLocation?.lng || 0,
        address: destinationName || 'Destination Location',
      },

      // Capacity information
      ...(userType === 'driver' ? {
        passengerCapacity: capacity || 4,
        currentPassengers: currentPassengers || 0,
      } : {
        passengerCount: passengerCount || 1,
        maxWalkDistance: maxWalkDistance,
      }),

      // Scheduling
      scheduledTime: isScheduled && scheduledTime ? new Date(scheduledTime).toISOString() : null,

      // TTL Fields for Firestore automatic deletion
      createdAt: now,
      expiryTime: expiryDate,

      // Additional fields
      maxWaitTime: maxWaitTime,
      preferredVehicleType: preferredVehicleType || 'car',
      estimatedFare: estimatedFare || 0,
      specialRequests: specialRequests || '',
      updatedAt: now,
    };

    // Add optional fields if they exist
    if (routePoints) searchData.routePoints = routePoints;
    if (distance) searchData.distance = distance;
    if (duration) searchData.duration = duration;
    if (fare) searchData.fare = fare;

    // Add vehicle info for drivers
    if (userType === 'driver' && vehicleInfo) {
      searchData.vehicleInfo = vehicleInfo;
    }

    let searchId;

    if (isScheduled) {
      // Save to scheduled rides collection
      if (userType === 'driver') {
        searchId = `driver_schedule_${now.getTime()}`;
        const scheduledRideData = {
          ...searchData,
          scheduleId: searchId,
          customerName: 'Not assigned',
          customerPhone: 'Not assigned',
          fareEstimate: estimatedFare || 0,
          notes: specialRequests || '',
        };
        await db.collection('driver_scheduled_rides').doc(searchId).set(scheduledRideData);
        console.log('✅ Driver scheduled ride saved:', searchId);
      } else {
        searchId = `passenger_schedule_${now.getTime()}`;
        const scheduledRideData = {
          ...searchData,
          scheduleId: searchId,
          driverName: 'Not assigned',
          driverPhone: 'Not assigned',
          fareEstimate: estimatedFare || 0,
          notes: specialRequests || '',
        };
        await db.collection('passenger_scheduled_rides').doc(searchId).set(scheduledRideData);
        console.log('✅ Passenger scheduled ride saved:', searchId);
      }
    } else {
      // Save to active_searches collection
      const docRef = await db.collection('active_searches').add(searchData);
      searchId = docRef.id;
      console.log(`✅ ${userType} active search saved:`, searchId);
    }

    // Update user document
    await updateUserDocument(searchData, searchId, isScheduled);

    res.json({
      success: true,
      searchId: searchId,
      message: `${userType} search started successfully`,
      data: searchData
    });

  } catch (error) {
    console.error('❌ Error starting user search:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: 'Failed to start search'
    });
  }
});

// Update user document based on type
async function updateUserDocument(userData, searchId, isScheduled) {
  try {
    const userPhone = userData.driverPhone || userData.passengerPhone || userData.userId;
    const userType = userData.userType;
    
    const userDoc = {
      isSearching: true,
      searchType: isScheduled ? 'scheduled' : 'real_time',
      currentScheduleId: isScheduled ? searchId : null,
      activeSearchId: isScheduled ? null : searchId,
      currentLocation: {
        lat: userData.pickupLocation.lat,
        lng: userData.pickupLocation.lng,
        address: userData.pickupName || 'Current Location',
      },

      // User personal information
      userId: userData.userId,
      ...(userType === 'driver' ? {
        driverId: userData.userId,
        driverName: userData.driverName,
        driverEmail: userData.driverEmail || 'No email',
        driverPhone: userPhone,
        driverPhoto: userData.driverPhotoUrl || '',
      } : {
        passengerId: userData.userId,
        passengerName: userData.passengerName,
        passengerEmail: userData.passengerEmail || 'No email',
        passengerPhone: userPhone,
        passengerPhoto: userData.passengerPhotoUrl || '',
      }),

      // Current search details
      currentSearch: {
        searchId: searchId,
        pickupLocation: userData.pickupLocation,
        destinationLocation: userData.destinationLocation,
        ...(userType === 'driver' ? {
          capacity: userData.passengerCapacity,
          currentPassengers: userData.currentPassengers,
        } : {
          passengerCount: userData.passengerCount,
        }),
        scheduledTime: userData.scheduledTime,
      },

      // Timestamps
      lastUpdated: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Add vehicle info for drivers
    if (userType === 'driver' && userData.vehicleInfo) {
      userDoc.vehicleInfo = userData.vehicleInfo;
    }

    const collectionName = userType === 'driver' ? 'drivers' : 'passengers';
    await db.collection(collectionName).doc(userPhone).set(userDoc, { merge: true });
    
    console.log(`✅ ${userType} document updated:`, userPhone);
    
  } catch (error) {
    console.error(`❌ Error updating ${userData.userType} document:`, error);
    throw error;
  }
}

// Unified stop search for both driver and passenger - UPDATED
router.post("/stop-search", async (req, res) => {
  try {
    const { userId, userType, rideType } = req.body;

    console.log(`🛑 Stopping search for ${userType}:`, { userId, rideType });

    const userPhone = await getUserPhone(userId, userType);

    // Update user document
    const collectionName = userType === 'driver' ? 'drivers' : 'passengers';
    await db.collection(collectionName).doc(userPhone).update({
      isSearching: false,
      isOnline: userType === 'driver' ? false : undefined, // Only for drivers
      activeSearchId: null,
      currentScheduleId: null,
      lastUpdated: new Date(),
    });

    // Handle different search types
    if (rideType === 'immediate' || rideType === 'real_time') {
      // Deactivate active searches
      const activeSearches = await db.collection('active_searches')
        .where('userId', '==', userId)
        .where('isActive', '==', true)
        .get();

      const batch = db.batch();
      activeSearches.docs.forEach(doc => {
        batch.update(doc.ref, {
          isActive: false,
          status: 'cancelled',
          updatedAt: new Date()
        });
      });
      await batch.commit();
      console.log(`✅ Deactivated ${activeSearches.size} active ${userType} searches`);
    } else if (rideType === 'scheduled') {
      // Cancel scheduled rides
      const scheduledCollection = userType === 'driver' ? 'driver_scheduled_rides' : 'passenger_scheduled_rides';
      const scheduledRides = await db.collection(scheduledCollection)
        .where('userId', '==', userId)
        .where('status', 'in', ['scheduled', 'searching', 'active'])
        .get();

      const batch = db.batch();
      scheduledRides.docs.forEach(doc => {
        batch.update(doc.ref, {
          status: 'cancelled',
          updatedAt: new Date()
        });
      });
      await batch.commit();
      console.log(`✅ Cancelled ${scheduledRides.size} scheduled ${userType} rides`);
    }

    res.json({
      success: true,
      message: `${userType} search stopped successfully`,
      userId: userId
    });

  } catch (error) {
    console.error(`❌ Error stopping ${req.body.userType} search:`, error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get user's current search status
router.get("/search-status/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { userType } = req.query;

    if (!userType) {
      return res.status(400).json({
        success: false,
        error: "userType query parameter is required"
      });
    }

    const userPhone = await getUserPhone(userId, userType);
    const collectionName = userType === 'driver' ? 'drivers' : 'passengers';

    const userDoc = await db.collection(collectionName).doc(userPhone).get();
    
    if (!userDoc.exists) {
      return res.json({
        success: true,
        isSearching: false,
        message: `${userType} not found`
      });
    }

    const userData = userDoc.data();
    
    res.json({
      success: true,
      isSearching: userData.isSearching || false,
      searchType: userData.searchType,
      activeSearchId: userData.activeSearchId,
      currentScheduleId: userData.currentScheduleId,
      userData: userData
    });

  } catch (error) {
    console.error('❌ Error getting user search status:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Cancel specific search
router.post("/cancel-search", async (req, res) => {
  try {
    const { searchId, searchType, userType } = req.body;

    console.log(`🗑️ Cancelling ${userType} search:`, { searchId, searchType });

    if (searchType === 'active_searches') {
      await db.collection('active_searches').doc(searchId).update({
        isActive: false,
        status: 'cancelled',
        updatedAt: new Date(),
      });
    } else if (searchType === 'driver_scheduled_rides' && userType === 'driver') {
      await db.collection('driver_scheduled_rides').doc(searchId).update({
        status: 'cancelled',
        updatedAt: new Date(),
      });
    } else if (searchType === 'passenger_scheduled_rides' && userType === 'passenger') {
      await db.collection('passenger_scheduled_rides').doc(searchId).update({
        status: 'cancelled',
        updatedAt: new Date(),
      });
    } else {
      throw new Error('Invalid search type or user type combination');
    }

    res.json({
      success: true,
      message: `${userType} search cancelled successfully`,
      searchId: searchId
    });

  } catch (error) {
    console.error(`❌ Error cancelling ${req.body.userType} search:`, error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Update user location
router.post("/update-location", async (req, res) => {
  try {
    const { userId, userType, location, address } = req.body;

    const userPhone = await getUserPhone(userId, userType);
    const collectionName = userType === 'driver' ? 'drivers' : 'passengers';

    await db.collection(collectionName).doc(userPhone).update({
      currentLocation: {
        lat: location.lat,
        lng: location.lng,
        address: address,
        updatedAt: new Date(),
      },
      lastUpdated: new Date(),
    });

    console.log(`📍 Updated ${userType} location:`, { userId, location });

    res.json({
      success: true,
      message: `${userType} location updated successfully`
    });

  } catch (error) {
    console.error(`❌ Error updating ${req.body.userType} location:`, error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get user details
router.get("/details/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { userType } = req.query;

    if (!userType) {
      return res.status(400).json({
        success: false,
        error: "userType query parameter is required"
      });
    }

    const collectionName = userType === 'driver' ? 'drivers' : 'passengers';
    const idField = userType === 'driver' ? 'driverId' : 'passengerId';

    const users = await db.collection(collectionName)
      .where(idField, '==', userId)
      .limit(1)
      .get();

    if (users.empty) {
      return res.status(404).json({
        success: false,
        error: `${userType} not found`
      });
    }

    const userData = users.docs[0].data();
    
    res.json({
      success: true,
      user: userData,
      userType: userType
    });

  } catch (error) {
    console.error('❌ Error getting user details:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get user's active matches
router.get("/matches/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { userType, status = 'proposed', limit = 10 } = req.query;

    if (!userType) {
      return res.status(400).json({
        success: false,
        error: "userType query parameter is required"
      });
    }

    console.log(`📋 Getting matches for ${userType}: ${userId}`);

    const idField = userType === 'driver' ? 'driverId' : 'passengerId';
    
    const matchesQuery = await db.collection('match_proposals')
      .where(idField, '==', userId)
      .where('status', '==', status)
      .orderBy('timestamp', 'desc')
      .limit(parseInt(limit))
      .get();

    const matches = matchesQuery.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    // Get counterpart details for each match
    const matchesWithDetails = await Promise.all(
      matches.map(async (match) => {
        const counterpartId = userType === 'driver' ? match.passengerId : match.driverId;
        const counterpartType = userType === 'driver' ? 'passenger' : 'driver';
        const counterpartDetails = await getUserDetails(counterpartId, counterpartType);
        
        return {
          ...match,
          counterpartDetails: counterpartDetails,
          counterpartType: counterpartType
        };
      })
    );

    res.json({
      success: true,
      matches: matchesWithDetails,
      total: matchesWithDetails.length,
      userType: userType
    });

  } catch (error) {
    console.error('❌ Error getting user matches:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Accept match
router.post("/accept-match", async (req, res) => {
  try {
    const { matchId, userId, userType } = req.body;

    console.log(`✅ ${userType} accepting match: ${matchId}`);

    // Use the matching service
    const matchingService = require('./matching');
    const matchResponse = await matchingService.acceptMatch({
      matchId,
      userId: userId,
      userType: userType
    });

    res.json(matchResponse);

  } catch (error) {
    console.error(`❌ Error ${req.body.userType} accepting match:`, error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Reject match
router.post("/reject-match", async (req, res) => {
  try {
    const { matchId, userId, userType, reason } = req.body;

    console.log(`❌ ${userType} rejecting match: ${matchId}`);

    // Use the matching service
    const matchingService = require('./matching');
    const matchResponse = await matchingService.rejectMatch({
      matchId,
      userId: userId,
      reason: reason
    });

    res.json(matchResponse);

  } catch (error) {
    console.error(`❌ Error ${req.body.userType} rejecting match:`, error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Helper function to get user phone number
async function getUserPhone(userId, userType) {
  // In a real implementation, you might want to look up the user's phone number
  // For now, we'll use the provided ID
  return userId;
}

// Helper function to get user details
async function getUserDetails(userId, userType) {
  try {
    const collectionName = userType === 'driver' ? 'drivers' : 'passengers';
    const idField = userType === 'driver' ? 'driverId' : 'passengerId';

    const userQuery = await db.collection(collectionName)
      .where(idField, '==', userId)
      .limit(1)
      .get();

    if (!userQuery.empty) {
      return userQuery.docs[0].data();
    }
    return null;
  } catch (error) {
    console.error(`Error getting ${userType} details:`, error);
    return null;
  }
}

module.exports = router;
