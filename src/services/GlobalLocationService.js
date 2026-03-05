const EventEmitter = require('events');

class GlobalLocationService extends EventEmitter {
  constructor() {
    super();
    this.globalLocation = null;
    this.locationHistory = [];
    this.userConnections = new Map(); // userId -> connection data
    this.connections = new Map(); // userId -> WebSocket connection (for backward compatibility)
    this.subscribers = new Map(); // userId -> callback
    this.subscriberActivity = new Map(); // userId -> lastActivity timestamp
    this.sessionSubscriptions = new Map(); // sessionId -> Set of userIds
    this.MAX_HISTORY = 100;
    this.cleanupInterval = null;
    this.startTime = Date.now();
    console.log('📍 GlobalLocationService initialized');
  }

  // ==================== CORE METHODS ====================

  // Method to handle different message types
  handleMessage(message) {
    try {
      if (!message || !message.type) {
        return { success: false, error: 'Invalid message format' };
      }

      console.log(`📍 GlobalLocationService received: ${message.type}`);

      switch (message.type) {
        case 'LOCATION_UPDATE':
          return this.processLocationUpdate(message);
        
        case 'GET_GLOBAL_LOCATION':
          return this.getGlobalLocation(message.userId);
        
        case 'SUBSCRIBE_LOCATION':
          return this.subscribeToLocation(message.userId, message.callback);
        
        case 'UNSUBSCRIBE_LOCATION':
          return this.unsubscribeFromLocation(message.userId);
        
        case 'CONNECTION_ACTIVE':
          return this.updateConnectionActivity(message.userId);
        
        case 'HEARTBEAT':
          return this.handleHeartbeat(message);
        
        case 'GET_NEARBY_USERS':
          return this.getNearbyUsers(message);
        
        case 'GET_ALL_USERS':
          return this.getAllUsers(message);
        
        default:
          console.log(`⚠️ Unknown message type in GlobalLocationService: ${message.type}`);
          return { success: false, error: `Unknown message type: ${message.type}` };
      }
    } catch (error) {
      console.error('❌ Error in GlobalLocationService.handleMessage:', error);
      return { success: false, error: error.message };
    }
  }

  // ==================== MATCH HANDLING METHODS ====================

  // Handle match creation event (REQUIRED by MatchingService)
  handleMatchCreated(matchData) {
    try {
      console.log(`📍 GlobalLocationService: Handling match created: ${matchData.matchId}`);
      
      const { matchId, driverId, passengerId, passengerField } = matchData;
      
      // Update user connections for both users
      const now = Date.now();
      
      // Update driver connection
      if (this.userConnections.has(driverId)) {
        const driverConnection = this.userConnections.get(driverId);
        driverConnection.inMatch = true;
        driverConnection.currentMatch = matchId;
        driverConnection.matchPartner = passengerId;
        driverConnection.lastActivity = now;
        driverConnection.passengerField = passengerField;
      }
      
      // Update passenger connection
      if (this.userConnections.has(passengerId)) {
        const passengerConnection = this.userConnections.get(passengerId);
        passengerConnection.inMatch = true;
        passengerConnection.currentMatch = matchId;
        passengerConnection.matchPartner = driverId;
        passengerConnection.lastActivity = now;
      }
      
      // Create a location sharing session for the match
      const sessionId = `match_${matchId}`;
      
      // Create subscription set for this session
      if (!this.sessionSubscriptions.has(sessionId)) {
        this.sessionSubscriptions.set(sessionId, new Set());
      }
      
      // Add both users to the session
      this.sessionSubscriptions.get(sessionId).add(driverId);
      this.sessionSubscriptions.get(sessionId).add(passengerId);
      
      // Send match notifications via WebSocket if connections exist
      this.notifyMatchCreated(matchId, driverId, passengerId);
      
      console.log(`✅ GlobalLocationService: Match ${matchId} session created`);
      
      return {
        success: true,
        matchId,
        driverId,
        passengerId,
        sessionId,
        message: 'Match handled by GlobalLocationService'
      };
      
    } catch (error) {
      console.error('❌ Error handling match created:', error);
      return {
        success: false,
        error: error.message,
        matchId: matchData.matchId
      };
    }
  }

