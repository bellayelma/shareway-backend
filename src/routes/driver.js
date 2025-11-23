// routes/driver.js
const express = require("express");
const router = express.Router();
const { db } = require("../app");

// Driver starts searching - UPDATED to handle all driver search data
router.post("/start-search", async (req, res) => {
  try {
    const {
      userId,
      userType,
      rideType,
      
      // Driver details
      driverId,
      driverName,
      driverPhone,
      driverPhotoUrl,
      
      // Location data
      pickupLocation,
      destinationLocation,
      pickupName,
      destinationName,
      
      // Route information
      distance,
      duration,
      fare,
      routePoints,
      
      // Vehicle & capacity
      capacity,
      currentPassengers,
      vehicleInfo,
      
      // Scheduling
      scheduledTime,
      
      // Preferences
      maxWaitTime,
      preferredVehicleType,
      estimatedFare,
      specialRequests,
      maxWalkDistance,
      
      // Additional fields
      searchType,
      status,
      expiryTime
    } = req.body;

    console.log('🚗 Driver starting search:', {
      driverId: driverId || userId,
      driverName,
      rideType,
      route: `${pickupName} → ${destinationName}`
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
      // Driver reference and details
      driverId: driverId || userId,
      driverPhone: driverPhone,
      driverName: driverName || 'Driver',
      driverPhotoUrl: driverPhotoUrl || '',
      driverContactPhone: driverPhone,

      // Search status
      isActive: true,
      searchType: isScheduled ? 'scheduled' : 'real_time',
      status: isScheduled ? 'scheduled' : 'active',
      userType: userType || 'driver',

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
      passengerCapacity: capacity || 4,
      currentPassengers: currentPassengers || 0,

      // Scheduling
      scheduledTime: isScheduled && scheduledTime ? new Date(scheduledTime).toISOString() : null,

      // TTL Fields for Firestore automatic deletion
      createdAt: now,
      expiryTime: expiryDate,

      // Additional fields
      maxWaitTime: maxWaitTime || 30,
      preferredVehicleType: preferredVehicleType || 'car',
      estimatedFare: estimatedFare || 0,
      specialRequests: specialRequests || '',
      maxWalkDistance: maxWalkDistance || 0.5,
      updatedAt: now,
    };

    // Add optional fields if they exist
    if (vehicleInfo) searchData.vehicleInfo = vehicleInfo;
    if (routePoints) searchData.routePoints = routePoints;
    if (distance) searchData.distance = distance;
    if (duration) searchData.duration = duration;
    if (fare) searchData.fare = fare;

    let searchId;

    if (isScheduled) {
      // Save to driver_scheduled_rides collection
      searchId = `schedule_${now.getTime()}`;
      const scheduledRideData = {
        ...searchData,
        scheduleId: searchId,
        customerName: 'Not assigned',
        customerPhone: 'Not assigned',
        fareEstimate: estimatedFare || 0,
        notes: specialRequests || '',
      };

      await db.collection('driver_scheduled_rides').doc(searchId).set(scheduledRideData);
      console.log('✅ Scheduled ride saved:', searchId);
    } else {
      // Save to active_searches collection
      const docRef = await db.collection('active_searches').add(searchData);
      searchId = docRef.id;
      console.log('✅ Active search saved:', searchId);
    }

    // Update driver document
    await updateDriverDocument(searchData, searchId, isScheduled);

    res.json({
      success: true,
      searchId: searchId,
      message: 'Driver search started successfully',
      data: searchData
    });

  } catch (error) {
    console.error('❌ Error starting driver search:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: 'Failed to start driver search'
    });
  }
});

