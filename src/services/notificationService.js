// services/notificationService.js
class NotificationService {
  constructor(websocketServer) {
    if (!websocketServer) {
      throw new Error('WebSocket server is required for NotificationService');
    }
    this.websocketServer = websocketServer;
    this.stats = {
      notificationsSent: 0,
      notificationsFailed: 0,
      errors: 0,
      lastCleanup: null
    };
    console.log('🔔 NotificationService initialized with WebSocket support');
  }

  // ==================== MATCH NOTIFICATIONS ====================

  // Send match proposal to both driver and passenger
  async sendMatchProposals(match) {
    try {
      console.log(`📱 Sending match proposals for match ${match?.matchId}`);
      
      if (!match || !match.driverId || !match.passengerId) {
        console.error('❌ Invalid match data for proposals:', match);
        this.stats.errors++;
        return false;
      }
      
      // Prepare match data for notifications
      const matchData = {
        matchId: match.matchId,
        driverId: match.driverId,
        driverName: match.driverName,
        passengerId: match.passengerId,
        passengerName: match.passengerName,
        pickupName: match.fromLocation,
        destinationName: match.toLocation,
        estimatedFare: match.estimatedFare || 150,
        similarityScore: match.similarityScore || 0.85,
        passengerCount: match.passengerCount || 1,
        availableSeats: match.availableSeats || 4,
        vehicleInfo: match.vehicleInfo || {
          model: 'Toyota Corolla',
          color: 'White',
          plate: `AA-${1000 + Math.floor(Math.random() * 9000)}`
        }
      };
      
      // Send to driver
      const driverSent = this.websocketServer.sendPassengerFound(match.driverId, {
        ...matchData,
        passengerPhone: match.passengerPhone,
        passengerRating: match.passengerRating,
        passengerTrips: match.passengerTrips,
        passengerVerified: match.passengerVerified
      });
      
      // Send to passenger
      const passengerSent = this.websocketServer.sendDriverFound(match.passengerId, {
        ...matchData,
        driverPhone: match.driverPhone,
        driverRating: match.driverRating,
        driverTrips: match.driverTrips,
        driverVerified: match.driverVerified
      });
      
      const success = driverSent && passengerSent;
      if (success) {
        this.stats.notificationsSent += 2;
        console.log(`✅ Match proposals sent to both users for match ${match.matchId}`);
      } else {
        console.error(`❌ Failed to send match proposals for match ${match.matchId}`);
        this.stats.notificationsFailed += 2;
      }
      
      return success;
    } catch (error) {
      console.error('❌ Error sending match proposals:', error);
      this.stats.errors++;
      return false;
    }
  }

  // Send scheduled match proposal
  async sendScheduledMatchProposals(match) {
    try {
      console.log(`📅 Sending scheduled match proposals for match ${match?.matchId}`);
      
      if (!match || !match.driverId || !match.passengerId) {
        console.error('❌ Invalid scheduled match data:', match);
        this.stats.errors++;
        return false;
      }
      
      const matchData = {
        matchId: match.matchId,
        driverId: match.driverId,
        driverName: match.driverName,
        passengerId: match.passengerId,
        passengerName: match.passengerName,
        pickupName: match.fromLocation,
        destinationName: match.toLocation,
        estimatedFare: match.estimatedFare || 150,
        similarityScore: match.similarityScore || 0.85,
        passengerCount: match.passengerCount || 1,
        availableSeats: match.availableSeats || 4,
        scheduledTime: match.scheduledTime || match.departureTime,
        vehicleInfo: match.vehicleInfo || {
          model: 'Toyota Corolla',
          color: 'White',
          plate: `AA-${1000 + Math.floor(Math.random() * 9000)}`
        }
      };
      
      // Send to driver
      const driverSent = this.websocketServer.sendScheduledPassengerFound(match.driverId, {
        ...matchData,
        passengerPhone: match.passengerPhone,
        passengerRating: match.passengerRating,
        passengerTrips: match.passengerTrips,
        passengerVerified: match.passengerVerified
      });
      
      // Send to passenger
      const passengerSent = this.websocketServer.sendScheduledDriverFound(match.passengerId, {
        ...matchData,
        driverPhone: match.driverPhone,
        driverRating: match.driverRating,
        driverTrips: match.driverTrips,
        driverVerified: match.driverVerified
      });
      
      const success = driverSent && passengerSent;
      if (success) {
        this.stats.notificationsSent += 2;
        console.log(`✅ Scheduled match proposals sent for match ${match.matchId}`);
      } else {
        console.error(`❌ Failed to send scheduled match proposals for match ${match.matchId}`);
        this.stats.notificationsFailed += 2;
      }
      
      return success;
    } catch (error) {
      console.error('❌ Error sending scheduled match proposals:', error);
      this.stats.errors++;
      return false;
    }
  }

  // Send match accepted notification
  async sendMatchAccepted(match) {
    try {
      console.log(`🤝 Sending match accepted for match ${match?.matchId}`);
      
      if (!match || !match.driverId || !match.passengerId) {
        console.error('❌ Invalid match data for accepted notification:', match);
        return false;
      }
      
      const driverSent = this.websocketServer.sendMatchDecisionUpdate(match, true, 'passenger');
      const passengerSent = this.websocketServer.sendMatchDecisionUpdate(match, true, 'driver');
      
      const success = driverSent && passengerSent;
      if (success) {
        console.log(`✅ Match accepted notifications sent for match ${match.matchId}`);
      }
      
      return success;
    } catch (error) {
      console.error('❌ Error sending match accepted:', error);
      return false;
    }
  }