  // Handle match acceptance
  handleMatchAccepted(matchData) {
    try {
      console.log(`📍 GlobalLocationService: Handling match accepted: ${matchData.matchId}`);
      
      const { matchId, driverId, passengerId } = matchData;
      
      // Update connections
      const now = Date.now();
      
      if (this.userConnections.has(driverId)) {
        this.userConnections.get(driverId).matchStatus = 'accepted';
        this.userConnections.get(driverId).matchAcceptedAt = now;
      }
      
      if (this.userConnections.has(passengerId)) {
        this.userConnections.get(passengerId).matchStatus = 'accepted';
        this.userConnections.get(passengerId).matchAcceptedAt = now;
      }
      
      // Notify both users
      this.notifyMatchAccepted(matchId, driverId, passengerId);
      
      return {
        success: true,
        matchId,
        status: 'accepted',
        message: 'Match acceptance handled'
      };
    } catch (error) {
      console.error('❌ Error handling match accepted:', error);
      return { success: false, error: error.message };
    }
  }

  // Handle match cancellation
  handleMatchCancelled(matchData) {
    try {
      console.log(`📍 GlobalLocationService: Handling match cancelled: ${matchData.matchId}`);
      
      const { matchId, driverId, passengerId } = matchData;
      
      // Clear match data from connections
      if (this.userConnections.has(driverId)) {
        const driverConn = this.userConnections.get(driverId);
        driverConn.inMatch = false;
        driverConn.currentMatch = null;
        driverConn.matchPartner = null;
        driverConn.matchStatus = null;
      }
      
      if (this.userConnections.has(passengerId)) {
        const passengerConn = this.userConnections.get(passengerId);
        passengerConn.inMatch = false;
        passengerConn.currentMatch = null;
        passengerConn.matchPartner = null;
        passengerConn.matchStatus = null;
      }
      
      // Clean up session subscriptions
      const sessionId = `match_${matchId}`;
      if (this.sessionSubscriptions.has(sessionId)) {
        this.sessionSubscriptions.delete(sessionId);
      }
      
      // Notify both users
      this.notifyMatchCancelled(matchId, driverId, passengerId);
      
      return {
        success: true,
        matchId,
        message: 'Match cancellation handled'
      };
    } catch (error) {
      console.error('❌ Error handling match cancelled:', error);
      return { success: false, error: error.message };
    }
  }

  // ==================== NOTIFICATION METHODS ====================

  // Notify users about match creation
  notifyMatchCreated(matchId, driverId, passengerId) {
    try {
      // Notify driver
      if (this.connections.has(driverId)) {
        const driverWs = this.connections.get(driverId);
        if (driverWs && driverWs.readyState === 1) { // WebSocket.OPEN
          driverWs.send(JSON.stringify({
            type: 'GLOBAL_LOCATION_MATCH_CREATED',
            data: {
              matchId,
              partnerId: passengerId,
              role: 'driver',
              timestamp: Date.now(),
              service: 'global-location',
              message: 'Match created - location sharing enabled'
            }
          }));
        }
      }
      
      // Notify passenger
      if (this.connections.has(passengerId)) {
        const passengerWs = this.connections.get(passengerId);
        if (passengerWs && passengerWs.readyState === 1) { // WebSocket.OPEN
          passengerWs.send(JSON.stringify({
            type: 'GLOBAL_LOCATION_MATCH_CREATED',
            data: {
              matchId,
              partnerId: driverId,
              role: 'passenger',
              timestamp: Date.now(),
              service: 'global-location',
              message: 'Match created - location sharing enabled'
            }
          }));
        }
      }
      
      console.log(`📤 GlobalLocationService: Match ${matchId} notifications sent`);
    } catch (error) {
      console.error('❌ Error notifying match created:', error);
    }
  }

  // Notify users about match acceptance
  notifyMatchAccepted(matchId, driverId, passengerId) {
    try {
      // Notify driver
      if (this.connections.has(driverId)) {
        const driverWs = this.connections.get(driverId);
        if (driverWs && driverWs.readyState === 1) {
          driverWs.send(JSON.stringify({
            type: 'GLOBAL_LOCATION_MATCH_ACCEPTED',
            data: {
              matchId,
              partnerId: passengerId,
              timestamp: Date.now(),
              service: 'global-location',
              message: 'Match accepted - location sharing active'
            }
          }));
        }
      }
      
      // Notify passenger
      if (this.connections.has(passengerId)) {
        const passengerWs = this.connections.get(passengerId);
        if (passengerWs && passengerWs.readyState === 1) {
          passengerWs.send(JSON.stringify({
            type: 'GLOBAL_LOCATION_MATCH_ACCEPTED',
            data: {
              matchId,
              partnerId: driverId,
              timestamp: Date.now(),
              service: 'global-location',
              message: 'Match accepted - location sharing active'
            }
          }));
        }
      }
    } catch (error) {
      console.error('❌ Error notifying match accepted:', error);
    }
  }

