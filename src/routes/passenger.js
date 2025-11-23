// routes/passenger.js
const express = require("express");
const router = express.Router();
const { db } = require("../app");

// Passenger starts searching - UPDATED to match Flutter structure
router.post("/start-search", async (req, res) => {
  try {
    const {
      userId,
      userType,
      rideType,
      
      // Passenger details
      passengerId,
      passengerName,
      passengerPhone,
      passengerPhotoUrl,
      
      // Location data
      pickupLocation,
      destinationLocation,
      pickupName,
      destinationName,
      
      // Trip details
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
      routePoints
    } = req.body;

    console.log('🚶 Passenger starting search:', {
      passengerId: passengerId || userId,
      passengerName,
      rideType,
      route: `${pickupName} → ${destinationName}`,
      passengerCount
    });

    const isScheduled = rideType === 'scheduled';
    const now = new Date();
    
    // Determine expiry time
    let expiryDate;
    if (isScheduled && scheduledTime) {
      expiryDate = new Date(scheduledTime);
    } else {
      expiryDate = new Date(now.getTime() + 30 * 60000); // 30 minutes
    }

    // Build search data
    const searchData = {
      // Passenger reference and details
      userId: passengerId || userId,
      userType: 'passenger',
      passengerId: passengerId || userId,
      passengerPhone: passengerPhone,
      passengerName: passengerName || 'Passenger',
      passengerPhotoUrl: passengerPhotoUrl || '',

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

      // Passenger information
      passengerCount: passengerCount,
      maxWalkDistance: maxWalkDistance,

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

    let searchId;

    if (isScheduled) {
      // Save to passenger_scheduled_rides collection
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
    } else {
      // Save to active_searches collection
      const docRef = await db.collection('active_searches').add(searchData);
      searchId = docRef.id;
      console.log('✅ Passenger active search saved:', searchId);
    }

    // Update passenger document
    await updatePassengerDocument(searchData, searchId, isScheduled);

    res.json({
      success: true,
      searchId: searchId,
      message: 'Passenger search started successfully',
      data: searchData
    });

  } catch (error) {
    console.error('❌ Error starting passenger search:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: 'Failed to start passenger search'
    });
  }
});

