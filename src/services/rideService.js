const helpers = require('../utils/helpers');

class RideService {
  constructor(firestoreService, websocketServer) {
    this.firestoreService = firestoreService;
    this.websocketServer = websocketServer;
  }
  
  // Driver accepts passenger - SUPPORTS MULTIPLE PASSENGERS
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
      
      // Check capacity - Use array of passengers instead of single passenger
      const passengerCount = passengerData.passengerCount || 1;
      const driverCapacity = driverData.capacity || 4;
      const currentPassengers = driverData.passengers ? driverData.passengers.length : 0;
      const currentPassengerCount = driverData.currentPassengers || 0;
      const availableSeats = driverCapacity - currentPassengerCount;
      
      if (availableSeats < passengerCount) {
        throw new Error(`Not enough available seats. Available: ${availableSeats}, Needed: ${passengerCount}`);
      }
      
      // Create active ride for THIS passenger
      const rideData = await this.firestoreService.createActiveRide(driverData, passengerData);
      
      // Create passenger object for driver
      const passengerInfo = {
        passengerId: passengerData.passengerId || passengerData.userId,
        passengerName: passengerData.passengerName,
        passengerPhone: passengerData.passengerPhone,
        passengerPhotoUrl: passengerData.passengerPhotoUrl,
        pickupLocation: passengerData.pickupLocation,
        pickupName: passengerData.pickupName,
        destinationLocation: passengerData.destinationLocation,
        destinationName: passengerData.destinationName,
        passengerCount: passengerCount,
        matchId: matchId,
        rideId: rideData.rideId,
        status: 'accepted',
        acceptedAt: this.firestoreService.admin.firestore.FieldValue.serverTimestamp(),
        tripStatus: 'waiting_for_pickup'
      };
      
      // Update driver document - ADD to passengers array instead of replacing
      const driverUpdates = await this.updateDriverWithPassenger(driverId, passengerInfo, passengerCount);
      
      // Update passenger document
      await this.updatePassengerWithDriver(passengerId, driverData, matchId, rideData.rideId);
      
