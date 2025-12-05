// src/websocketServer.js - COMPLETELY FIXED VERSION WITH sendMatchProposal
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

  // ✅ NEW: Send search started notification
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

  // ✅ NEW: Send match proposal to passenger (CRITICAL - THIS FIXES YOUR ERROR)
  sendMatchProposal(matchData) {
    console.log(`📋 Sending match proposal for match: ${matchData.matchId}`);
    
    const message = {
      type: 'MATCH_PROPOSAL',
      data: {
        matchId: matchData.matchId,
        driver: {
          id: matchData.driverId,
          name: matchData.driverName,
          vehicleInfo: matchData.vehicleInfo || {},
          rating: matchData.driverRating || 4.5,
          capacity: matchData.capacity || 4,
          vehicleType: matchData.vehicleType || 'car',
          estimatedTime: matchData.estimatedTime || '5-10 mins',
          phone: matchData.driverPhone || null,
          licensePlate: matchData.licensePlate || null
        },
        route: {
          pickupLocation: matchData.pickupLocation,
          destinationLocation: matchData.destinationLocation,
          pickupName: matchData.pickupName,
          destinationName: matchData.destinationName,
          distance: matchData.distance || '2.5 km',
          estimatedDuration: matchData.estimatedDuration || '15 mins',
          polyline: matchData.polyline || null
        },
        fare: {
          amount: matchData.fareAmount || 25.50,
          currency: matchData.currency || 'USD',
          isEstimated: matchData.isEstimated || true,
          breakdown: matchData.fareBreakdown || {
            baseFare: 15.00,
            distanceCharge: 8.50,
            timeCharge: 2.00
          }
        },
        matchInfo: {
          similarityScore: matchData.similarityScore || 85,
          matchQuality: matchData.matchQuality || 'good',
          isScheduled: matchData.isScheduled || false,
          scheduledTime: matchData.scheduledTime,
          rideType: matchData.rideType || 'immediate',
          matchAlgorithm: matchData.matchAlgorithm || 'optimal_route'
        },
        proposalDetails: {
          expiresAt: matchData.expiresAt || new Date(Date.now() + 30000).toISOString(), // 30 seconds to accept
          acceptDeadline: matchData.acceptDeadline || new Date(Date.now() + 30000).toISOString(),
          requiresAcceptance: true,
          autoDeclineIfNotAccepted: true
        },
        timestamp: new Date().toISOString(),
        serverTime: new Date().toISOString(),
        message: 'A driver is available for your route. Please accept within 30 seconds.'
      }
    };

    // Send to passenger
    const sent = this.sendToUser(matchData.passengerId, message);
    
    if (sent) {
      console.log(`✅ Match proposal sent to passenger ${matchData.passengerId} for match ${matchData.matchId}`);
      
      // Also notify driver that proposal was sent
      this.sendToUser(matchData.driverId, {
        type: 'MATCH_PROPOSAL_SENT',
        data: {
          matchId: matchData.matchId,
          passengerId: matchData.passengerId,
          passengerName: matchData.passengerName,
          proposalSentAt: new Date().toISOString(),
          expiresAt: matchData.expiresAt || new Date(Date.now() + 30000).toISOString(),
          timestamp: new Date().toISOString(),
          message: 'Match proposal sent to passenger. Waiting for acceptance...'
        }
      });
    } else {
      console.error(`❌ Failed to send match proposal to passenger ${matchData.passengerId}`);
      
      // Notify driver of failure
      this.sendToUser(matchData.driverId, {
        type: 'MATCH_PROPOSAL_FAILED',
        data: {
          matchId: matchData.matchId,
          passengerId: matchData.passengerId,
          reason: 'Passenger not connected',
          timestamp: new Date().toISOString(),
          message: 'Could not send proposal to passenger'
        }
      });
    }
    
    return sent;
  }

  // ✅ NEW: Send match proposal accepted notification
  sendMatchProposalAccepted(matchData) {
    const message = {
      type: 'MATCH_PROPOSAL_ACCEPTED',
      data: {
        matchId: matchData.matchId,
        acceptedBy: matchData.acceptedBy,
        acceptedAt: new Date().toISOString(),
        timestamp: new Date().toISOString(),
        message: 'Match proposal accepted',
        nextSteps: 'Proceed to pickup location'
      }
    };

    // Notify both parties
    const driverSent = this.sendToUser(matchData.driverId, message);
    const passengerSent = this.sendToUser(matchData.passengerId, {
      type: 'MATCH_PROPOSAL_ACCEPTED_CONFIRMATION',
      data: {
        matchId: matchData.matchId,
        acceptedAt: new Date().toISOString(),
        driverNotified: driverSent,
        timestamp: new Date().toISOString(),
        message: 'You have accepted the match. Driver has been notified.'
      }
    });

    console.log(`✅ Match proposal accepted - Driver notified: ${driverSent}, Passenger confirmed: ${passengerSent}`);
    return { driverSent, passengerSent };
  }

  // ✅ NEW: Send match proposal declined notification
  sendMatchProposalDeclined(matchData) {
    const message = {
      type: 'MATCH_PROPOSAL_DECLINED',
      data: {
        matchId: matchData.matchId,
        declinedBy: matchData.declinedBy,
        reason: matchData.reason || 'No reason provided',
        declinedAt: new Date().toISOString(),
        timestamp: new Date().toISOString(),
        message: 'Match proposal declined'
      }
    };

    // Notify both parties
    const driverSent = this.sendToUser(matchData.driverId, message);
    const passengerSent = this.sendToUser(matchData.passengerId, message);

    console.log(`❌ Match proposal declined - Driver notified: ${driverSent}, Passenger notified: ${passengerSent}`);
    return { driverSent, passengerSent };
  }

  // ✅ NEW: Send match proposal expired notification
  sendMatchProposalExpired(matchData) {
    const message = {
      type: 'MATCH_PROPOSAL_EXPIRED',
      data: {
        matchId: matchData.matchId,
        expiredAt: new Date().toISOString(),
        reason: 'Proposal acceptance time expired',
        timestamp: new Date().toISOString(),
        message: 'Match proposal has expired'
      }
    };

    // Notify both parties
    const driverSent = this.sendToUser(matchData.driverId, message);
    const passengerSent = this.sendToUser(matchData.passengerId, message);

    console.log(`⏰ Match proposal expired - Driver notified: ${driverSent}, Passenger notified: ${passengerSent}`);
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
        activeProposals: statusData.activeProposals || 0,
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
        proposalsSent: timeoutData.proposalsSent || 0,
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
        totalMatches: stopData.totalMatches || 0,
        totalProposals: stopData.totalProposals || 0,
        stoppedBy: stopData.stoppedBy || 'user',
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
    console.log(`📨 Handling message from ${userId}: ${data.type}`);
    
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
        
      case 'MATCH_PROPOSAL_RESPONSE':
        console.log(`📋 Match proposal response from ${userId}:`, data.decision);
        this.handleMatchProposalResponse(userId, data);
        break;
        
      case 'PROPOSAL_STATUS_REQUEST':
        console.log(`🔍 Proposal status request from ${userId} for match: ${data.matchId}`);
        this.handleProposalStatusRequest(userId, data);
        break;
        
      default:
        console.log(`📨 Unknown message type from ${userId}:`, data.type);
        this.sendToUser(userId, {
          type: 'UNKNOWN_MESSAGE_TYPE',
          receivedType: data.type,
          timestamp: new Date().toISOString(),
          message: 'Unknown message type received'
        });
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
        activeProposals: 0,
        timestamp: new Date().toISOString()
      }
    });
  }

  // Handle match acknowledgments
  handleMatchAcknowledgment(userId, data) {
    const { matchId } = data;
    console.log(`✅ Match ${matchId} acknowledged by ${userId}`);
    
    this.sendToUser(userId, {
      type: 'MATCH_ACKNOWLEDGED',
      matchId: matchId,
      timestamp: new Date().toISOString(),
      message: 'Match acknowledgment received'
    });
  }

  // ✅ NEW: Handle match proposal responses
  handleMatchProposalResponse(userId, data) {
    const { matchId, decision, reason } = data;
    console.log(`📋 Match proposal response from ${userId}: ${decision} for match ${matchId}`);
    
    // Send immediate acknowledgment
    this.sendToUser(userId, {
      type: 'PROPOSAL_RESPONSE_ACK',
      matchId: matchId,
      decision: decision,
      timestamp: new Date().toISOString(),
      message: `Your ${decision} response has been received`
    });
    
    // You would typically forward this to the other user here
    // For example, if passenger accepted, notify driver
    if (decision === 'accept') {
      console.log(`✅ Passenger ${userId} accepted match ${matchId}`);
    } else if (decision === 'decline') {
      console.log(`❌ Passenger ${userId} declined match ${matchId}: ${reason || 'No reason given'}`);
    }
  }

  // ✅ NEW: Handle proposal status requests
  handleProposalStatusRequest(userId, data) {
    const { matchId } = data;
    
    this.sendToUser(userId, {
      type: 'PROPOSAL_STATUS_RESPONSE',
      data: {
        matchId: matchId,
        status: 'unknown', // You would check your match state here
        expiresAt: new Date(Date.now() + 15000).toISOString(),
        timestamp: new Date().toISOString(),
        message: 'Proposal status response'
      }
    });
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
        isAlive: client.isAlive,
        connectedSince: client.connectedSince || 'unknown'
      });
    });
    return connections;
  }

  // ✅ NEW: Clean up stale connections
  cleanupStaleConnections() {
    const staleUsers = [];
    this.connectedClients.forEach((client, userId) => {
      if (client.readyState !== WebSocket.OPEN) {
        staleUsers.push(userId);
      }
    });
    
    staleUsers.forEach(userId => {
      this.connectedClients.delete(userId);
    });
    
    if (staleUsers.length > 0) {
      console.log(`🧹 Cleaned up ${staleUsers.length} stale connections: ${staleUsers.join(', ')}`);
    }
    
    return staleUsers.length;
  }

  // ✅ NEW: Get user connection status
  getUserConnectionStatus(userId) {
    const client = this.connectedClients.get(userId);
    if (!client) {
      return {
        connected: false,
        message: 'User not connected'
      };
    }
    
    return {
      connected: client.readyState === WebSocket.OPEN,
      readyState: client.readyState,
      isAlive: client.isAlive,
      userId: userId,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = WebSocketServer;