  // Notify users about match cancellation
  notifyMatchCancelled(matchId, driverId, passengerId) {
    try {
      // Notify driver
      if (this.connections.has(driverId)) {
        const driverWs = this.connections.get(driverId);
        if (driverWs && driverWs.readyState === 1) {
          driverWs.send(JSON.stringify({
            type: 'GLOBAL_LOCATION_MATCH_CANCELLED',
            data: {
              matchId,
              timestamp: Date.now(),
              service: 'global-location',
              message: 'Match cancelled - location sharing disabled'
            }
          }));
        }
      }
      
      // Notify passenger
      if (this.connections.has(passengerId)) {
        const passengerWs = this.connections.get(passengerId);
        if (passengerWs && passengerWs.readyState === 1) {
          passengerWs.send(JSON.stringify({
            type: 'GLOBAL_LOCATION_MATCH_CANCELLED',
            data: {
              matchId,
              timestamp: Date.now(),
              service: 'global-location',
              message: 'Match cancelled - location sharing disabled'
            }
          }));
        }
      }
    } catch (error) {
      console.error('❌ Error notifying match cancelled:', error);
    }
  }

  // ==================== CONNECTION MANAGEMENT ====================

  // Add a connection (compatible with WebSocketServer)
  addConnection(userId, ws, role, userDetails = {}) {
    try {
      const connectionData = {
        ws,
        userId,
        role,
        userDetails,
        connectedAt: Date.now(),
        lastActivity: Date.now(),
        status: 'active',
        inMatch: false,
        currentMatch: null,
        matchPartner: null,
        matchStatus: null
      };

      // Store in both maps for compatibility
      this.connections.set(userId, ws);
      this.userConnections.set(userId, connectionData);

      console.log(`✅ GlobalLocationService: Added connection for ${userId} (${role})`);
      
      // Send welcome message
      if (ws && ws.readyState === 1) { // WebSocket.OPEN
        ws.send(JSON.stringify({
          type: 'GLOBAL_LOCATION_CONNECTED',
          data: {
            userId,
            role,
            timestamp: Date.now(),
            message: 'Connected to GlobalLocationService',
            service: 'global-location',
            version: '1.0.0'
          }
        }));
      }

      return { success: true, message: 'Connection added' };
    } catch (error) {
      console.error('❌ Error adding connection:', error);
      return { success: false, error: error.message };
    }
  }

  // Remove a connection
  removeConnection(userId) {
    try {
      const removedConn = this.connections.delete(userId);
      const removedUser = this.userConnections.delete(userId);
      this.subscribers.delete(userId);
      this.subscriberActivity.delete(userId);

      // Remove from all session subscriptions
      this.sessionSubscriptions.forEach((subscribers, sessionId) => {
        if (subscribers.has(userId)) {
          subscribers.delete(userId);
          if (subscribers.size === 0) {
            this.sessionSubscriptions.delete(sessionId);
          }
        }
      });

      console.log(`✅ GlobalLocationService: Removed connection for ${userId}`);
      return { success: true, removed: removedConn || removedUser };
    } catch (error) {
      console.error('❌ Error removing connection:', error);
      return { success: false, error: error.message };
    }
  }

  // Update connection activity
  updateConnectionActivity(userId) {
    try {
      const now = Date.now();
      this.subscriberActivity.set(userId, now);
      
      if (this.userConnections.has(userId)) {
        const connection = this.userConnections.get(userId);
        connection.lastActivity = now;
        connection.status = 'active';
      }
      
      return { success: true, message: 'Activity updated' };
    } catch (error) {
      console.error('❌ Error updating connection activity:', error);
      return { success: false, error: error.message };
    }
  }

  // ==================== LOCATION PROCESSING ====================

