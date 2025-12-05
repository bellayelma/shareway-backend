// services/notificationService.js
class NotificationService {
  constructor(websocketServer) {
    this.websocketServer = websocketServer;
    this.cleanupInterval = null;
    this.stats = {
      notificationsSent: 0,
      notificationsFailed: 0,
      errors: 0,
      lastCleanup: null
    };
    console.log('🔔 NotificationService initialized');
  }

  // ==================== MATCH NOTIFICATIONS ====================

  // Send a match proposal to both driver and passenger
  async sendMatchProposals(match) {
    try {
      console.log(`📱 Sending match proposals for match ${match?.matchId}`);
      
      if (!match || !match.driverId || !match.passengerId) {
        console.error('❌ Invalid match data for proposals:', match);
        this.stats.errors++;
        return false;
      }
      
      // Send to driver using WebSocketServer's sendMatchProposal
      const driverSent = this.websocketServer.sendMatchProposal(match);
      
      if (driverSent) {
        console.log(`✅ Match proposal sent to driver ${match.driverId}`);
      } else {
        console.error(`❌ Failed to send match proposal to driver ${match.driverId}`);
      }
      
      // For passenger, send a different type of message
      const passengerSent = this.sendToPassenger(match);
      
      if (passengerSent) {
        console.log(`✅ Match notification sent to passenger ${match.passengerId}`);
      } else {
        console.error(`❌ Failed to send match notification to passenger ${match.passengerId}`);
      }
      
      const success = driverSent && passengerSent;
      if (success) this.stats.notificationsSent += 2;
      
      return success;
    } catch (error) {
      console.error('❌ Error sending match proposals:', error);
      this.stats.errors++;
      return false;
    }
  }

  // Send notification to passenger about the match
  sendToPassenger(match) {
    try {
      if (!this.websocketServer) {
        console.error('❌ WebSocket server not available');
        return false;
      }
      
      if (!match || !match.passengerId) {
        console.error('❌ Cannot send to passenger: passengerId is null/undefined');
        return false;
      }
      
      const message = {
        type: 'MATCH_PROPOSAL',
        data: {
          matchId: match.matchId,
          driver: {
            id: match.driverId,
            name: match.driverName,
            vehicleInfo: match.vehicleInfo || {},
            rating: match.driverRating || 4.5,
            capacity: match.capacity || 4
          },
          route: {
            pickupName: match.pickupName,
            destinationName: match.destinationName
          },
          fare: {
            amount: match.estimatedFare || 25.50,
            currency: 'USD'
          },
          expiresAt: new Date(Date.now() + 120000).toISOString(), // 2 minutes
          timestamp: new Date().toISOString(),
          message: 'A driver has been found for your route!'
        }
      };
      
      return this.websocketServer.sendToUser(match.passengerId, message);
      
    } catch (error) {
      console.error('❌ Error sending to passenger:', error);
      return false;
    }
  }

  // Send match proposal to a single user (backup method)
  sendMatchProposal(userId, data) {
    if (!this.websocketServer) {
      console.error('❌ WebSocket server not available');
      this.stats.errors++;
      return false;
    }
    
    if (!userId) {
      console.error('❌ Cannot send message: userId is null/undefined');
      this.stats.errors++;
      return false;
    }
    
    console.log(`📋 Sending match proposal for match: ${data?.matchId} to user: ${userId}`);
    
    // Use the WebSocketServer's sendToUser method
    const sent = this.websocketServer.sendToUser(userId, {
      type: 'MATCH_PROPOSAL',
      ...data
    });
    
    if (sent) {
      this.stats.notificationsSent++;
      console.log(`✅ Match proposal sent to ${userId}`);
    } else {
      console.log(`📭 User ${userId} not connected, notification will be lost`);
      this.stats.notificationsFailed++;
    }
    
    return sent;
  }

  // Send match accepted notification
  sendMatchAccepted(match) {
    try {
      if (!match || !match.driverId || !match.passengerId) {
        console.error('❌ Invalid match data for match accepted');
        return false;
      }
      
      // Use WebSocketServer's sendMatchProposalAccepted if available
      if (this.websocketServer.sendMatchProposalAccepted) {
        return this.websocketServer.sendMatchProposalAccepted(match);
      }
      
      // Fallback: Send notifications manually
      const driverMessage = {
        type: 'MATCH_ACCEPTED',
        data: {
          matchId: match.matchId,
          passengerId: match.passengerId,
          passengerName: match.passengerName,
          acceptedAt: new Date().toISOString(),
          message: 'Passenger has accepted the match!'
        }
      };
      
      const passengerMessage = {
        type: 'MATCH_ACCEPTED',
        data: {
          matchId: match.matchId,
          driverId: match.driverId,
          driverName: match.driverName,
          acceptedAt: new Date().toISOString(),
          message: 'Driver has accepted the match!'
        }
      };
      
      const driverSent = this.websocketServer.sendToUser(match.driverId, driverMessage);
      const passengerSent = this.websocketServer.sendToUser(match.passengerId, passengerMessage);
      
      console.log(`✅ Match accepted notifications - Driver: ${driverSent}, Passenger: ${passengerSent}`);
      return driverSent && passengerSent;
      
    } catch (error) {
      console.error('❌ Error sending match accepted:', error);
      return false;
    }
  }

