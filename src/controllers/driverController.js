const express = require('express');
const router = express.Router();

let services = null;

const init = (injectedServices) => {
  services = injectedServices;
  
  // Driver status endpoint
  router.get('/status/:driverId', async (req, res) => {
    try {
      const { driverId } = req.params;
      
      const driverData = await services.firestoreService.getDriverSearch(driverId);
      
      if (!driverData) {
        return res.json({
          success: true,
          exists: false,
          message: 'Driver not found in active searches',
          driverId: driverId
        });
      }
      
      let matchData = null;
      let rideData = null;
      
      if (driverData.matchId) {
        matchData = await services.firestoreService.getMatch(driverData.matchId);
      }
      
      if (driverData.rideId) {
        const rideDoc = await services.db.collection('active_rides').doc(driverData.rideId).get();
        if (rideDoc.exists) {
          rideData = rideDoc.data();
        }
      }
      
      const status = {
        success: true,
        exists: true,
        driverId: driverId,
        driverName: driverData.driverName,
        driverPhone: driverData.driverPhone,
        driverPhotoUrl: driverData.driverPhotoUrl,
        driverRating: driverData.driverRating,
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
        searchId: driverData.searchId,
        status: driverData.status,
        rideType: driverData.rideType
      };
      
      res.json(status);
      
    } catch (error) {
      console.error('❌ Error getting driver status:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // Driver location update endpoint
  router.post('/update-location', async (req, res) => {
    try {
      const { 
        userId, 
        driverId, 
        location, 
        address 
      } = req.body;
      
      const actualDriverId = driverId || userId;
      
      if (!actualDriverId) {
        return res.status(400).json({ 
          success: false, 
          error: 'driverId or userId is required' 
        });
      }
      
      if (!location || !location.latitude || !location.longitude) {
        return res.status(400).json({ 
          success: false, 
          error: 'Valid location with latitude and longitude is required' 
        });
      }
      
      console.log(`📍 Driver location update: ${actualDriverId}`);
      
      const result = await services.rideService.updateLocation(
        actualDriverId, 
        'driver', 
        location, 
        address
      );
      
      res.json(result);
      
    } catch (error) {
      console.error('❌ Error updating driver location:', error);
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