// Update passenger document
async function updatePassengerDocument(passengerData, searchId, isScheduled) {
  try {
    const passengerPhone = passengerData.passengerPhone || passengerData.userId;
    
    const passengerDoc = {
      isSearching: true,
      searchType: isScheduled ? 'scheduled' : 'real_time',
      currentScheduleId: isScheduled ? searchId : null,
      activeSearchId: isScheduled ? null : searchId,
      currentLocation: {
        lat: passengerData.pickupLocation.lat,
        lng: passengerData.pickupLocation.lng,
        address: passengerData.pickupName || 'Current Location',
      },

      // Passenger personal information
      passengerId: passengerData.passengerId,
      passengerName: passengerData.passengerName,
      passengerEmail: passengerData.passengerEmail || 'No email',
      passengerPhone: passengerPhone,
      passengerPhoto: passengerData.passengerPhotoUrl || '',

      // Current search details
      currentSearch: {
        searchId: searchId,
        pickupLocation: passengerData.pickupLocation,
        destinationLocation: passengerData.destinationLocation,
        passengerCount: passengerData.passengerCount,
        scheduledTime: passengerData.scheduledTime,
      },

      // Timestamps
      lastUpdated: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.collection('passengers').doc(passengerPhone).set(passengerDoc, { merge: true });
    console.log('✅ Passenger document updated:', passengerPhone);
    
  } catch (error) {
    console.error('❌ Error updating passenger document:', error);
    throw error;
  }
}

// Passenger stops searching - UPDATED
router.post("/stop-search", async (req, res) => {
  try {
    const { userId, userType, rideType, passengerId } = req.body;

    console.log('🛑 Stopping search for passenger:', { userId, passengerId, rideType });

    const passengerPhone = await getPassengerPhone(userId, passengerId);

    // Update passenger document
    await db.collection('passengers').doc(passengerPhone).update({
      isSearching: false,
      activeSearchId: null,
      currentScheduleId: null,
      lastUpdated: new Date(),
    });

    // Handle different search types
    if (rideType === 'immediate' || rideType === 'real_time') {
      // Deactivate active searches
      const activeSearches = await db.collection('active_searches')
        .where('userId', '==', passengerId || userId)
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
      console.log(`✅ Deactivated ${activeSearches.size} active passenger searches`);
    } else if (rideType === 'scheduled') {
      // Cancel scheduled rides
      const scheduledRides = await db.collection('passenger_scheduled_rides')
        .where('passengerId', '==', passengerId || userId)
        .where('status', 'in', ['scheduled', 'searching'])
        .get();

      const batch = db.batch();
      scheduledRides.docs.forEach(doc => {
        batch.update(doc.ref, {
          status: 'cancelled',
          updatedAt: new Date()
        });
      });
      await batch.commit();
      console.log(`✅ Cancelled ${scheduledRides.size} scheduled passenger rides`);
    }

    res.json({
      success: true,
      message: 'Passenger search stopped successfully',
      passengerId: passengerId || userId
    });

  } catch (error) {
    console.error('❌ Error stopping passenger search:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get passenger's current search status
router.get("/search-status/:passengerId", async (req, res) => {
  try {
    const { passengerId } = req.params;
    const passengerPhone = await getPassengerPhone(passengerId);

    const passengerDoc = await db.collection('passengers').doc(passengerPhone).get();
    
    if (!passengerDoc.exists) {
      return res.json({
        success: true,
        isSearching: false,
        message: 'Passenger not found'
      });
    }

    const passengerData = passengerDoc.data();
    
    res.json({
      success: true,
      isSearching: passengerData.isSearching || false,
      searchType: passengerData.searchType,
      activeSearchId: passengerData.activeSearchId,
      currentScheduleId: passengerData.currentScheduleId,
      passengerData: passengerData
    });

  } catch (error) {
    console.error('❌ Error getting passenger search status:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Cancel specific passenger search
router.post("/cancel-search", async (req, res) => {
  try {
    const { searchId, searchType } = req.body;

    console.log('🗑️ Cancelling passenger search:', { searchId, searchType });

    if (searchType === 'active_searches') {
      await db.collection('active_searches').doc(searchId).update({
        isActive: false,
        status: 'cancelled',
        updatedAt: new Date(),
      });
    } else if (searchType === 'passenger_scheduled_rides') {
      await db.collection('passenger_scheduled_rides').doc(searchId).update({
        status: 'cancelled',
        updatedAt: new Date(),
      });
    } else {
      throw new Error('Invalid search type');
    }

    res.json({
      success: true,
      message: 'Passenger search cancelled successfully',
      searchId: searchId
    });

  } catch (error) {
    console.error('❌ Error cancelling passenger search:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Update passenger location
router.post("/update-location", async (req, res) => {
  try {
    const { userId, passengerId, location, address } = req.body;

    const passengerPhone = await getPassengerPhone(userId, passengerId);

    await db.collection('passengers').doc(passengerPhone).update({
      currentLocation: {
        lat: location.lat,
        lng: location.lng,
        address: address,
        updatedAt: new Date(),
      },
      lastUpdated: new Date(),
    });

    console.log('📍 Updated passenger location:', { passengerId, location });

    res.json({
      success: true,
      message: 'Passenger location updated successfully'
    });

  } catch (error) {
    console.error('❌ Error updating passenger location:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get passenger details
router.get("/details/:passengerId", async (req, res) => {
  try {
    const { passengerId } = req.params;

    const passengers = await db.collection('passengers')
      .where('passengerId', '==', passengerId)
      .limit(1)
      .get();

    if (passengers.empty) {
      return res.status(404).json({
        success: false,
        error: 'Passenger not found'
      });
    }

    const passengerData = passengers.docs[0].data();
    
    res.json({
      success: true,
      passenger: passengerData
    });

  } catch (error) {
    console.error('❌ Error getting passenger details:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get passenger's active matches
router.get("/matches/:passengerId", async (req, res) => {
  try {
    const { passengerId } = req.params;
    const { status = 'proposed', limit = 10 } = req.query;

    console.log(`📋 Getting matches for passenger: ${passengerId}`);

    const matchesQuery = await db.collection('match_proposals')
      .where('passengerId', '==', passengerId)
      .where('status', '==', status)
      .orderBy('timestamp', 'desc')
      .limit(parseInt(limit))
      .get();

    const matches = matchesQuery.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    // Get driver details for each match
    const matchesWithDriverDetails = await Promise.all(
      matches.map(async (match) => {
        const driverDetails = await getDriverDetails(match.driverId);
        return {
          ...match,
          driverDetails: driverDetails
        };
      })
    );

    res.json({
      success: true,
      matches: matchesWithDriverDetails,
      total: matchesWithDriverDetails.length
    });

  } catch (error) {
    console.error('❌ Error getting passenger matches:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Passenger accepts a match
router.post("/accept-match", async (req, res) => {
  try {
    const { matchId, passengerId } = req.body;

    console.log(`✅ Passenger accepting match: ${matchId}`);

    // Use the matching service's accept endpoint
    const matchResponse = await require('./matching').acceptMatch({
      matchId,
      userId: passengerId,
      userType: 'passenger'
    });

    res.json(matchResponse);

  } catch (error) {
    console.error('❌ Error passenger accepting match:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Passenger rejects a match
router.post("/reject-match", async (req, res) => {
  try {
    const { matchId, passengerId, reason } = req.body;

    console.log(`❌ Passenger rejecting match: ${matchId}`);

    // Use the matching service's reject endpoint
    const matchResponse = await require('./matching').rejectMatch({
      matchId,
      userId: passengerId,
      reason: reason
    });

    res.json(matchResponse);

  } catch (error) {
    console.error('❌ Error passenger rejecting match:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get nearby drivers for passenger
router.post("/nearby-drivers", async (req, res) => {
  try {
    const { passengerId, location, radiusInKm = 5, limit = 10 } = req.body;

    console.log(`🔍 Finding nearby drivers for passenger: ${passengerId}`);

    // Get all active drivers
    const driversSnapshot = await db.collection('drivers')
      .where('isOnline', '==', true)
      .where('isSearching', '==', true)
      .limit(limit)
      .get();

    const nearbyDrivers = [];
    
    driversSnapshot.docs.forEach(doc => {
      const driverData = doc.data();
      const driverLocation = driverData.currentLocation;
      
      if (driverLocation && driverLocation.lat && driverLocation.lng) {
        const distance = calculateDistance(
          location.lat,
          location.lng,
          driverLocation.lat,
          driverLocation.lng
        );

        if (distance <= radiusInKm) {
          nearbyDrivers.push({
            driverId: driverData.driverId,
            driverName: driverData.driverName || 'Driver',
            driverPhone: driverData.driverPhone || '',
            currentLocation: driverLocation,
            vehicleInfo: driverData.vehicleInfo,
            rating: driverData.rating || 5.0,
            distance: distance,
            availableSeats: (driverData.vehicleInfo?.capacity || 4) - (driverData.currentSearch?.currentPassengers || 0),
            documentId: doc.id
          });
        }
      }
    });

    // Sort by distance
    nearbyDrivers.sort((a, b) => a.distance - b.distance);

    console.log(`✅ Found ${nearbyDrivers.length} nearby drivers for passenger ${passengerId}`);

    res.json({
      success: true,
      drivers: nearbyDrivers,
      total: nearbyDrivers.length
    });

  } catch (error) {
    console.error('❌ Error finding nearby drivers for passenger:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get passenger ride history
router.get("/ride-history/:passengerId", async (req, res) => {
  try {
    const { passengerId } = req.params;
    const { limit = 20 } = req.query;

    console.log(`📋 Getting ride history for passenger: ${passengerId}`);

    const ridesQuery = await db.collection('completed_rides')
      .where('passengerId', '==', passengerId)
      .orderBy('createdAt', 'desc')
      .limit(parseInt(limit))
      .get();

    const rides = ridesQuery.docs.map(doc => ({
      rideId: doc.id,
      ...doc.data()
    }));

    res.json({
      success: true,
      rides: rides,
      total: rides.length
    });

  } catch (error) {
    console.error('❌ Error getting passenger ride history:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Helper function to get passenger phone number
async function getPassengerPhone(userId, passengerId) {
  // In a real implementation, you might want to look up the passenger's phone number
  // For now, we'll use the provided ID or try to find it in the passengers collection
  return passengerId || userId;
}

// Helper function to get driver details
async function getDriverDetails(driverId) {
  try {
    const driverQuery = await db.collection('drivers')
      .where('driverId', '==', driverId)
      .limit(1)
      .get();

    if (!driverQuery.empty) {
      return driverQuery.docs[0].data();
    }
    return null;
  } catch (error) {
    console.error('Error getting driver details:', error);
    return null;
  }
}

// Helper function to calculate distance between two points (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

module.exports = router;