  // Send match expired notification
  sendMatchExpired(match) {
    try {
      if (!match) {
        console.error('❌ Invalid match data for match expired');
        return false;
      }
      
      console.log(`📤 Sending match expired for match: ${match.matchId}`);
      
      // Use WebSocketServer's sendMatchProposalExpired if available
      if (this.websocketServer.sendMatchProposalExpired) {
        return this.websocketServer.sendMatchProposalExpired(match);
      }
      
      // Fallback: Send notifications manually
      let driverSent = true;
      let passengerSent = true;
      
      if (match.driverId) {
        driverSent = this.websocketServer.sendToUser(match.driverId, {
          type: 'MATCH_EXPIRED',
          data: {
            matchId: match.matchId,
            expiredAt: new Date().toISOString(),
            message: 'Match proposal has expired'
          }
        });
      }
      
      if (match.passengerId) {
        passengerSent = this.websocketServer.sendToUser(match.passengerId, {
          type: 'MATCH_EXPIRED',
          data: {
            matchId: match.matchId,
            expiredAt: new Date().toISOString(),
            message: 'Match proposal has expired'
          }
        });
      }
      
      console.log(`⏰ Match expired notifications - Driver: ${driverSent}, Passenger: ${passengerSent}`);
      return driverSent && passengerSent;
      
    } catch (error) {
      console.error('❌ Error sending match expired:', error);
      return false;
    }
  }

  // ==================== SEARCH NOTIFICATIONS ====================

  // Send search stopped notification
  sendSearchStopped(userId, data) {
    return this.sendNotification({
      userId,
      message: 'Your search has been stopped',
      type: 'info',
      data: {
        event: 'SEARCH_STOPPED',
        ...data
      }
    });
  }

  // Send search timeout notification
  sendSearchTimeout(userId, data) {
    return this.sendNotification({
      userId,
      message: 'Your search has timed out',
      type: 'warning',
      data: {
        event: 'SEARCH_TIMEOUT',
        ...data
      }
    });
  }

  // ==================== GENERAL NOTIFICATIONS ====================

  // Send notification to a user
  sendNotification(notification) {
    const { userId, message, type = 'info', data = {} } = notification;
    
    if (!userId) {
      console.error('❌ Cannot send notification: userId is required');
      this.stats.errors++;
      return false;
    }
    
    if (!this.websocketServer) {
      console.error('❌ WebSocket server not available');
      return false;
    }
    
    const wsMessage = {
      type: 'NOTIFICATION',
      data: {
        message,
        notificationType: type,
        ...data,
        timestamp: new Date().toISOString()
      }
    };
    
    const sent = this.websocketServer.sendToUser(userId, wsMessage);
    
    if (sent) {
      console.log(`📱 Notification sent to ${userId}: ${message}`);
      this.stats.notificationsSent++;
      return true;
    } else {
      console.log(`📭 User ${userId} not connected, notification will be lost`);
      this.stats.notificationsFailed++;
      return false;
    }
  }

  // ==================== CLEANUP & MAINTENANCE ====================

  // Start cleanup interval (for stats cleanup only)
  startCleanupInterval(intervalMinutes = 60) {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    this.cleanupInterval = setInterval(() => {
      this.cleanupStats();
    }, intervalMinutes * 60 * 1000);
    
    console.log(`📊 Notification stats cleanup started (every ${intervalMinutes} minutes)`);
    
    // Also cleanup WebSocket stale connections if available
    if (this.websocketServer.cleanupStaleConnections) {
      setInterval(() => {
        this.websocketServer.cleanupStaleConnections();
      }, 5 * 60 * 1000); // Every 5 minutes
    }
  }

  // Stop cleanup interval
  stopCleanupInterval() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      console.log('✅ Notification cleanup interval stopped');
    }
  }

  // Cleanup stats (reset counters periodically)
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

  // ==================== UTILITY METHODS ====================

  // Get connected users
  getConnectedUsers() {
    return this.websocketServer ? this.websocketServer.getConnectedUsers() : [];
  }

  // Check if user is connected - FIXED: Use the WebSocketServer's method
  isUserConnected(userId) {
    if (!this.websocketServer) return false;
    
    // Use the new method from WebSocketServer
    if (this.websocketServer.isUserConnected) {
      return this.websocketServer.isUserConnected(userId);
    }
    
    // Fallback: Check via getConnectedUsers
    const connectedUsers = this.getConnectedUsers();
    return connectedUsers.includes(userId);
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
}

module.exports = NotificationService;
