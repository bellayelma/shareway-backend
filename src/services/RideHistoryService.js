// services/RideHistoryService.js

const logger = require('../utils/Logger');

class RideHistoryService {
  constructor(firestoreService, admin) {
    this.firestore = firestoreService;
    this.admin = admin;
    this.RIDES_PER_PAGE = 20;
    logger.info('RIDE_HISTORY', '✅ RideHistoryService initialized');
  }

  /**
   * Create ride record from match confirmation
   */
  async createRideFromMatch(matchId, matchData, driverData, passengerData) {
    try {
      const rideId = this.generateRideId();
      const timestamp = new Date().toISOString();
      
      const rideRecord = {
        rideId,
        matchId,
        status: 'scheduled',
        rideType: 'scheduled',
        createdAt: timestamp,
        updatedAt: timestamp,
        
        driver: {
          phone: matchData.driverPhone,
          name: driverData.driverName,
          photoUrl: driverData.profilePhoto,
          rating: driverData.rating || 5.0,
          vehicleInfo: driverData.vehicleInfo || {},
          acceptedAt: timestamp
        },
        
        passenger: {
          phone: matchData.passengerPhone,
          name: passengerData.passengerName,
          photoUrl: passengerData.passengerPhotoUrl,
          rating: passengerData.rating || 5.0,
          passengerCount: passengerData.passengerCount || 1,
          specialRequests: passengerData.specialRequests || '',
          bookedAt: timestamp
        },
        
        trip: {
          scheduledTime: matchData.scheduledTime,
          pickup: {
            name: matchData.pickupName,
            location: matchData.pickupLocation
          },
          destination: {
            name: matchData.destinationName,
            location: matchData.destinationLocation
          }
        },
        
        payment: {
          method: passengerData.paymentMethod || 'cash',
          fare: {
            estimated: passengerData.estimatedFare || 0,
            actual: null,
            currency: 'ETB'
          },
          status: 'pending'
        },
        
        timeline: [{
          event: 'scheduled',
          time: timestamp,
          by: 'passenger'
        }],
        
        feedback: {},
        support: {}
      };
      
      // Save to rides collection
      await this.firestore.setDocument('rides', rideId, rideRecord);
      
      // Also store in user's ride lists for quick access
      await Promise.all([
        this.addRideToUserHistory(matchData.passengerPhone, 'passenger', rideId, {
          rideId,
          status: 'scheduled',
          scheduledTime: matchData.scheduledTime,
          driverName: driverData.driverName,
          pickupName: matchData.pickupName,
          destinationName: matchData.destinationName,
          createdAt: timestamp
        }),
        
        this.addRideToUserHistory(matchData.driverPhone, 'driver', rideId, {
          rideId,
          status: 'scheduled',
          scheduledTime: matchData.scheduledTime,
          passengerName: passengerData.passengerName,
          passengerCount: passengerData.passengerCount || 1,
          pickupName: matchData.pickupName,
          destinationName: matchData.destinationName,
          createdAt: timestamp
        })
      ]);
      
      logger.info('RIDE_HISTORY', `✅ Created ride record: ${rideId}`);
      return rideRecord;
      
    } catch (error) {
      logger.error('RIDE_HISTORY', `❌ Create ride error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get passenger's ride history with pagination
   */
  async getPassengerRides(phoneNumber, options = {}) {
    return this.getUserRides(phoneNumber, 'passenger', options);
  }

  /**
   * Get driver's ride history with pagination
   */
  async getDriverRides(phoneNumber, options = {}) {
    return this.getUserRides(phoneNumber, 'driver', options);
  }

  /**
   * Get user rides with filtering
   */
  async getUserRides(phoneNumber, userType, options = {}) {
    try {
      const {
        status = null,
        fromDate = null,
        toDate = null,
        limit = this.RIDES_PER_PAGE,
        startAfter = null,
        sortBy = 'desc'
      } = options;
      
      const sanitizedPhone = this.sanitizePhoneNumber(phoneNumber);
      
      // First get from quick history collection for speed
      let rides = await this.getUserQuickHistory(sanitizedPhone, userType);
      
      // Apply filters
      if (status) {
        rides = rides.filter(r => r.status === status);
      }
      
      if (fromDate) {
        const from = new Date(fromDate);
        rides = rides.filter(r => new Date(r.scheduledTime) >= from);
      }
      
      if (toDate) {
        const to = new Date(toDate);
        rides = rides.filter(r => new Date(r.scheduledTime) <= to);
      }
      
      // Sort
      rides.sort((a, b) => {
        const dateA = new Date(a.scheduledTime).getTime();
        const dateB = new Date(b.scheduledTime).getTime();
        return sortBy === 'desc' ? dateB - dateA : dateA - dateB;
      });
      
      // Apply pagination
      let paginatedRides = rides;
      if (startAfter) {
        const startIndex = rides.findIndex(r => r.rideId === startAfter);
        if (startIndex !== -1) {
          paginatedRides = rides.slice(startIndex + 1, startIndex + 1 + limit);
        }
      } else {
        paginatedRides = rides.slice(0, limit);
      }
      
      // Get full details for each ride
      const fullRides = await Promise.all(
        paginatedRides.map(ride => this.getRideDetails(ride.rideId))
      );
      
      return {
        success: true,
        rides: fullRides.filter(r => r !== null),
        pagination: {
          total: rides.length,
          returned: fullRides.filter(r => r !== null).length,
          hasMore: rides.length > (startAfter ? 
            rides.findIndex(r => r.rideId === startAfter) + 1 + limit : 
            limit),
          nextCursor: fullRides.length > 0 ? 
            fullRides[fullRides.length - 1].rideId : 
            null
        }
      };
      
    } catch (error) {
      logger.error('RIDE_HISTORY', `❌ Get user rides error: ${error.message}`);
      return { success: false, error: error.message, rides: [] };
    }
  }

  /**
   * Get single ride details
   */
  async getRideDetails(rideId) {
    try {
      const ride = await this.firestore.getDocument('rides', rideId);
      if (!ride || !ride.exists) return null;
      
      const rideData = ride.data ? ride.data() : ride;
      
      // Add computed fields for display
      return {
        ...rideData,
        formattedDate: this.formatRideDate(rideData.trip?.scheduledTime),
        formattedTime: this.formatRideTime(rideData.trip?.scheduledTime),
        duration: this.calculateRideDuration(rideData),
        cost: this.formatCurrency(rideData.payment?.fare?.actual || rideData.payment?.fare?.estimated || 0),
        canReview: this.canUserReview(rideData),
        displayStatus: this.getDisplayStatus(rideData.status)
      };
      
    } catch (error) {
      logger.error('RIDE_HISTORY', `❌ Get ride details error: ${error.message}`);
      return null;
    }
  }

  /**
   * Get user ride statistics
   */
  async getUserRideStats(phoneNumber, userType) {
    try {
      const rides = await this.getUserQuickHistory(phoneNumber, userType);
      
      const stats = {
        totalRides: rides.length,
        completedRides: rides.filter(r => r.status === 'completed' || r.status === 'completed_with_feedback').length,
        cancelledRides: rides.filter(r => r.status.includes('cancelled')).length,
        upcomingRides: rides.filter(r => 
          r.status === 'scheduled' || r.status === 'confirmed' || r.status === 'in_progress'
        ).length,
        
        totalSpent: 0,
        totalEarned: 0,
        averageRating: 0,
        totalRatings: 0,
        totalRideTime: 0,
        averageRideTime: 0,
        totalDistance: 0,
        
        monthly: {},
        topPickups: {},
        topDestinations: {}
      };
      
      // Calculate stats from full ride details
      let ratingSum = 0;
      let ratingCount = 0;
      
      for (const ride of rides) {
        const fullRide = await this.getRideDetails(ride.rideId);
        if (!fullRide) continue;
        
        if (fullRide.status === 'completed' || fullRide.status === 'completed_with_feedback') {
          // Financial
          const fare = fullRide.payment?.fare?.actual || fullRide.payment?.fare?.estimated || 0;
          if (userType === 'passenger') {
            stats.totalSpent += fare;
          } else {
            stats.totalEarned += fare;
          }
          
          // Distance & time
          stats.totalDistance += fullRide.trip?.route?.distance || 0;
          stats.totalRideTime += fullRide.trip?.route?.duration || 0;
          
          // Ratings
          const userRating = userType === 'passenger' ? 
            fullRide.feedback?.passengerRating : 
            fullRide.feedback?.driverRating;
          
          if (userRating) {
            ratingSum += userRating;
            ratingCount++;
          }
        }
        
        // Monthly breakdown
        const month = fullRide.createdAt?.substring(0, 7) || 'unknown';
        stats.monthly[month] = (stats.monthly[month] || 0) + 1;
        
        // Popular routes
        if (fullRide.trip?.pickup?.name) {
          stats.topPickups[fullRide.trip.pickup.name] = 
            (stats.topPickups[fullRide.trip.pickup.name] || 0) + 1;
        }
        if (fullRide.trip?.destination?.name) {
          stats.topDestinations[fullRide.trip.destination.name] = 
            (stats.topDestinations[fullRide.trip.destination.name] || 0) + 1;
        }
      }
      
      // Calculate averages
      if (stats.completedRides > 0) {
        stats.averageRideTime = stats.totalRideTime / stats.completedRides;
        stats.averageRating = ratingCount > 0 ? ratingSum / ratingCount : 0;
      }
      
      // Get top routes
      stats.topPickups = this.getTopItems(stats.topPickups, 5);
      stats.topDestinations = this.getTopItems(stats.topDestinations, 5);
      
      return {
        success: true,
        stats,
        userType
      };
      
    } catch (error) {
      logger.error('RIDE_HISTORY', `❌ Get user stats error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Add rating and review
   */
  async addRideFeedback(rideId, userPhone, userType, rating, review = '') {
    try {
      const ride = await this.firestore.getDocument('rides', rideId);
      if (!ride || !ride.exists) throw new Error('Ride not found');
      
      const rideData = ride.data ? ride.data() : ride;
      const timestamp = new Date().toISOString();
      
      const feedbackField = userType === 'driver' ? 'passengerRating' : 'driverRating';
      const reviewField = userType === 'driver' ? 'passengerReview' : 'driverReview';
      const timeField = userType === 'driver' ? 'passengerFeedbackAt' : 'driverFeedbackAt';
      
      const updates = {
        [`feedback.${feedbackField}`]: rating,
        [`feedback.${reviewField}`]: review,
        [`feedback.${timeField}`]: timestamp,
        updatedAt: timestamp
      };
      
      // Check if both have rated
      const currentFeedback = rideData.feedback || {};
      const bothRated = (
        (userType === 'driver' && currentFeedback.driverRating) ||
        (userType === 'passenger' && currentFeedback.passengerRating)
      );
      
      if (bothRated) {
        updates.status = 'completed_with_feedback';
      }
      
      await this.firestore.updateDocument('rides', rideId, updates);
      
      return { success: true, rideId };
      
    } catch (error) {
      logger.error('RIDE_HISTORY', `❌ Add feedback error: ${error.message}`);
      throw error;
    }
  }

  // ========== HELPER METHODS ==========

  generateRideId() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `RIDE_${year}${month}${day}_${random}`;
  }

  async addRideToUserHistory(phoneNumber, userType, rideId, summary) {
    const collection = userType === 'driver' ? 
      'driver_ride_history' : 
      'passenger_ride_history';
    
    const docId = this.sanitizePhoneNumber(phoneNumber);
    
    await this.firestore.setDocument(collection, docId, {
      [rideId]: {
        ...summary,
        updatedAt: new Date().toISOString()
      }
    }, { merge: true });
  }

  async getUserQuickHistory(phoneNumber, userType) {
    const collection = userType === 'driver' ? 
      'driver_ride_history' : 
      'passenger_ride_history';
    
    const docId = this.sanitizePhoneNumber(phoneNumber);
    const doc = await this.firestore.getDocument(collection, docId);
    
    if (!doc || !doc.exists) return [];
    
    const data = doc.data ? doc.data() : doc;
    return Object.entries(data).map(([rideId, summary]) => ({
      rideId,
      ...summary
    }));
  }

  sanitizePhoneNumber(phone) {
    return phone.replace(/\D/g, '');
  }

  formatRideDate(timestamp) {
    try {
      if (!timestamp) return 'Unknown';
      const date = new Date(timestamp);
      return date.toLocaleDateString('en-US', { 
        weekday: 'short', 
        month: 'short', 
        day: 'numeric' 
      });
    } catch {
      return timestamp;
    }
  }

  formatRideTime(timestamp) {
    try {
      if (!timestamp) return 'Unknown';
      const date = new Date(timestamp);
      return date.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit' 
      });
    } catch {
      return timestamp;
    }
  }

