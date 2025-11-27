// src/websocketServer.js - COMPLETELY FIXED VERSION
const WebSocket = require('ws');

class WebSocketServer {
  constructor(server) {
    this.wss = new WebSocket.Server({ 
      server,
      perMessageDeflate: false,
      clientTracking: true
    });
    this.connectedClients = new Map(); // userId -> WebSocket
    
    this.setupWebSocket();
    console.log('✅ WebSocket Server Constructor Initialized');
  }

  setupWebSocket() {
    this.wss.on('connection', (ws, req) => {
      console.log('🔌 New WebSocket connection attempt');
      
      try {
        // Extract userId from query parameters - FIXED URL PARSING
        const url = new URL(req.url, `http://${req.headers.host}`);
        const userId = url.searchParams.get('userId');
        
        if (!userId) {
          console.log('❌ WebSocket connection rejected: No userId provided');
          ws.close(1008, 'User ID required');
          return;
        }

        console.log(`✅ Flutter app connected: ${userId}`);
        
        // Store connection
        this.connectedClients.set(userId, ws);
        
        // Send immediate welcome message
        this.sendToUser(userId, {
          type: 'CONNECTED',
          message: 'WebSocket connected successfully',
          timestamp: Date.now(),
          serverTime: new Date().toISOString(),
          userId: userId
        });

        // ✅ ADDED: Send connection stats
        console.log(`📊 Connection established - Total: ${this.connectedClients.size}, Users: ${Array.from(this.connectedClients.keys()).join(', ')}`);

        ws.on('message', (message) => {
          try {
            const data = JSON.parse(message);
            console.log(`📨 Received from ${userId}: ${data.type}`);
            this.handleMessage(userId, data);
          } catch (error) {
            console.error('❌ Error parsing WebSocket message:', error);
            this.sendToUser(userId, {
              type: 'ERROR',
              message: 'Invalid message format',
              timestamp: new Date().toISOString()
            });
          }
        });

        ws.on('close', (code, reason) => {
          console.log(`❌ Flutter app disconnected: ${userId} (Code: ${code}, Reason: ${reason})`);
          if (userId) {
            this.connectedClients.delete(userId);
          }
        });

        ws.on('error', (error) => {
          console.error(`❌ WebSocket error for ${userId}:`, error);
          if (userId) {
            this.connectedClients.delete(userId);
          }
        });

        // ✅ ADDED: Heartbeat/ping to keep connection alive
        ws.isAlive = true;
        ws.on('pong', () => {
          ws.isAlive = true;
        });

      } catch (error) {
        console.error('❌ WebSocket connection setup error:', error);
        ws.close(1011, 'Server error');
      }
    });

    // ✅ ADDED: Heartbeat interval to detect dead connections
    const heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          console.log('💔 Terminating dead WebSocket connection');
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);

    this.wss.on('close', () => {
      clearInterval(heartbeatInterval);
    });

