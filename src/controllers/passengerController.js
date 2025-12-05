const express = require('express');
const router = express.Router();

let services = null;

const init = (injectedServices) => {
  services = injectedServices;
  
  // Passenger status endpoint
  router.get('/status/:passengerId', async (req, res) => {
    try {
      const { passengerId } = req.params;
      
      const passengerData = await services.firestoreService.getPassengerSearch(passengerId);
      
      if (!passengerData) {
        return res.json({
          success: true,
          exists: false,
          message: 'Passenger not found in active searches',
          passengerId: passengerId
        });
      }
      
      let matchData = null;
      let rideData = null;
      
      if (passengerData.matchId) {
        matchData = await services.firestoreService.getMatch(passengerData.matchId);
      }
      
      if (passengerData.rideId) {
        const rideDoc = await services.db.collection('active_rides').doc(passengerData.rideId).get();
        if (rideDoc.exists) {
          rideData = rideDoc.data();
        }
      }
      
      const status = {
        success: true,
        exists: true,
        passengerId: passengerId,
        passengerName: passengerData.passengerName,
        passengerPhone: passengerData.passengerPhone,
        passengerPhotoUrl: passengerData.passengerPhotoUrl,
        matchStatus: passengerData.matchStatus,
        matchId: passengerData.matchId,
        matchedWith: passengerData.matchedWith,
        tripStatus: passengerData.tripStatus,
        rideId: passengerData.rideId,
        passengerCount: passengerData.passengerCount || 1,
        acceptedAt: passengerData.acceptedAt,
        driver: passengerData.driver,
        matchData: matchData,
        rideData: rideData,
        searchId: passengerData.searchId,
        status: passengerData.status,
        rideType: passengerData.rideType
      };
      
      res.json(status);
      
    } catch (error) {
      console.error('❌ Error getting passenger status:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // Passenger location update endpoint
  router.post('/update-location', async (req, res) => {
    try {
      const { 
        userId, 
        passengerId, 
        location, 
        address 
      } = req.body;
      
      const actualUserId = passengerId || userId;
      
      if (!actualUserId) {
        return res.status(400).json({ 
          success: false, 
          error: 'passengerId or userId is required' 
        });
      }
      
      if (!location || !location.latitude || !location.longitude) {
        return res.status(400).json({ 
          success: false, 
          error: 'Valid location with latitude and longitude is required' 
        });
      }
      
      console.log(`📍 Passenger location update: ${actualUserId}`);
      
      const result = await services.rideService.updateLocation(
        actualUserId, 
        'passenger', 
        location, 
        address
      );
      
      res.json(result);
      
    } catch (error) {
      console.error('❌ Error updating passenger location:', error);
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