  // Process location updates
  processLocationUpdate(message) {
    try {
      const { userId, userType, data } = message;
      
      if (!userId || !data || !data.location) {
        console.error('❌ Invalid location update data');
        return { success: false, error: 'Invalid data' };
      }

      // Create location object
      const locationData = {
        userId,
        userType: userType || 'unknown',
        location: {
          latitude: data.location.latitude || data.location.lat,
          longitude: data.location.longitude || data.location.lng,
          accuracy: data.location.accuracy || 0,
          timestamp: Date.now()
        },
        tripInfo: data.tripInfo || null,
        metadata: {
          updatedAt: new Date().toISOString(),
          source: 'global-location-service',
          isSearching: data.isSearching || false
        }
      };

      // Update global location
      this.globalLocation = locationData;
      
      // Add to history
      this.locationHistory.unshift(locationData);
      if (this.locationHistory.length > this.MAX_HISTORY) {
        this.locationHistory = this.locationHistory.slice(0, this.MAX_HISTORY);
      }

      // Update user connection
      this.updateUserConnection(userId, {
        lastUpdate: Date.now(),
        userType: userType || 'unknown',
        location: locationData.location,
        isSearching: data.isSearching || false
      });

      // Notify subscribers
      this.notifySubscribers(locationData);

      // If user is in a match, forward location to match partner
      this.forwardLocationToMatchPartner(userId, locationData);

      console.log(`📍 Global location updated for ${userId} (${userType})`);
      
      return {
        success: true,
        message: 'Location updated',
        location: locationData,
        subscribersNotified: this.subscribers.size
      };

    } catch (error) {
      console.error('❌ Error processing location update:', error);
      return { success: false, error: error.message };
    }
  }

  // Forward location to match partner
  forwardLocationToMatchPartner(userId, locationData) {
    try {
      if (!this.userConnections.has(userId)) return;
      
      const userConn = this.userConnections.get(userId);
      if (!userConn.inMatch || !userConn.matchPartner) return;
      
      const partnerId = userConn.matchPartner;
      const matchId = userConn.currentMatch;
      
      if (!this.connections.has(partnerId)) return;
      
      const partnerWs = this.connections.get(partnerId);
      if (partnerWs && partnerWs.readyState === 1) {
        partnerWs.send(JSON.stringify({
          type: 'GLOBAL_LOCATION_PARTNER_UPDATE',
          data: {
            matchId,
            fromUserId: userId,
            location: locationData.location,
            timestamp: locationData.location.timestamp,
            service: 'global-location',
            message: 'Partner location update'
          }
        }));
      }
    } catch (error) {
      console.error('❌ Error forwarding location to match partner:', error);
    }
  }

  // Update user connection
  updateUserConnection(userId, data = {}) {
    try {
      const now = Date.now();
      const existing = this.userConnections.get(userId) || {};
      
      const updatedConnection = {
        ...existing,
        ...data,
        userId,
        lastUpdated: now,
        lastActivity: now
      };
      
      this.userConnections.set(userId, updatedConnection);
      
      // Also update connections map for compatibility
      if (existing.ws) {
        this.connections.set(userId, existing.ws);
      }
      
      return updatedConnection;
    } catch (error) {
      console.error('❌ Error updating user connection:', error);
      return null;
    }
  }

  // ==================== SUBSCRIPTION MANAGEMENT ====================

  // Subscribe to location updates
  subscribeToLocation(userId, callback) {
    try {
      if (typeof callback !== 'function') {
        return { success: false, error: 'Callback must be a function' };
      }

      this.subscribers.set(userId, callback);
      this.subscriberActivity.set(userId, Date.now());
      
      // Update user connection
      this.updateUserConnection(userId, {
        subscribedAt: Date.now(),
        lastActivity: Date.now(),
        status: 'subscribed'
      });

      console.log(`✅ User ${userId} subscribed to global location updates`);
      
      // Send current location if available
      if (this.globalLocation) {
        setTimeout(() => {
          callback({
            type: 'GLOBAL_LOCATION_UPDATE',
            data: this.globalLocation
          });
        }, 100);
      }

      return { success: true, message: 'Subscribed successfully' };
    } catch (error) {
      console.error('❌ Error subscribing to location:', error);
      return { success: false, error: error.message };
    }
  }