    console.log('✅ WebSocket Server Started Successfully');
  }

  // ✅ IMPROVED: Send message to specific user with better error handling
  sendToUser(userId, message) {
    try {
      if (!userId) {
        console.log('⚠️ Cannot send message: userId is null/undefined');
        return false;
      }

      const client = this.connectedClients.get(userId);
      
      if (!client) {
        console.log(`⚠️ User ${userId} not connected in connectedClients map`);
        console.log(`📊 Currently connected users: ${Array.from(this.connectedClients.keys()).join(', ') || 'None'}`);
        return false;
      }

      if (client.readyState === WebSocket.OPEN) {
        const messageString = JSON.stringify(message);
        client.send(messageString);
        console.log(`📱 Message sent to ${userId}: ${message.type}`);
        return true;
      } else {
        console.log(`⚠️ WebSocket not open for ${userId}. State: ${client.readyState}`);
        // Remove stale connection
        if (client.readyState === WebSocket.CLOSED || client.readyState === WebSocket.CLOSING) {
          this.connectedClients.delete(userId);
          console.log(`🧹 Removed stale connection for ${userId}`);
        }
        return false;
      }
    } catch (error) {
      console.error(`❌ Error sending message to ${userId}:`, error);
      // Remove problematic connection
      this.connectedClients.delete(userId);
      return false;
    }
  }

  // ✅ NEW: Send search started notification (CRITICAL FOR YOUR ISSUE)
  sendSearchStarted(userId, searchData) {
    const message = {
      type: 'SEARCH_STARTED',
      data: {
        searchId: searchData.searchId,
        userId: userId,
        status: 'searching',
        rideType: searchData.rideType || 'immediate',
        pickupName: searchData.pickupName,
        destinationName: searchData.destinationName,
        passengerCapacity: searchData.capacity || searchData.passengerCapacity || 1,
        scheduledTime: searchData.scheduledTime,
        message: 'Search started successfully',
        timestamp: new Date().toISOString()
      }
    };

    const sent = this.sendToUser(userId, message);
    console.log(`🎯 Search started notification sent to ${userId}: ${sent}`);
    return sent;
  }

  // ✅ ENHANCED: Send match to both driver and passenger
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

    console.log(`📱 ${isScheduled ? 'SCHEDULED ' : ''}Match sent - Driver: ${driverSent}, Passenger: ${passengerSent}`);
    return { driverSent, passengerSent };
  }

  // ✅ Send search status updates
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
        pickupName: statusData.pickupName,
        destinationName: statusData.destinationName,
        timestamp: new Date().toISOString()
      }
    };

    return this.sendToUser(userId, message);
  }

  // ✅ Send search timeout notification
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

  // ✅ Send search stopped notification
  sendSearchStopped(userId, stopData) {
    const message = {
      type: 'SEARCH_STOPPED',
      data: {
        searchId: stopData.searchId,
        message: 'Search stopped successfully',
        rideType: stopData.rideType,
        timestamp: new Date().toISOString()
      }
    };

    return this.sendToUser(userId, message);
  }

  // ✅ Send scheduled search activation notification
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

  // ✅ Send match decision updates
  sendMatchDecisionUpdate(userId, decisionData) {
    const message = {
      type: 'MATCH_DECISION_UPDATE',
      data: {
        matchId: decisionData.matchId,
        decision: decisionData.decision,
        decidedBy: decisionData.decidedBy,
        timestamp: new Date().toISOString()
      }
    };

    return this.sendToUser(userId, message);
  }

  // ✅ Send ride reminder (for scheduled matches)
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

      case 'CLIENT_CONNECTED':
        console.log(`📱 Client connection confirmed by ${userId}`);
        this.sendToUser(userId, {
          type: 'CONNECTION_CONFIRMED',
          message: 'Connection confirmed by server',
          timestamp: new Date().toISOString()
        });
        break;
        
      default:
        console.log(`📨 Unknown message type from ${userId}:`, data.type);
    }
  }

  // Handle match decisions
  handleMatchDecision(userId, data) {
    const { matchId, decision } = data;
    console.log(`🤝 Match decision from ${userId}: ${decision} for match ${matchId}`);
    
    // Send acknowledgment
    this.sendToUser(userId, {
      type: 'MATCH_DECISION_ACK',
      matchId: matchId,
      decision: decision,
      timestamp: new Date().toISOString()
    });
  }

  // Handle search status requests
  handleSearchStatusRequest(userId, data) {
    this.sendToUser(userId, {
      type: 'SEARCH_STATUS_RESPONSE',
      data: {
        userId: userId,
        isSearching: false, // This should be calculated from your search state
        matchesFound: 0,
        timestamp: new Date().toISOString()
      }
    });
  }

  // Handle match acknowledgments
  handleMatchAcknowledgment(userId, data) {
    const { matchId } = data;
    console.log(`✅ Match ${matchId} acknowledged by ${userId}`);
  }

  // Helper to calculate days until scheduled ride
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
      if (this.sendToUser(userId, message)) {
        sentCount++;
      }
    });
    console.log(`📢 Broadcast sent to ${sentCount} clients`);
    return sentCount;
  }

  // Check if user is connected
  isUserConnected(userId) {
    const client = this.connectedClients.get(userId);
    return client && client.readyState === WebSocket.OPEN;
  }

  // Get connection statistics
  getConnectionStats() {
    return {
      totalConnections: this.connectedClients.size,
      connectedUsers: Array.from(this.connectedClients.keys()),
      timestamp: new Date().toISOString()
    };
  }

  // ✅ NEW: Force disconnect user
  disconnectUser(userId) {
    const client = this.connectedClients.get(userId);
    if (client) {
      client.close(1000, 'Manual disconnect');
      this.connectedClients.delete(userId);
      console.log(`🔌 Manually disconnected user: ${userId}`);
    }
  }

  // ✅ NEW: Get detailed connection info
  getDetailedConnectionInfo() {
    const connections = [];
    this.connectedClients.forEach((client, userId) => {
      connections.push({
        userId: userId,
        readyState: client.readyState,
        isAlive: client.isAlive
      });
    });
    return connections;
  }
}

module.exports = WebSocketServer;
