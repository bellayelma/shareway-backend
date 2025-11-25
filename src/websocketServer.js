// src/websocketServer.js
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
          timestamp: Date.now()
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

  // Send match to both driver and passenger
  sendMatchToUsers(matchData) {
    const driverMessage = {
      type: 'PASSENGER_FOUND',
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
        timestamp: matchData.timestamp || new Date().toISOString()
      }
    };

    const passengerMessage = {
      type: 'DRIVER_FOUND',
      data: {
        matchId: matchData.matchId,
        driver: {
          id: matchData.driverId,
          name: matchData.driverName,
          similarityScore: matchData.similarityScore,
          vehicleInfo: matchData.vehicleInfo || {},
          capacity: matchData.capacity || 4
        },
        route: {
          pickupName: matchData.pickupName,
          destinationName: matchData.destinationName
        },
        timestamp: matchData.timestamp || new Date().toISOString()
      }
    };

    const driverSent = this.sendToUser(matchData.driverId, driverMessage);
    const passengerSent = this.sendToUser(matchData.passengerId, passengerMessage);

    console.log(`📱 Match forwarded - Driver: ${driverSent}, Passenger: ${passengerSent}`);
    return { driverSent, passengerSent };
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
        // Forward to match decision endpoint (you'll need to implement this)
        // handleWebSocketMatchDecision(data.matchId, data.decision, userId);
        break;
        
      case 'HEARTBEAT':
        this.sendToUser(userId, { 
          type: 'HEARTBEAT_ACK',
          timestamp: Date.now() 
        });
        break;
        
      default:
        console.log(`📨 Unknown message type from ${userId}:`, data.type);
    }
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
    this.connectedClients.forEach((client, userId) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    });
  }
}

module.exports = WebSocketServer;