  // Unsubscribe from location updates
  unsubscribeFromLocation(userId) {
    try {
      const removed = this.subscribers.delete(userId);
      this.subscriberActivity.delete(userId);
      
      if (this.userConnections.has(userId)) {
        const connection = this.userConnections.get(userId);
        connection.status = 'unsubscribed';
        connection.unsubscribedAt = Date.now();
      }

      if (removed) {
        console.log(`✅ User ${userId} unsubscribed from global location updates`);
        return { success: true, message: 'Unsubscribed successfully' };
      }
      return { success: false, error: 'User not subscribed' };
    } catch (error) {
      console.error('❌ Error unsubscribing:', error);
      return { success: false, error: error.message };
    }
  }

  // Notify all subscribers
  notifySubscribers(locationData) {
    try {
      const notification = {
        type: 'GLOBAL_LOCATION_UPDATE',
        data: locationData,
        timestamp: Date.now()
      };

      this.subscribers.forEach((callback, userId) => {
        try {
          callback(notification);
          // Update activity timestamp when notification is sent
          this.subscriberActivity.set(userId, Date.now());
          
          if (this.userConnections.has(userId)) {
            const connection = this.userConnections.get(userId);
            connection.lastActivity = Date.now();
            connection.notificationCount = (connection.notificationCount || 0) + 1;
          }
        } catch (error) {
          console.error(`❌ Error notifying subscriber ${userId}:`, error);
          // Remove faulty subscriber
          this.subscribers.delete(userId);
          this.subscriberActivity.delete(userId);
          this.userConnections.delete(userId);
        }
      });
    } catch (error) {
      console.error('❌ Error notifying subscribers:', error);
    }
  }

  // ==================== QUERY METHODS ====================

  // Get current global location
  getGlobalLocation(requestingUserId) {
    try {
      if (!this.globalLocation) {
        return {
          success: false,
          message: 'No global location available'
        };
      }

      // Update activity for requesting user
      if (requestingUserId) {
        this.updateConnectionActivity(requestingUserId);
      }

      // Return location with metadata
      const response = {
        success: true,
        location: {
          ...this.globalLocation.location,
          userId: this.globalLocation.userId,
          userType: this.globalLocation.userType
        },
        history: this.locationHistory.slice(0, 10), // Last 10 locations
        requestedBy: requestingUserId,
        timestamp: Date.now()
      };

      return response;
    } catch (error) {
      console.error('❌ Error getting global location:', error);
      return { success: false, error: error.message };
    }
  }