      // Update match document
      await this.firestoreService.db.collection('active_matches').doc(matchId).update({
        matchStatus: 'accepted',
        rideId: rideData.rideId,
        acceptedAt: this.firestoreService.admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Reset matchId for driver to accept more passengers
      await this.firestoreService.db.collection('active_searches_driver').doc(driverId).update({
        matchId: null,
        matchedWith: null,
        matchStatus: 'searching', // Allow driver to search for more passengers
        lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Notify both users via WebSocket
      if (this.websocketServer) {
        // Notify driver
        this.websocketServer.sendMatchAccepted(driverId, {
          matchId: matchId,
          rideId: rideData.rideId,
          passengerId: passengerId,
          passengerName: passengerData.passengerName,
          passengerPhone: passengerData.passengerPhone,
          pickupName: passengerData.pickupName,
          destinationName: passengerData.destinationName,
          passengerCount: passengerCount,
          currentTotalPassengers: currentPassengerCount + passengerCount,
          availableSeats: availableSeats - passengerCount,
          totalAcceptedPassengers: (driverData.passengers ? driverData.passengers.length : 0) + 1,
          message: 'Passenger accepted successfully!',
          nextStep: 'You can accept more passengers or proceed to pickup'
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
          pickupName: passengerData.pickupName,
          destinationName: passengerData.destinationName,
          estimatedFare: passengerData.estimatedFare,
          currentTotalPassengers: currentPassengerCount + passengerCount,
          availableSeats: availableSeats - passengerCount,
          message: 'Driver has accepted your ride!',
          nextStep: 'Wait for driver to arrive. Driver may pick up other passengers first.'
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
        currentTotalPassengers: currentPassengerCount + passengerCount,
        availableSeats: availableSeats - passengerCount,
        rideData: rideData
      };
      
    } catch (error) {
      console.error('❌ Error accepting passenger:', error);
      throw error;
    }
  }
  
  // Update driver with passenger acceptance - SUPPORTS MULTIPLE PASSENGERS
  async updateDriverWithPassenger(driverId, passengerInfo, passengerCount) {
    try {
      const driverDoc = await this.firestoreService.db.collection('active_searches_driver').doc(driverId).get();
      if (!driverDoc.exists) {
        throw new Error('Driver not found');
      }
      
      const driverData = driverDoc.data();
      const driverCapacity = driverData.capacity || 4;
      const currentPassengerCount = driverData.currentPassengers || 0;
      const availableSeats = driverCapacity - currentPassengerCount;
      
      // Use arrayUnion to add passenger to array without overwriting
      const updates = {
        // Add passenger to passengers array
        passengers: this.firestoreService.admin.firestore.FieldValue.arrayUnion(passengerInfo),
        // Update passenger counts
        currentPassengers: currentPassengerCount + passengerCount,
        availableSeats: Math.max(0, availableSeats - passengerCount),
        // Track all accepted matches
        acceptedMatches: this.firestoreService.admin.firestore.FieldValue.arrayUnion(passengerInfo.matchId),
        // Track all ride IDs
        rideIds: this.firestoreService.admin.firestore.FieldValue.arrayUnion(passengerInfo.rideId),
        tripStatus: 'driver_accepted',
        acceptedAt: this.firestoreService.admin.firestore.FieldValue.serverTimestamp(),
        lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
      };
      
      await this.firestoreService.updateDriverSearch(driverId, updates, { immediate: true });
      
      console.log(`✅ Updated driver ${driverId} with passenger ${passengerInfo.passengerId}. Total passengers: ${currentPassengerCount + passengerCount}`);
      
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
  
  // Get all passengers for a driver
  async getDriverPassengers(driverId) {
    try {
      const driverData = await this.firestoreService.getDriverSearch(driverId);
      if (!driverData) {
        throw new Error('Driver not found');
      }
      
      return {
        success: true,
        driverId: driverId,
        currentPassengers: driverData.currentPassengers || 0,
        availableSeats: driverData.availableSeats || 0,
        capacity: driverData.capacity || 4,
        passengers: driverData.passengers || [],
        tripStatus: driverData.tripStatus || 'searching'
      };
    } catch (error) {
      console.error('❌ Error getting driver passengers:', error);
      throw error;
    }
  }
  
  // Remove a specific passenger from driver (e.g., if passenger cancels)
  async removePassengerFromDriver(driverId, passengerId, matchId) {
    try {
      const driverDoc = await this.firestoreService.db.collection('active_searches_driver').doc(driverId).get();
      if (!driverDoc.exists) {
        throw new Error('Driver not found');
      }
      
      const driverData = driverDoc.data();
      const passengers = driverData.passengers || [];
      
      // Find the passenger to remove
      const passengerToRemove = passengers.find(p => p.passengerId === passengerId && p.matchId === matchId);
      if (!passengerToRemove) {
        throw new Error('Passenger not found in driver list');
      }
      
      const passengerCount = passengerToRemove.passengerCount || 1;
      const newPassengers = passengers.filter(p => !(p.passengerId === passengerId && p.matchId === matchId));
      
      // Calculate new counts
      const currentPassengers = driverData.currentPassengers || 0;
      const newCurrentPassengers = Math.max(0, currentPassengers - passengerCount);
      const driverCapacity = driverData.capacity || 4;
      const newAvailableSeats = driverCapacity - newCurrentPassengers;
      
      const updates = {
        passengers: newPassengers,
        currentPassengers: newCurrentPassengers,
        availableSeats: newAvailableSeats,
        lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
      };
      
      await this.firestoreService.updateDriverSearch(driverId, updates, { immediate: true });
      
      console.log(`✅ Removed passenger ${passengerId} from driver ${driverId}`);
      
      return {
        success: true,
        driverId: driverId,
        passengerId: passengerId,
        removedPassengerCount: passengerCount,
        currentTotalPassengers: newCurrentPassengers,
        availableSeats: newAvailableSeats,
        remainingPassengers: newPassengers.length
      };
    } catch (error) {
      console.error('❌ Error removing passenger from driver:', error);
      throw error;
    }
  }
  
  // Update location - SUPPORTS MULTIPLE PASSENGERS
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
        
        // Update location for ALL passengers
        const driverData = await this.firestoreService.getDriverSearch(userId);
        if (driverData && driverData.passengers) {
          for (const passenger of driverData.passengers) {
            await this.firestoreService.updatePassengerSearch(passenger.passengerId, {
              'driver.currentLocation': {
                latitude: location.latitude,
                longitude: location.longitude,
                timestamp: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
              },
              lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
            }, { immediate: true });
            
            // Notify each passenger via WebSocket
            if (this.websocketServer) {
              this.websocketServer.sendDriverLocationUpdate(passenger.passengerId, {
                driverId: userId,
                driverName: driverData.driverName,
                location: location,
                timestamp: new Date().toISOString()
              });
            }
          }
        }
      } else if (userType === 'passenger') {
        await this.firestoreService.updatePassengerSearch(userId, updates, { immediate: true });
        
        // If passenger has a driver, update driver's embedded passenger location
        const passengerData = await this.firestoreService.getPassengerSearch(userId);
        if (passengerData && passengerData.matchedWith && passengerData.driver) {
          const driverId = passengerData.matchedWith;
          const driverData = await this.firestoreService.getDriverSearch(driverId);
          
          if (driverData && driverData.passengers) {
            // Update passenger location in driver's passengers array
            const updatedPassengers = driverData.passengers.map(passenger => {
              if (passenger.passengerId === userId) {
                return {
                  ...passenger,
                  currentLocation: {
                    latitude: location.latitude,
                    longitude: location.longitude,
                    timestamp: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
                  }
                };
              }
              return passenger;
            });
            
            await this.firestoreService.updateDriverSearch(driverId, {
              passengers: updatedPassengers,
              lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
            }, { immediate: true });
            
            // Notify driver via WebSocket
            if (this.websocketServer) {
              this.websocketServer.sendPassengerLocationUpdate(driverId, {
                passengerId: userId,
                passengerName: passengerData.passengerName,
                location: location,
                timestamp: new Date().toISOString()
              });
            }
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
  
  // Update trip status for specific passenger or all passengers
  async updatePassengerTripStatus(driverId, passengerId, tripStatus, location = null) {
    try {
      const driverDoc = await this.firestoreService.db.collection('active_searches_driver').doc(driverId).get();
      if (!driverDoc.exists) {
        throw new Error('Driver not found');
      }
      
      const driverData = driverDoc.data();
      const passengers = driverData.passengers || [];
      
      // Update specific passenger's trip status
      const updatedPassengers = passengers.map(passenger => {
        if (passenger.passengerId === passengerId) {
          return {
            ...passenger,
            tripStatus: tripStatus,
            statusUpdatedAt: this.firestoreService.admin.firestore.FieldValue.serverTimestamp(),
            ...(location && {
              currentLocation: {
                latitude: location.latitude,
                longitude: location.longitude,
                timestamp: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
              }
            })
          };
        }
        return passenger;
      });
      
      const updates = {
        passengers: updatedPassengers,
        lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
      };
      
      // If updating to 'picked_up', update driver's overall trip status
      if (tripStatus === 'picked_up') {
        // Check if all passengers are picked up
        const allPickedUp = updatedPassengers.every(p => p.tripStatus === 'picked_up');
        if (allPickedUp) {
          updates.tripStatus = 'on_trip';
        } else {
          updates.tripStatus = 'partial_pickup';
        }
      }
      
      await this.firestoreService.updateDriverSearch(driverId, updates, { immediate: true });
      
      // Update passenger's own document
      const passengerUpdates = {
        tripStatus: tripStatus,
        lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
      };
      
      if (location) {
        passengerUpdates.currentLocation = {
          latitude: location.latitude,
          longitude: location.longitude,
          accuracy: location.accuracy || 0,
          timestamp: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
        };
      }
      
      await this.firestoreService.updatePassengerSearch(passengerId, passengerUpdates, { immediate: true });
      
      // Notify passenger via WebSocket
      if (this.websocketServer) {
        this.websocketServer.sendTripStatusUpdate(passengerId, {
          driverId: driverId,
          driverName: driverData.driverName,
          tripStatus: tripStatus,
          location: location,
          timestamp: new Date().toISOString(),
          message: `Your ride status: ${tripStatus}`
        });
      }
      
      return {
        success: true,
        driverId: driverId,
        passengerId: passengerId,
        tripStatus: tripStatus,
        allPassengersPickedUp: updates.tripStatus === 'on_trip',
        remainingPassengers: updatedPassengers.filter(p => p.tripStatus !== 'picked_up').length,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('❌ Error updating passenger trip status:', error);
      throw error;
    }
  }
  
  // Reject match - ensure it doesn't affect other passengers
  async rejectMatch(userId, userType, matchId) {
    try {
      if (userType === 'driver') {
        // Only reset match-specific fields, keep passengers array intact
        const driverData = await this.firestoreService.getDriverSearch(userId);
        if (driverData && driverData.matchId === matchId) {
          await this.firestoreService.updateDriverSearch(userId, {
            matchId: null,
            matchedWith: null,
            matchStatus: 'searching', // Allow searching for other matches
            lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
          }, { immediate: true });
        }
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
  
  // Complete ride for specific passenger
  async completePassengerRide(driverId, passengerId, rideId) {
    try {
      const driverDoc = await this.firestoreService.db.collection('active_searches_driver').doc(driverId).get();
      if (!driverDoc.exists) {
        throw new Error('Driver not found');
      }
      
      const driverData = driverDoc.data();
      const passengers = driverData.passengers || [];
      
      // Find and update the specific passenger
      const passengerIndex = passengers.findIndex(p => p.passengerId === passengerId && p.rideId === rideId);
      if (passengerIndex === -1) {
        throw new Error('Passenger not found in driver list');
      }
      
      // Update passenger status to completed
      passengers[passengerIndex].tripStatus = 'completed';
      passengers[passengerIndex].completedAt = this.firestoreService.admin.firestore.FieldValue.serverTimestamp();
      
      // Remove completed passenger from active list
      const completedPassenger = passengers[passengerIndex];
      const remainingPassengers = passengers.filter(p => p.tripStatus !== 'completed');
      
      const passengerCount = completedPassenger.passengerCount || 1;
      const currentPassengers = driverData.currentPassengers || 0;
      const newCurrentPassengers = Math.max(0, currentPassengers - passengerCount);
      const driverCapacity = driverData.capacity || 4;
      const newAvailableSeats = driverCapacity - newCurrentPassengers;
      
      const updates = {
        passengers: remainingPassengers,
        currentPassengers: newCurrentPassengers,
        availableSeats: newAvailableSeats,
        lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
      };
      
      // If all passengers completed, update driver trip status
      if (remainingPassengers.length === 0) {
        updates.tripStatus = 'completed';
        updates.completedAt = this.firestoreService.admin.firestore.FieldValue.serverTimestamp();
      }
      
      await this.firestoreService.updateDriverSearch(driverId, updates, { immediate: true });
      
      // Update passenger's own document
      await this.firestoreService.updatePassengerSearch(passengerId, {
        tripStatus: 'completed',
        completedAt: this.firestoreService.admin.firestore.FieldValue.serverTimestamp(),
        lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
      }, { immediate: true });
      
      console.log(`✅ Completed ride for passenger ${passengerId} with driver ${driverId}`);
      
      return {
        success: true,
        driverId: driverId,
        passengerId: passengerId,
        rideId: rideId,
        passengerCount: passengerCount,
        remainingPassengers: remainingPassengers.length,
        currentTotalPassengers: newCurrentPassengers,
        availableSeats: newAvailableSeats,
        driverTripStatus: updates.tripStatus
      };
    } catch (error) {
      console.error('❌ Error completing passenger ride:', error);
      throw error;
    }
  }
}

module.exports = RideService;