  calculateRideDuration(rideData) {
    if (rideData.trip?.route?.duration) {
      const mins = rideData.trip.route.duration;
      if (mins < 60) return `${mins} min`;
      return `${Math.floor(mins / 60)} hr ${mins % 60} min`;
    }
    
    if (rideData.trip?.actualPickupTime && rideData.trip?.actualDropoffTime) {
      const start = new Date(rideData.trip.actualPickupTime);
      const end = new Date(rideData.trip.actualDropoffTime);
      const mins = Math.round((end - start) / 60000);
      if (mins < 60) return `${mins} min`;
      return `${Math.floor(mins / 60)} hr ${mins % 60} min`;
    }
    
    return 'N/A';
  }

  formatCurrency(amount) {
    return `ETB ${amount.toFixed(2)}`;
  }

  canUserReview(rideData) {
    return rideData.status === 'completed' || rideData.status === 'completed_with_feedback';
  }

  getDisplayStatus(status) {
    const statusMap = {
      'scheduled': 'Scheduled',
      'confirmed': 'Confirmed',
      'in_progress': 'On Trip',
      'completed': 'Completed',
      'completed_with_feedback': 'Completed',
      'cancelled_by_driver': 'Cancelled (Driver)',
      'cancelled_by_passenger': 'Cancelled (You)',
      'no_show': 'No Show',
      'disputed': 'Disputed'
    };
    return statusMap[status] || status;
  }

  getTopItems(items, limit) {
    return Object.entries(items)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([key, count]) => ({ name: key, count }));
  }
}

module.exports = RideHistoryService;
