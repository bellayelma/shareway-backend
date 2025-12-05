const helpers = require('../utils/helpers');

class RideService {
  constructor(firestoreService, websocketServer) {
    this.firestoreService = firestoreService;
    this.websocketServer = websocketServer;
  }
  
  // Driver accepts passenger
  async acceptPassenger(driverId, passengerId, matchId) {
    try {
      console.log(`🤝 Driver ${driverId} accepting match ${matchId} with passenger ${passengerId}`);
      
      // Get driver data
      const driverData = await this.firestoreService.getDriverSearch(driverId);
      if (!driverData) {
        throw new Error('Driver not found in active searches');
      }
      
      // Verify match exists and is proposed
      if (driverData.matchId !== matchId || driverData.matchStatus !== 'proposed') {
        throw new Error('Invalid match or match already processed');
      }
      
      // Verify matched with correct passenger
      if (driverData.matchedWith !== passengerId) {
        throw new Error('Passenger ID does not match proposed match');
      }
      
      // Get passenger data
      const passengerData = await this.firestoreService.getPassengerSearch(passengerId);
      if (!passengerData) {
        throw new Error('Passenger not found in active searches');
      }
      
      // Check capacity
      const passengerCount = passengerData.passengerCount || 1;
      const availableSeats = driverData.availableSeats || driverData.capacity || 4;
      if (availableSeats < passengerCount) {
        throw new Error(`Not enough available seats. Available: ${availableSeats}, Needed: ${passengerCount}`);
      }
      
      // Create active ride
      const rideData = await this.firestoreService.createActiveRide(driverData, passengerData);
      
      // Update driver document
      const driverUpdates = await this.updateDriverWithPassenger(driverId, passengerData, matchId, rideData.rideId);
      
      // Update passenger document
      await this.updatePassengerWithDriver(passengerId, driverData, matchId, rideData.rideId);
      
      // Update match document
      await this.firestoreService.db.collection('active_matches').doc(matchId).update({
        matchStatus: 'accepted',
        rideId: rideData.rideId,
        acceptedAt: this.firestoreService.admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Stop searching for passenger in memory (will be handled by search service)
      
      // Notify both users via WebSocket
      if (this.websocketServer) {
        // Notify driver
        this.websocketServer.sendMatchAccepted(driverId, {
          matchId: matchId,
          rideId: rideData.rideId,
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
        this.websocketServer.sendMatchAccepted(passengerId, {
          matchId: matchId,
          rideId: rideData.rideId,
          driverId: driverId,
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
      
      return {
        success: true,
        message: 'Passenger accepted successfully',
        matchId: matchId,
        rideId: rideData.rideId,
        driverId: driverId,
        driverName: driverData.driverName,
        passengerId: passengerId,
        passengerName: passengerData.passengerName,
        passengerCount: passengerCount,
        availableSeats: driverUpdates.availableSeats,
        currentPassengers: driverUpdates.currentPassengers,
        rideData: rideData
      };
      
    } catch (error) {
      console.error('❌ Error accepting passenger:', error);
      throw error;
    }
  }
  
  // Update driver with passenger acceptance
  async updateDriverWithPassenger(driverId, passengerData, matchId, rideId) {
    try {
      const passengerCount = passengerData.passengerCount || 1;
      const driverDoc = await this.firestoreService.db.collection('active_searches_driver').doc(driverId).get();
      if (!driverDoc.exists) {
        throw new Error('Driver not found');
      }
      
      const driverData = driverDoc.data();
      const currentAvailableSeats = driverData.availableSeats || driverData.capacity || 4;
      const currentPassengers = driverData.currentPassengers || 0;
      
      const updates = {
        matchId: matchId,
        matchedWith: passengerData.passengerId || passengerData.userId,
        matchStatus: 'accepted',
        rideId: rideId,
        tripStatus: 'driver_accepted',
        passenger: {
          passengerId: passengerData.passengerId || passengerData.userId,
          passengerName: passengerData.passengerName,
          passengerPhone: passengerData.passengerPhone,
          passengerPhotoUrl: passengerData.passengerPhotoUrl,
          pickupLocation: passengerData.pickupLocation,
          pickupName: passengerData.pickupName,
          destinationLocation: passengerData.destinationLocation,
          destinationName: passengerData.destinationName,
          passengerCount: passengerCount,
          matchAcceptedAt: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
        },
        currentPassengers: currentPassengers + passengerCount,
        availableSeats: Math.max(0, currentAvailableSeats - passengerCount),
        acceptedAt: this.firestoreService.admin.firestore.FieldValue.serverTimestamp(),
        lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
      };
      
      await this.firestoreService.updateDriverSearch(driverId, updates, { immediate: true });
      
      console.log(`✅ Updated driver ${driverId} with passenger acceptance`);
      
      return updates;
    } catch (error) {
      console.error('❌ Error updating driver with passenger:', error);
      throw error;
    }
  }
  
  // Update passenger with driver acceptance
  async updatePassengerWithDriver(passengerId, driverData, matchId, rideId) {
    try {
      const updates = {
        matchId: matchId,
        matchedWith: driverData.driverId || driverData.userId,
        matchStatus: 'accepted',
        rideId: rideId,
        tripStatus: 'driver_accepted',
        driver: {
          driverId: driverData.driverId || driverData.userId,
          driverName: driverData.driverName,
          driverPhone: driverData.driverPhone,
          driverPhotoUrl: driverData.driverPhotoUrl,
          driverRating: driverData.driverRating,
          vehicleInfo: driverData.vehicleInfo,
          vehicleType: driverData.vehicleType,
          capacity: driverData.capacity,
          currentPassengers: driverData.currentPassengers || 0,
          availableSeats: driverData.availableSeats || driverData.capacity,
          matchAcceptedAt: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
        },
        acceptedAt: this.firestoreService.admin.firestore.FieldValue.serverTimestamp(),
        lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
      };
      
      await this.firestoreService.updatePassengerSearch(passengerId, updates, { immediate: true });
      
      console.log(`✅ Updated passenger ${passengerId} with driver acceptance`);
      
      return updates;
    } catch (error) {
      console.error('❌ Error updating passenger with driver:', error);
      throw error;
    }
  }
  
  // Reject match
  async rejectMatch(userId, userType, matchId) {
    try {
      if (userType === 'driver') {
        await this.firestoreService.updateDriverSearch(userId, {
          matchId: null,
          matchedWith: null,
          matchStatus: 'rejected',
          lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
        }, { immediate: true });
      } else if (userType === 'passenger') {
        await this.firestoreService.updatePassengerSearch(userId, {
          matchId: null,
          matchedWith: null,
          matchStatus: 'rejected',
          lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
        }, { immediate: true });
      }
      
      // Update match document
      await this.firestoreService.db.collection('active_matches').doc(matchId).update({
        matchStatus: 'rejected',
        rejectedAt: this.firestoreService.admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: this.firestoreService.admin.firestore.FieldValue.serverTimestamp(),
        rejectedBy: userType,
        rejectedByUserId: userId
      });
      
      console.log(`✅ Match ${matchId} rejected by ${userType} ${userId}`);
      
      return true;
    } catch (error) {
      console.error('❌ Error rejecting match:', error);
      throw error;
    }
  }
  
  // Update location
  async updateLocation(userId, userType, location, address = '') {
    try {
      const updates = {
        currentLocation: {
          latitude: location.latitude,
          longitude: location.longitude,
          accuracy: location.accuracy || 0,
          timestamp: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
        },
        lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
      };
      
      if (userType === 'driver') {
        await this.firestoreService.updateDriverSearch(userId, updates, { immediate: true });
        
        // If driver has a passenger, update passenger's embedded driver location
        const driverData = await this.firestoreService.getDriverSearch(userId);
        if (driverData && driverData.matchedWith && driverData.passenger) {
          await this.firestoreService.updatePassengerSearch(driverData.matchedWith, {
            'driver.currentLocation': {
              latitude: location.latitude,
              longitude: location.longitude,
              timestamp: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
            }
          }, { immediate: true });
          
          // Notify passenger via WebSocket
          if (this.websocketServer) {
            this.websocketServer.sendDriverLocationUpdate(driverData.matchedWith, {
              driverId: userId,
              driverName: driverData.driverName,
              location: location,
              timestamp: new Date().toISOString()
            });
          }
        }
      } else if (userType === 'passenger') {
        await this.firestoreService.updatePassengerSearch(userId, updates, { immediate: true });
        
        // If passenger has a driver, update driver's embedded passenger location
        const passengerData = await this.firestoreService.getPassengerSearch(userId);
        if (passengerData && passengerData.matchedWith && passengerData.driver) {
          await this.firestoreService.updateDriverSearch(passengerData.matchedWith, {
            'passenger.currentLocation': {
              latitude: location.latitude,
              longitude: location.longitude,
              timestamp: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
            }
          }, { immediate: true });
          
          // Notify driver via WebSocket
          if (this.websocketServer) {
            this.websocketServer.sendPassengerLocationUpdate(passengerData.matchedWith, {
              passengerId: userId,
              passengerName: passengerData.passengerName,
              location: location,
              timestamp: new Date().toISOString()
            });
          }
        }
      }
      
      return {
        success: true,
        message: `${userType} location updated successfully`,
        userId: userId,
        location: location,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('❌ Error updating location:', error);
      throw error;
    }
  }
  
  // Update trip status
  async updateTripStatus(userId, userType, tripStatus, location = null) {
    try {
      const updates = {
        tripStatus: tripStatus,
        lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
      };
      
      if (location) {
        updates.currentLocation = {
          latitude: location.latitude,
          longitude: location.longitude,
          accuracy: location.accuracy || 0,
          timestamp: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
        };
      }
      
      if (userType === 'driver') {
        await this.firestoreService.updateDriverSearch(userId, updates, { immediate: true });
        
        // If driver has a passenger, update passenger's embedded driver status
        const driverData = await this.firestoreService.getDriverSearch(userId);
        if (driverData && driverData.matchedWith && driverData.passenger) {
          const passengerUpdates = {
            'driver.tripStatus': tripStatus,
            lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
          };
          
          if (location) {
            passengerUpdates['driver.currentLocation'] = {
              latitude: location.latitude,
              longitude: location.longitude,
              timestamp: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
            };
          }
          
          await this.firestoreService.updatePassengerSearch(driverData.matchedWith, passengerUpdates, { immediate: true });
          
          // Notify passenger via WebSocket
          if (this.websocketServer) {
            this.websocketServer.sendTripStatusUpdate(driverData.matchedWith, {
              driverId: userId,
              driverName: driverData.driverName,
              tripStatus: tripStatus,
              location: location,
              timestamp: new Date().toISOString()
            });
          }
        }
      } else if (userType === 'passenger') {
        await this.firestoreService.updatePassengerSearch(userId, updates, { immediate: true });
        
        // If passenger has a driver, update driver's embedded passenger status
        const passengerData = await this.firestoreService.getPassengerSearch(userId);
        if (passengerData && passengerData.matchedWith && passengerData.driver) {
          const driverUpdates = {
            'passenger.tripStatus': tripStatus,
            lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
          };
          
          if (location) {
            driverUpdates['passenger.currentLocation'] = {
              latitude: location.latitude,
              longitude: location.longitude,
              timestamp: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
            };
          }
          
          await this.firestoreService.updateDriverSearch(passengerData.matchedWith, driverUpdates, { immediate: true });
          
          // Notify driver via WebSocket
          if (this.websocketServer) {
            this.websocketServer.sendTripStatusUpdate(passengerData.matchedWith, {
              passengerId: userId,
              passengerName: passengerData.passengerName,
              tripStatus: tripStatus,
              location: location,
              timestamp: new Date().toISOString()
            });
          }
        }
      }
      
      return { 
        success: true, 
        tripStatus: tripStatus,
        userId: userId,
        userType: userType,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('❌ Error updating trip status:', error);
      throw error;
    }
  }
}

module.exports = RideService;
