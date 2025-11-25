// src/websocketServer.js - ENHANCED WITH SCHEDULED MATCH SUPPORT
const WebSocket = require('ws');

class WebSocketServer {
  constructor(server) {
    this.wss = new WebSocket.Server({ server });
    this.connectedClients = new Map(); // userId -> WebSocket
    
    this.setupWebSocket();
  }

  setupWebSocket() {
    this.wss.on('connection', (ws, req) => {
      console.log('🔌 New WebSocket connection');
      
      // Extract userId from query parameters
      const url = new URL(req.url, `http://${req.headers.host}`);
      const userId = url.searchParams.get('userId');
      
      if (userId) {
        this.connectedClients.set(userId, ws);
        console.log(`✅ Flutter app connected: ${userId}`);
        
        // Send welcome message
        this.sendToUser(userId, {
          type: 'CONNECTED',
          message: 'WebSocket connected successfully',
          timestamp: Date.now(),
          serverTime: new Date().toISOString()
        });
      }

      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message);
          console.log(`📨 Received WebSocket message from ${userId}: ${data.type}`);
          this.handleMessage(userId, data);
        } catch (error) {
          console.error('❌ Error parsing WebSocket message:', error);
        }
      });

      ws.on('close', () => {
        if (userId) {
          this.connectedClients.delete(userId);
          console.log(`❌ Flutter app disconnected: ${userId}`);
        }
      });

      ws.on('error', (error) => {
        console.error(`❌ WebSocket error for user ${userId}:`, error);
        if (userId) {
          this.connectedClients.delete(userId);
        }
      });
    });

    console.log('✅ WebSocket Server Started');
  }

  // Send message to specific user
  sendToUser(userId, message) {
    try {
      const client = this.connectedClients.get(userId);
      if (client && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
        console.log(`📱 Message sent to ${userId}: ${message.type}`);
        return true;
      } else {
        console.log(`⚠️ User ${userId} not connected or WebSocket not open`);
        return false;
      }
    } catch (error) {
      console.error(`❌ Error sending message to ${userId}:`, error);
      return false;
    }
  }

  // ✅ ENHANCED: Send match to both driver and passenger (supports both immediate & scheduled)
  sendMatchToUsers(matchData) {
    const isScheduled = matchData.rideType === 'scheduled' || matchData.isScheduled;
    const matchType = isScheduled ? 'SCHEDULED_' : '';
    
    const driverMessage = {
      type: `${matchType}PASSENGER_FOUND`,
      data: {
        matchId: matchData.matchId,
        passenger: {
          id: matchData.passengerId,
          name: matchData.passengerName,
          similarityScore: matchData.similarityScore,
          pickupLocation: matchData.pickupLocation,
          destinationLocation: matchData.destinationLocation,
          passengerCount: matchData.passengerCount || 1
        },
        route: {
          pickupName: matchData.pickupName,
          destinationName: matchData.destinationName
        },
        matchInfo: {
          isScheduled: isScheduled,
          scheduledTime: matchData.scheduledTime,
          rideType: matchData.rideType || 'immediate',
          matchQuality: matchData.matchQuality || 'good'
        },
        timestamp: matchData.timestamp || new Date().toISOString()
      }
    };

    const passengerMessage = {
      type: `${matchType}DRIVER_FOUND`,
      data: {
        matchId: matchData.matchId,
        driver: {
          id: matchData.driverId,
          name: matchData.driverName,
          similarityScore: matchData.similarityScore,
          vehicleInfo: matchData.vehicleInfo || {},
          capacity: matchData.capacity || 4,
          vehicleType: matchData.vehicleType || 'car'
        },
        route: {
          pickupName: matchData.pickupName,
          destinationName: matchData.destinationName
        },
        matchInfo: {
          isScheduled: isScheduled,
          scheduledTime: matchData.scheduledTime,
          rideType: matchData.rideType || 'immediate',
          matchQuality: matchData.matchQuality || 'good'
        },
        timestamp: matchData.timestamp || new Date().toISOString()
      }
    };

    const driverSent = this.sendToUser(matchData.driverId, driverMessage);
    const passengerSent = this.sendToUser(matchData.passengerId, passengerMessage);

    console.log(`📱 ${isScheduled ? 'SCHEDULED ' : ''}Match forwarded - Driver: ${driverSent}, Passenger: ${passengerSent}`);
    return { driverSent, passengerSent };
  }

  // ✅ NEW: Send scheduled match notification (for pre-matches)
  sendScheduledMatchNotification(matchData) {
    const scheduledTime = new Date(matchData.scheduledTime);
    const timeString = scheduledTime.toLocaleString();
    
    const driverMessage = {
      type: 'SCHEDULED_PASSENGER_FOUND',
      data: {
        matchId: matchData.matchId,
        passenger: {
          id: matchData.passengerId,
          name: matchData.passengerName,
          similarityScore: matchData.similarityScore,
          pickupLocation: matchData.pickupLocation,
          destinationLocation: matchData.destinationLocation,
          passengerCount: matchData.passengerCount || 1
        },
        route: {
          pickupName: matchData.pickupName,
          destinationName: matchData.destinationName
        },
        scheduleInfo: {
          isScheduled: true,
          scheduledTime: matchData.scheduledTime,
          formattedTime: timeString,
          matchType: 'pre_match', // This is a pre-match before the actual ride
          daysUntilRide: this.calculateDaysUntil(matchData.scheduledTime),
          notificationType: 'advance_notice'
        },
        timestamp: matchData.timestamp || new Date().toISOString()
      }
    };

    const passengerMessage = {
      type: 'SCHEDULED_DRIVER_FOUND',
      data: {
        matchId: matchData.matchId,
        driver: {
          id: matchData.driverId,
          name: matchData.driverName,
          similarityScore: matchData.similarityScore,
          vehicleInfo: matchData.vehicleInfo || {},
          capacity: matchData.capacity || 4,
          vehicleType: matchData.vehicleType || 'car'
        },
        route: {
          pickupName: matchData.pickupName,
          destinationName: matchData.destinationName
        },
        scheduleInfo: {
          isScheduled: true,
          scheduledTime: matchData.scheduledTime,
          formattedTime: timeString,
          matchType: 'pre_match',
          daysUntilRide: this.calculateDaysUntil(matchData.scheduledTime),
          notificationType: 'advance_notice'
        },
        timestamp: matchData.timestamp || new Date().toISOString()
      }
    };

    const driverSent = this.sendToUser(matchData.driverId, driverMessage);
    const passengerSent = this.sendToUser(matchData.passengerId, passengerMessage);

    console.log(`📅 SCHEDULED pre-match notification sent - Driver: ${driverSent}, Passenger: ${passengerSent}`);
    return { driverSent, passengerSent };
  }

  // ✅ NEW: Send search status updates
  sendSearchStatusUpdate(userId, statusData) {
    const message = {
      type: 'SEARCH_STATUS_UPDATE',
      data: {
        searchId: statusData.searchId,
        status: statusData.status,
        rideType: statusData.rideType,
        matchesFound: statusData.matchesFound || 0,
        timeRemaining: statusData.timeRemaining,
        scheduledTime: statusData.scheduledTime,
        timestamp: new Date().toISOString()
      }
    };

    return this.sendToUser(userId, message);
  }

  // ✅ NEW: Send search timeout notification
  sendSearchTimeout(userId, timeoutData) {
    const message = {
      type: 'SEARCH_TIMEOUT',
      data: {
        searchId: timeoutData.searchId,
        message: timeoutData.message || 'Search automatically stopped',
        duration: timeoutData.duration,
        rideType: timeoutData.rideType,
        matchesFound: timeoutData.matchesFound || 0,
        timestamp: new Date().toISOString()
      }
    };

    return this.sendToUser(userId, message);
  }

  // ✅ NEW: Send scheduled search activation notification
  sendScheduledSearchActivated(userId, activationData) {
    const message = {
      type: 'SCHEDULED_SEARCH_ACTIVATED',
      data: {
        searchId: activationData.searchId,
        scheduledTime: activationData.scheduledTime,
        message: 'Your scheduled search is now active and looking for matches',
        activationTime: new Date().toISOString(),
        timeUntilRide: activationData.timeUntilRide,
        timestamp: new Date().toISOString()
      }
    };

    return this.sendToUser(userId, message);
  }

  // ✅ NEW: Send match decision updates
  sendMatchDecisionUpdate(userId, decisionData) {
    const message = {
      type: 'MATCH_DECISION_UPDATE',
      data: {
        matchId: decisionData.matchId,
        decision: decisionData.decision, // 'accepted' or 'rejected'
        decidedBy: decisionData.decidedBy,
        timestamp: new Date().toISOString()
      }
    };

    return this.sendToUser(userId, message);
  }

  // ✅ NEW: Send ride reminder (for scheduled matches)
  sendRideReminder(userId, reminderData) {
    const message = {
      type: 'RIDE_REMINDER',
      data: {
        matchId: reminderData.matchId,
        scheduledTime: reminderData.scheduledTime,
        message: `Reminder: Your scheduled ride is coming up soon`,
        timeUntilRide: reminderData.timeUntilRide,
        partnerName: reminderData.partnerName,
        pickupLocation: reminderData.pickupLocation,
        timestamp: new Date().toISOString()
      }
    };

    return this.sendToUser(userId, message);
  }

  // Handle incoming messages from Flutter
  handleMessage(userId, data) {
    switch (data.type) {
      case 'PING':
        this.sendToUser(userId, { 
          type: 'PONG', 
          timestamp: Date.now(),
          serverTime: new Date().toISOString()
        });
        break;
        
      case 'MATCH_DECISION':
        console.log(`🤝 Match decision from ${userId}:`, data.decision);
        this.handleMatchDecision(userId, data);
        break;
        
      case 'HEARTBEAT':
        this.sendToUser(userId, { 
          type: 'HEARTBEAT_ACK',
          timestamp: Date.now(),
          serverTime: new Date().toISOString()
        });
        break;

      case 'SEARCH_STATUS_REQUEST':
        console.log(`🔍 Search status request from ${userId}`);
        this.handleSearchStatusRequest(userId, data);
        break;

      case 'ACKNOWLEDGE_MATCH':
        console.log(`✅ Match acknowledged by ${userId}: ${data.matchId}`);
        this.handleMatchAcknowledgment(userId, data);
        break;
        
      default:
        console.log(`📨 Unknown message type from ${userId}:`, data.type);
    }
  }

  // ✅ NEW: Handle match decisions
  handleMatchDecision(userId, data) {
    const { matchId, decision } = data;
    console.log(`🤝 Match decision from ${userId}: ${decision} for match ${matchId}`);
    
    // Forward to your match decision handler
    // You'll need to implement this based on your backend logic
    // handleWebSocketMatchDecision(matchId, decision, userId);
    
    // Send acknowledgment
    this.sendToUser(userId, {
      type: 'MATCH_DECISION_ACK',
      matchId: matchId,
      decision: decision,
      timestamp: new Date().toISOString()
    });
  }

  // ✅ NEW: Handle search status requests
  handleSearchStatusRequest(userId, data) {
    // You can implement this to send current search status
    // This would query your activeSearches/scheduledSearches maps
    
    this.sendToUser(userId, {
      type: 'SEARCH_STATUS_RESPONSE',
      data: {
        userId: userId,
        isSearching: true, // You'd calculate this
        matchesFound: 0, // You'd calculate this
        timestamp: new Date().toISOString()
      }
    });
  }

  // ✅ NEW: Handle match acknowledgments
  handleMatchAcknowledgment(userId, data) {
    const { matchId } = data;
    console.log(`✅ Match ${matchId} acknowledged by ${userId}`);
    
    // You can update match status in your database here
  }

  // ✅ NEW: Helper to calculate days until scheduled ride
  calculateDaysUntil(scheduledTime) {
    const now = new Date();
    const scheduled = new Date(scheduledTime);
    const diffTime = scheduled.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays;
  }

  // Get connected clients count
  getConnectedCount() {
    return this.connectedClients.size;
  }

  // Get all connected user IDs
  getConnectedUsers() {
    return Array.from(this.connectedClients.keys());
  }

  // Broadcast to all connected clients
  broadcast(message) {
    let sentCount = 0;
    this.connectedClients.forEach((client, userId) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
        sentCount++;
      }
    });
    console.log(`📢 Broadcast sent to ${sentCount} clients`);
    return sentCount;
  }

  // ✅ NEW: Check if user is connected
  isUserConnected(userId) {
    const client = this.connectedClients.get(userId);
    return client && client.readyState === WebSocket.OPEN;
  }

  // ✅ NEW: Get connection statistics
  getConnectionStats() {
    return {
      totalConnections: this.connectedClients.size,
      connectedUsers: Array.from(this.connectedClients.keys()),
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = WebSocketServer;