  // Get nearby users
  getNearbyUsers(message) {
    try {
      const { userId, latitude, longitude, radius = 5000, userType = 'all' } = message;
      
      if (!latitude || !longitude) {
        return { success: false, error: 'Latitude and longitude required' };
      }

      const nearbyUsers = [];
      const center = { lat: parseFloat(latitude), lng: parseFloat(longitude) };

      // Iterate through all user connections
      for (const [id, connection] of this.userConnections.entries()) {
        if (id === userId) continue; // Skip requesting user
        
        // Check user type filter
        if (userType !== 'all' && connection.userType !== userType) {
          continue;
        }

        // Check if user has location
        if (connection.location) {
          const userLocation = connection.location;
          const distance = this.calculateDistance(
            center.lat, center.lng,
            userLocation.latitude || userLocation.lat,
            userLocation.longitude || userLocation.lng
          );

          if (distance <= radius) {
            nearbyUsers.push({
              userId: id,
              userType: connection.userType,
              location: connection.location,
              distance: Math.round(distance),
              lastUpdate: connection.lastUpdate,
              isSearching: connection.isSearching || false,
              inMatch: connection.inMatch || false,
              userDetails: connection.userDetails || {}
            });
          }
        }
      }

      // Update activity
      if (userId) {
        this.updateConnectionActivity(userId);
      }

      return {
        success: true,
        nearbyUsers: nearbyUsers,
        count: nearbyUsers.length,
        center,
        radius,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('❌ Error getting nearby users:', error);
      return { success: false, error: error.message };
    }
  }

  // Get all users
  getAllUsers(message) {
    try {
      const { userId } = message;
      const users = [];

      // Convert userConnections to array
      for (const [id, connection] of this.userConnections.entries()) {
        users.push({
          userId: id,
          userType: connection.userType,
          location: connection.location,
          lastUpdate: connection.lastUpdate,
          status: connection.status,
          isSearching: connection.isSearching || false,
          inMatch: connection.inMatch || false,
          currentMatch: connection.currentMatch,
          matchPartner: connection.matchPartner,
          userDetails: connection.userDetails || {},
          connectedAt: connection.connectedAt,
          lastActivity: connection.lastActivity
        });
      }

      // Update activity
      if (userId) {
        this.updateConnectionActivity(userId);
      }

      return {
        success: true,
        users: users,
        count: users.length,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('❌ Error getting all users:', error);
      return { success: false, error: error.message };
    }
  }

  // Handle heartbeat
  handleHeartbeat(message) {
    try {
      const { userId } = message;
      
      if (userId) {
        this.updateConnectionActivity(userId);
        
        // Check if user exists in connections
        const userExists = this.userConnections.has(userId) || this.connections.has(userId);
        
        return {
          success: true,
          heartbeat: true,
          userId,
          userExists,
          timestamp: Date.now(),
          message: 'Heartbeat received'
        };
      }
      
      return { success: false, error: 'userId required' };
    } catch (error) {
      console.error('❌ Error handling heartbeat:', error);
      return { success: false, error: error.message };
    }
  }

  // ==================== UTILITY METHODS ====================

  // Calculate distance between two points in meters
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth's radius in meters
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  toRad(degrees) {
    return degrees * (Math.PI / 180);
  }

  // ==================== CLEANUP METHODS ====================

  // 🔥 REQUIRED: Cleanup stale connections (called by MatchingService)
  cleanupStaleConnections() {
    try {
      console.log('🧹 GlobalLocationService: Cleaning stale connections...');
      
      const now = Date.now();
      let cleanedCount = 0;
      const staleThreshold = 5 * 60 * 1000; // 5 minutes
      const inactiveThreshold = 10 * 60 * 1000; // 10 minutes for user connections
      
      // Clean stale subscribers
      const staleSubscribers = [];
      
      this.subscriberActivity.forEach((lastActivity, userId) => {
        if (now - lastActivity > staleThreshold) {
          staleSubscribers.push(userId);
        }
      });
      
      // Remove stale subscribers
      staleSubscribers.forEach(userId => {
        this.subscribers.delete(userId);
        this.subscriberActivity.delete(userId);
        cleanedCount++;
        console.log(`🧹 Removed stale subscriber: ${userId}`);
      });
      
      // Clean inactive user connections
      const inactiveUsers = [];
      
      this.userConnections.forEach((connection, userId) => {
        const lastActivity = connection.lastActivity || connection.lastUpdated || 0;
        if (now - lastActivity > inactiveThreshold) {
          inactiveUsers.push(userId);
        }
      });
      
      // Remove inactive user connections
      inactiveUsers.forEach(userId => {
        this.userConnections.delete(userId);
        this.connections.delete(userId);
        cleanedCount++;
        console.log(`🧹 Removed inactive user connection: ${userId}`);
      });
      
      // Clean up empty session subscriptions
      const emptySessions = [];
      this.sessionSubscriptions.forEach((subscribers, sessionId) => {
        if (subscribers.size === 0) {
          emptySessions.push(sessionId);
        }
      });
      
      emptySessions.forEach(sessionId => {
        this.sessionSubscriptions.delete(sessionId);
        console.log(`🧹 Removed empty session: ${sessionId}`);
      });
      
      if (cleanedCount > 0) {
        console.log(`✅ GlobalLocationService: Cleaned ${cleanedCount} stale connections`);
      } else {
        console.log(`📍 GlobalLocationService: No stale connections (${this.userConnections.size} active users)`);
      }
      
      return cleanedCount;
      
    } catch (error) {
      console.error('❌ Error in GlobalLocationService cleanup:', error);
      return 0;
    }
  }

  // Start cleanup service
  startCleanupService(intervalMinutes = 5) {
    try {
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
      }
      
      const intervalMs = intervalMinutes * 60 * 1000;
      this.cleanupInterval = setInterval(() => {
        this.cleanupStaleConnections();
      }, intervalMs);
      
      console.log(`🔧 GlobalLocationService: Cleanup service started (${intervalMinutes} min interval)`);
      return { success: true, message: 'Cleanup service started' };
    } catch (error) {
      console.error('❌ Error starting cleanup service:', error);
      return { success: false, error: error.message };
    }
  }

  // Stop cleanup service
  stopCleanupService() {
    try {
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
        console.log('🔧 GlobalLocationService: Cleanup service stopped');
      }
      return { success: true, message: 'Cleanup service stopped' };
    } catch (error) {
      console.error('❌ Error stopping cleanup service:', error);
      return { success: false, error: error.message };
    }
  }

