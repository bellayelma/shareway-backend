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
      
      // Send to driver
      const driverSent = this.sendMatchProposal(match.driverId, {
        matchId: match.matchId,
        passengerId: match.passengerId,
        passengerName: match.passengerName,
        from: match.from,
        to: match.to,
        timestamp: new Date().toISOString()
      });
      
      // Send to passenger
      const passengerSent = this.sendMatchProposal(match.passengerId, {
        matchId: match.matchId,
        driverId: match.driverId,
        driverName: match.driverName,
        from: match.from,
        to: match.to,
        timestamp: new Date().toISOString()
      });
      
      const success = driverSent && passengerSent;
      if (success) this.stats.notificationsSent += 2;
      
      return success;
    } catch (error) {
      console.error('❌ Error sending match proposals:', error);
      this.stats.errors++;
      return false;
    }
  }

  // Send match proposal to a single user
  sendMatchProposal(userId, data) {
    if (!this.websocketServer) {
      console.error('❌ WebSocket server not available');
      this.stats.errors++;
      return false;
    }
    
    if (!userId) {
      console.error('❌ Cannot send message: userId is null/undefined');
      console.error('❌ Data being sent:', data);
      this.stats.errors++;
      return false;
    }
    
    console.log(`📋 Sending match proposal for match: ${data?.matchId} to user: ${userId}`);
    
    if (this.websocketServer.isUserConnected(userId)) {
      this.websocketServer.sendToUser(userId, {
        type: 'MATCH_PROPOSAL',
        ...data
      });
      this.stats.notificationsSent++;
      console.log(`✅ Match proposal sent to ${userId}`);
      return true;
    } else {
      console.log(`📭 User ${userId} not connected, notification will be lost`);
      this.stats.notificationsFailed++;
      return false;
    }
  }

  // Send match accepted notification
  sendMatchAccepted(match) {
    if (!match || !match.driverId || !match.passengerId) {
      console.error('❌ Invalid match data for match accepted');
      return false;
    }
    
    // Notify driver
    const driverNotified = this.sendNotification({
      userId: match.driverId,
      message: `Passenger ${match.passengerName} accepted the match!`,
      type: 'success',
      data: {
        event: 'MATCH_ACCEPTED',
        matchId: match.matchId,
        passengerId: match.passengerId,
        passengerName: match.passengerName
      }
    });
    
    // Notify passenger
    const passengerNotified = this.sendNotification({
      userId: match.passengerId,
      message: `Driver ${match.driverName} accepted the match!`,
      type: 'success',
      data: {
        event: 'MATCH_ACCEPTED',
        matchId: match.matchId,
        driverId: match.driverId,
        driverName: match.driverName
      }
    });
    
    return driverNotified && passengerNotified;
  }

  // Send match expired notification
  sendMatchExpired(match) {
    if (!match) {
      console.error('❌ Invalid match data for match expired');
      return false;
    }
    
    console.log(`📤 Sending match expired for match: ${match.matchId}`);
    
    // Notify driver if exists
    let driverNotified = true;
    if (match.driverId) {
      driverNotified = this.sendNotification({
        userId: match.driverId,
        message: `Match ${match.matchId} has expired`,
        type: 'warning',
        data: {
          event: 'MATCH_EXPIRED',
          matchId: match.matchId
        }
      });
    }
    
    // Notify passenger if exists
    let passengerNotified = true;
    if (match.passengerId) {
      passengerNotified = this.sendNotification({
        userId: match.passengerId,
        message: `Match ${match.matchId} has expired`,
        type: 'warning',
        data: {
          event: 'MATCH_EXPIRED',
          matchId: match.matchId
        }
      });
    }
    
    return driverNotified && passengerNotified;
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
      console.error('❌ Notification data:', notification);
      this.stats.errors++;
      return false;
    }
    
    if (this.websocketServer && this.websocketServer.isUserConnected(userId)) {
      this.websocketServer.sendToUser(userId, {
        type: 'NOTIFICATION',
        message,
        notificationType: type,
        data,
        timestamp: new Date().toISOString()
      });
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
    return this.websocketServer ? this.websocketServer.getAllConnections() : [];
  }

  // Check if user is connected
  isUserConnected(userId) {
    return this.websocketServer ? this.websocketServer.isUserConnected(userId) : false;
  }

  // Get statistics
  getStats() {
    return {
      ...this.stats,
      connectedUsers: this.getConnectedUsers().length,
      status: 'Active'
    };
  }
}

module.exports = NotificationService;