  // Send match accepted by other driver notification
  async sendMatchAcceptedByOtherDriver(match, acceptedByDriverId) {
    try {
      console.log(`🚗 Sending match accepted by other driver for match ${match?.matchId}`);
      
      if (!match || !match.passengerId) {
        console.error('❌ Invalid match data for accepted by other driver:', match);
        return false;
      }
      
      return this.websocketServer.sendMatchAcceptedByOtherDriver(match, acceptedByDriverId);
    } catch (error) {
      console.error('❌ Error sending match accepted by other driver:', error);
      return false;
    }
  }

  // Send match expired notification
  async sendMatchExpired(match) {
    try {
      console.log(`⏰ Sending match expired for match ${match?.matchId}`);
      
      if (!match) {
        console.error('❌ Invalid match data for expired notification:', match);
        return false;
      }
      
      // Send match decision update with false (rejected) to indicate expiration
      const driverSent = match.driverId ? 
        this.websocketServer.sendMatchDecisionUpdate(match, false, 'system') : 
        Promise.resolve(true);
      
      const passengerSent = match.passengerId ? 
        this.websocketServer.sendMatchDecisionUpdate(match, false, 'system') : 
        Promise.resolve(true);
      
      const success = driverSent && passengerSent;
      if (success) {
        console.log(`✅ Match expired notifications sent for match ${match.matchId}`);
      }
      
      return success;
    } catch (error) {
      console.error('❌ Error sending match expired:', error);
      return false;
    }
  }

  // ==================== SEARCH NOTIFICATIONS ====================

  // Send search started notification
  sendSearchStarted(userId, searchData) {
    try {
      return this.websocketServer.sendSearchStatusUpdate(userId, {
        searchId: searchData.searchId,
        status: 'searching',
        progress: 10,
        matchCount: 0,
        estimatedTime: 60,
        message: 'Searching for matches...'
      });
    } catch (error) {
      console.error('❌ Error sending search started:', error);
      return false;
    }
  }

  // Send search stopped notification
  sendSearchStopped(userId, data) {
    try {
      return this.websocketServer.sendSearchTimeout(userId, {
        searchId: data.searchId,
        message: data.reason || 'Search stopped',
        searchType: data.searchType || 'immediate',
        duration: data.duration || 0
      });
    } catch (error) {
      console.error('❌ Error sending search stopped:', error);
      return false;
    }
  }

  // Send search timeout notification
  sendSearchTimeout(userId, data) {
    try {
      return this.websocketServer.sendSearchTimeout(userId, {
        searchId: data.searchId,
        message: 'Search timeout - No matches found',
        searchType: data.searchType || 'immediate',
        duration: data.duration || 300
      });
    } catch (error) {
      console.error('❌ Error sending search timeout:', error);
      return false;
    }
  }

  // Send search status update
  sendSearchStatusUpdate(userId, searchData) {
    try {
      return this.websocketServer.sendSearchStatusUpdate(userId, searchData);
    } catch (error) {
      console.error('❌ Error sending search status update:', error);
      return false;
    }
  }

  // Send scheduled search activated
  sendScheduledSearchActivated(userId, searchData) {
    try {
      return this.websocketServer.sendScheduledSearchActivated(userId, searchData);
    } catch (error) {
      console.error('❌ Error sending scheduled search activated:', error);
      return false;
    }
  }

  // Send ride reminder
  sendRideReminder(userId, reminderData) {
    try {
      return this.websocketServer.sendRideReminder(userId, reminderData);
    } catch (error) {
      console.error('❌ Error sending ride reminder:', error);
      return false;
    }
  }

  // ==================== GENERAL NOTIFICATIONS ====================

  // Send custom notification to user
  sendNotification(userId, notification) {
    try {
      const { type, message, data = {} } = notification;
      
      if (!type || !message) {
        console.error('❌ Notification type and message are required');
        return false;
      }
      
      const success = this.websocketServer.sendToUser(userId, {
        type: type,
        data: {
          message,
          ...data,
          timestamp: Date.now()
        }
      });
      
      if (success) {
        this.stats.notificationsSent++;
        console.log(`📱 ${type} sent to ${userId}: ${message}`);
      } else {
        this.stats.notificationsFailed++;
      }
      
      return success;
    } catch (error) {
      console.error('❌ Error sending notification:', error);
      this.stats.errors++;
      return false;
    }
  }

  // ==================== UTILITY METHODS ====================

  // Check if user is connected
  isUserConnected(userId) {
    if (!this.websocketServer) return false;
    return this.websocketServer.isUserConnected(userId);
  }

  // Get connected users
  getConnectedUsers() {
    return this.websocketServer ? this.websocketServer.getConnectedUsers() : [];
  }

  // Get statistics
  getStats() {
    return {
      ...this.stats,
      connectedUsers: this.getConnectedUsers().length,
      websocketServer: this.websocketServer ? 'Available' : 'Not available',
      status: 'Active'
    };
  }

  // Cleanup stats (optional)
  cleanupStats() {
    console.log('🧹 Cleaning up notification stats');
    this.stats = {
      notificationsSent: 0,
      notificationsFailed: 0,
      errors: 0,
      lastCleanup: new Date().toISOString()
    };
    console.log('✅ Notification stats cleaned up');
  }
}

module.exports = NotificationService;