  // ==================== STATS & INFO ====================

  // Get all subscribers
  getSubscribers() {
    return Array.from(this.subscribers.keys());
  }

  // Get active connections
  getActiveConnections() {
    const connections = [];
    this.userConnections.forEach((connection, userId) => {
      connections.push({
        userId,
        ...connection
      });
    });
    return connections;
  }

  // Get connection stats
  getConnectionStats() {
    const now = Date.now();
    const fiveMinutesAgo = now - (5 * 60 * 1000);
    const tenMinutesAgo = now - (10 * 60 * 1000);
    
    let activeSubscribers = 0;
    let activeConnections = 0;
    let activeMatches = 0;
    
    // Count active subscribers (activity in last 5 minutes)
    this.subscriberActivity.forEach((lastActivity) => {
      if (now - lastActivity <= fiveMinutesAgo) {
        activeSubscribers++;
      }
    });
    
    // Count active connections (activity in last 10 minutes)
    this.userConnections.forEach((connection) => {
      const lastActivity = connection.lastActivity || connection.lastUpdated || 0;
      if (now - lastActivity <= tenMinutesAgo) {
        activeConnections++;
      }
      if (connection.inMatch) {
        activeMatches++;
      }
    });
    
    return {
      totalSubscribers: this.subscribers.size,
      activeSubscribers,
      totalConnections: this.userConnections.size,
      activeConnections,
      activeMatches,
      globalLocationAvailable: !!this.globalLocation,
      locationHistoryCount: this.locationHistory.length,
      sessionCount: this.sessionSubscriptions.size,
      lastCleanup: this.lastCleanup || null
    };
  }

  // Get service stats
  getStats() {
    const connectionStats = this.getConnectionStats();
    
    return {
      service: 'GlobalLocationService',
      status: 'active',
      ...connectionStats,
      cleanupServiceRunning: !!this.cleanupInterval,
      lastGlobalUpdate: this.globalLocation?.metadata?.updatedAt || null,
      uptime: Date.now() - this.startTime,
      features: [
        'location-tracking',
        'user-subscriptions',
        'nearby-users',
        'connection-management',
        'match-handling',
        'location-forwarding'
      ],
      version: '1.0.0'
    };
  }

  // Clear all data (for testing/reset)
  clearAll() {
    try {
      this.globalLocation = null;
      this.locationHistory = [];
      this.userConnections.clear();
      this.connections.clear();
      this.subscribers.clear();
      this.subscriberActivity.clear();
      this.sessionSubscriptions.clear();
      
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }
      
      console.log('📍 GlobalLocationService data cleared');
      return { success: true, message: 'All data cleared' };
    } catch (error) {
      console.error('❌ Error clearing data:', error);
      return { success: false, error: error.message };
    }
  }

  // ==================== SERVICE LIFECYCLE ====================

  // Start the service
  start() {
    try {
      console.log('🚀 Starting GlobalLocationService...');
      this.startTime = Date.now();
      
      // Start cleanup service
      this.startCleanupService(5); // Cleanup every 5 minutes
      
      console.log('✅ GlobalLocationService started with all required methods');
      return { 
        success: true, 
        message: 'Service started with match handling capabilities',
        features: {
          locationTracking: true,
          userSubscriptions: true,
          nearbyUsers: true,
          cleanupService: true,
          matchHandling: true,
          locationForwarding: true
        }
      };
    } catch (error) {
      console.error('❌ Error starting GlobalLocationService:', error);
      return { success: false, error: error.message };
    }
  }

  // Stop the service
  stop() {
    try {
      console.log('🛑 Stopping GlobalLocationService...');
      
      // Stop cleanup service
      this.stopCleanupService();
      
      // Clear all data
      this.clearAll();
      
      console.log('✅ GlobalLocationService stopped');
      return { success: true, message: 'Service stopped' };
    } catch (error) {
      console.error('❌ Error stopping GlobalLocationService:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = GlobalLocationService;