// Update driver document
async function updateDriverDocument(searchData, searchId, isScheduled) {
  try {
    const driverPhone = searchData.driverPhone || searchData.driverId;
    
    const driverDoc = {
      isOnline: true,
      isSearching: true,
      searchType: isScheduled ? 'scheduled' : 'real_time',
      currentScheduleId: isScheduled ? searchId : null,
      activeSearchId: isScheduled ? null : searchId,
      currentLocation: {
        lat: searchData.pickupLocation.lat,
        lng: searchData.pickupLocation.lng,
        address: searchData.pickupName || 'Current Location',
      },

      // Driver personal information
      driverId: searchData.driverId,
      driverName: searchData.driverName,
      driverEmail: searchData.driverEmail || 'No email',
      driverPhone: driverPhone,
      driverPhoto: searchData.driverPhotoUrl || '',

      // Vehicle information
      vehicleInfo: searchData.vehicleInfo || {
        model: 'Car Model',
        plate: 'ABC123',
        capacity: searchData.passengerCapacity || 4,
        color: 'Unknown',
        year: 'Unknown',
      },

      // Current search details
      currentSearch: {
        searchId: searchId,
        pickupLocation: searchData.pickupLocation,
        destinationLocation: searchData.destinationLocation,
        capacity: searchData.passengerCapacity,
        currentPassengers: searchData.currentPassengers,
        scheduledTime: searchData.scheduledTime,
      },

      // Timestamps
      lastUpdated: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.collection('drivers').doc(driverPhone).set(driverDoc, { merge: true });
    console.log('✅ Driver document updated:', driverPhone);
    
  } catch (error) {
    console.error('❌ Error updating driver document:', error);
    throw error;
  }
}

// Driver stops searching - UPDATED to handle both active and scheduled searches
router.post("/stop-search", async (req, res) => {
  try {
    const { userId, userType, rideType, driverId } = req.body;

    console.log('🛑 Stopping search for driver:', { userId, driverId, rideType });

    const driverPhone = await getDriverPhone(userId, driverId);

    // Update driver document
    await db.collection('drivers').doc(driverPhone).update({
      isSearching: false,
      isOnline: false,
      activeSearchId: null,
      currentScheduleId: null,
      lastUpdated: new Date(),
    });

    // Handle different search types
    if (rideType === 'immediate' || rideType === 'real_time') {
      // Deactivate active searches
      const activeSearches = await db.collection('active_searches')
        .where('driverId', '==', driverId || userId)
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
      console.log(`✅ Deactivated ${activeSearches.size} active searches`);
    } else if (rideType === 'scheduled') {
      // Cancel scheduled rides
      const scheduledRides = await db.collection('driver_scheduled_rides')
        .where('driverId', '==', driverId || userId)
        .where('status', 'in', ['scheduled', 'active'])
        .get();

      const batch = db.batch();
      scheduledRides.docs.forEach(doc => {
        batch.update(doc.ref, {
          status: 'cancelled',
          updatedAt: new Date()
        });
      });
      await batch.commit();
      console.log(`✅ Cancelled ${scheduledRides.size} scheduled rides`);
    }

    res.json({
      success: true,
      message: 'Driver search stopped successfully',
      driverId: driverId || userId
    });

  } catch (error) {
    console.error('❌ Error stopping driver search:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get driver's current search status
router.get("/search-status/:driverId", async (req, res) => {
  try {
    const { driverId } = req.params;
    const driverPhone = await getDriverPhone(driverId);

    const driverDoc = await db.collection('drivers').doc(driverPhone).get();
    
    if (!driverDoc.exists) {
      return res.json({
        success: true,
        isSearching: false,
        message: 'Driver not found'
      });
    }

    const driverData = driverDoc.data();
    
    res.json({
      success: true,
      isSearching: driverData.isSearching || false,
      searchType: driverData.searchType,
      activeSearchId: driverData.activeSearchId,
      currentScheduleId: driverData.currentScheduleId,
      driverData: driverData
    });

  } catch (error) {
    console.error('❌ Error getting search status:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Cancel specific search
router.post("/cancel-search", async (req, res) => {
  try {
    const { searchId, searchType } = req.body;

    console.log('🗑️ Cancelling search:', { searchId, searchType });

    if (searchType === 'active_searches') {
      await db.collection('active_searches').doc(searchId).update({
        isActive: false,
        status: 'cancelled',
        updatedAt: new Date(),
      });
    } else if (searchType === 'driver_scheduled_rides') {
      await db.collection('driver_scheduled_rides').doc(searchId).update({
        status: 'cancelled',
        updatedAt: new Date(),
      });
    } else {
      throw new Error('Invalid search type');
    }

    res.json({
      success: true,
      message: 'Search cancelled successfully',
      searchId: searchId
    });

  } catch (error) {
    console.error('❌ Error cancelling search:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Update driver location
router.post("/update-location", async (req, res) => {
  try {
    const { userId, driverId, location, address } = req.body;

    const driverPhone = await getDriverPhone(userId, driverId);

    await db.collection('drivers').doc(driverPhone).update({
      currentLocation: {
        lat: location.lat,
        lng: location.lng,
        address: address,
        updatedAt: new Date(),
      },
      lastUpdated: new Date(),
    });

    console.log('📍 Updated driver location:', { driverId, location });

    res.json({
      success: true,
      message: 'Location updated successfully'
    });

  } catch (error) {
    console.error('❌ Error updating driver location:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get driver details
router.get("/details/:driverId", async (req, res) => {
  try {
    const { driverId } = req.params;

    const drivers = await db.collection('drivers')
      .where('driverId', '==', driverId)
      .limit(1)
      .get();

    if (drivers.empty) {
      return res.status(404).json({
        success: false,
        error: 'Driver not found'
      });
    }

    const driverData = drivers.docs[0].data();
    
    res.json({
      success: true,
      driver: driverData
    });

  } catch (error) {
    console.error('❌ Error getting driver details:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Find nearby drivers for passengers
router.post("/nearby", async (req, res) => {
  try {
    const { location, radiusInKm = 5, limit = 10 } = req.body;

    console.log('🔍 Finding nearby drivers:', { location, radiusInKm });

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
            documentId: doc.id
          });
        }
      }
    });

    // Sort by distance
    nearbyDrivers.sort((a, b) => a.distance - b.distance);

    console.log(`✅ Found ${nearbyDrivers.length} nearby drivers`);

    res.json({
      success: true,
      drivers: nearbyDrivers,
      total: nearbyDrivers.length
    });

  } catch (error) {
    console.error('❌ Error finding nearby drivers:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Helper function to get driver phone number
async function getDriverPhone(userId, driverId) {
  // In a real implementation, you might want to look up the driver's phone number
  // For now, we'll use the provided ID or try to find it in the drivers collection
  return driverId || userId;
}

// Helper function to calculate distance between two points (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const earthRadius = 6371; // Earth's radius in kilometers

  const dLat = degreesToRadians(lat2 - lat1);
  const dLon = degreesToRadians(lon2 - lon1);

  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(degreesToRadians(lat1)) * 
    Math.cos(degreesToRadians(lat2)) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadius * c;
}

function degreesToRadians(degrees) {
  return degrees * (Math.PI / 180);
}

module.exports = router;
