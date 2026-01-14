const { TIMEOUTS } = require('../config/constants');

class RealtimeLocationService {
  constructor(firestoreService, matchingService, websocketServer, admin) {
    // Check what properties firestoreService has
    console.log('📍 RealtimeLocationService constructor - firestoreService:', {
      hasFirestore: !!firestoreService?.firestore,
      hasDb: !!firestoreService?.db,
      keys: firestoreService ? Object.keys(firestoreService) : []
    });
    
    this.firestoreService = firestoreService;
    this.matchingService = matchingService;
    this.websocketServer = websocketServer;
    this.admin = admin;
    
    // Memory storage instead of Firestore (PRIMARY STORAGE)
    this.memorySessions = new Map(); // sessionId -> session data
    this.memoryLocations = new Map(); // sessionId -> {driverLocations: [], passengerLocations: []}
    this.userSessions = new Map(); // userId -> [sessionIds] for quick lookup
    
    // Determine which property to use for Firestore (fallback only)
    if (this.firestoreService) {
      if (this.firestoreService.db) {
        this.db = this.firestoreService.db;
        console.log('✅ Firestore available (fallback use only)');
      } else if (this.firestoreService.firestore) {
        this.db = this.firestoreService.firestore;
        console.log('✅ Firestore available (fallback use only)');
      } else {
        // If firestoreService is actually the Firestore instance
        if (typeof firestoreService.collection === 'function') {
          this.db = firestoreService;
          console.log('✅ Firestore available (fallback use only)');
        }
      }
    }
    
    // Fallback to admin.firestore() if available
    if (!this.db && admin && admin.firestore) {
      this.db = admin.firestore();
      console.log('✅ Firestore available (fallback use only)');
    }
    
    if (!this.db) {
      console.log('⚠️ No Firestore database available - running in MEMORY-ONLY mode');
    }
    
    console.log('📍 RealtimeLocationService initialized with MEMORY-FIRST approach');
  }
  
  // Helper to get Firestore instance (for fallback)
  getFirestore() {
    if (!this.db) {
      throw new Error('Firestore database not available - running in memory-only mode');
    }
    return this.db;
  }
  
  // ==================== ADDED METHOD: STOP LOCATION SHARING ====================
  
  async stopLocationSharing(sessionId, userId, userType) {
    try {
      console.log(`🛑 STOP LOCATION SHARING called: session=${sessionId}, user=${userId}, type=${userType}`);
      
      // Option 1: Try to find session by sessionId
      let session = this.memorySessions.get(sessionId);
      
      // Option 2: If sessionId not found, try to find by userId
      if (!session && userId) {
        const userSessionIds = this.userSessions.get(userId) || [];
        for (const sid of userSessionIds) {
          const potentialSession = this.memorySessions.get(sid);
          if (potentialSession && potentialSession.active) {
            session = potentialSession;
            sessionId = sid; // Update sessionId to the found one
            break;
          }
        }
      }
      
      if (!session) {
        console.log(`ℹ️ No active session found for ${sessionId || 'unknown session'}`);
        return { success: false, error: 'Session not found' };
      }
      
      console.log(`🛑 Stopping memory location sharing session ${sessionId}`);
      
      // Mark session as inactive in memory
      session.active = false;
      session.endedAt = Date.now();
      session.stoppedBy = userId;
      session.stoppedReason = userType ? `${userType}_cancelled` : 'manual_stop';
      
      // Optional: Save final locations to Firestore before cleanup
      if (this.db) {
        await this.saveSessionToFirestore(sessionId);
      }
      
      // Notify both users
      this.notifyLocationSharingStopped(session.driverId, session.passengerId, sessionId, 'cancelled_by_user');
      
      // Clean up from memory (with delay)
      setTimeout(() => {
        this.cleanupSessionFromMemory(sessionId);
      }, 3000); // Keep in memory for 3 seconds after stopping
      
      console.log(`✅ Memory location sharing session ${sessionId} stopped by ${userType || 'system'}`);
      
      return { success: true, sessionId, message: 'Location sharing stopped' };
      
    } catch (error) {
      console.error('❌ Error in stopLocationSharing:', error);
      return { success: false, error: error.message };
    }
  }
  
  // ==================== EXISTING METHODS (UPDATED) ====================
  
  // Start real-time location sharing for a match with MEMORY-FIRST approach
  async startRealtimeLocationSharing(matchId, driverId, passengerId, passengerField) {
    console.log(`📍 Starting MEMORY-ONLY location sharing for match ${matchId}`);
    
    try {
      const sessionId = `loc_${matchId}`;
      const duration = TIMEOUTS?.LOCATION_SHARING_DURATION || (15 * 60 * 1000); // 15 minutes default
      
      // 1. Store in memory (PRIMARY STORAGE)
      const sessionData = {
        matchId,
        driverId,
        passengerId,
        passengerField,
        startedAt: Date.now(),
        expiresAt: Date.now() + duration,
        active: true,
        memoryStored: true // Flag to indicate memory storage
      };
      
      this.memorySessions.set(sessionId, sessionData);
      
      // Initialize memory location storage
      this.memoryLocations.set(sessionId, {
        driverLocations: [],
        passengerLocations: [],
        maxLocations: 100, // Keep last 100 locations in memory
        lastDriverUpdate: null,
        lastPassengerUpdate: null
      });
      
      // Update user sessions index for quick lookup
      this.updateUserSessionsIndex(driverId, sessionId, 'driver');
      this.updateUserSessionsIndex(passengerId, sessionId, 'passenger');
      
      // 2. Only store minimal session metadata in Firestore (optional - for persistence)
      if (this.db) {
        const firestoreSessionData = {
          matchId,
          driverId,
          passengerId,
          passengerField,
          startedAt: this.admin?.firestore?.FieldValue?.serverTimestamp() || new Date(),
          expiresAt: new Date(Date.now() + duration),
          status: 'active',
          memoryBased: true, // Indicate this uses memory storage
          lastUpdated: this.admin?.firestore?.FieldValue?.serverTimestamp() || new Date(),
          durationMinutes: 15
        };
        
        await this.db
          .collection('location_sessions')
          .doc(sessionId)
          .set(firestoreSessionData, { merge: true });
        
        console.log(`✅ Minimal session metadata stored in Firestore for ${sessionId}`);
      }
      
      console.log(`✅ Location sharing session ${sessionId} started (MEMORY ONLY)`);
      
      // 3. Schedule memory cleanup
      setTimeout(() => {
        this.stopRealtimeLocationSharing(sessionId);
      }, duration);
      
      // 4. Notify users via WebSocket
      this.notifyLocationSharingStarted(driverId, passengerId, sessionId);
      
      return sessionId;
      
    } catch (error) {
      console.error('❌ Error starting memory location sharing:', error);
      return null;
    }
  }
  
  // Update user sessions index for quick lookup
  updateUserSessionsIndex(userId, sessionId, userType) {
    if (!this.userSessions.has(userId)) {
      this.userSessions.set(userId, []);
    }
    
    const userSessionList = this.userSessions.get(userId);
    // Add session if not already present
    if (!userSessionList.includes(sessionId)) {
      userSessionList.push(sessionId);
    }
    
    // Also update the session data with user type
    const session = this.memorySessions.get(sessionId);
    if (session) {
      session[`${userType}Active`] = true;
    }
  }
  
  // Notify users that location sharing has started
  notifyLocationSharingStarted(driverId, passengerId, sessionId) {
    try {
      if (this.websocketServer) {
        const message = {
          type: 'LOCATION_SHARING_STARTED',
          sessionId,
          message: 'Real-time location sharing is now active',
          durationMinutes: 15,
          storageType: 'memory',
          serverTimestamp: Date.now()
        };
        
        // Send to driver
        if (typeof this.websocketServer.sendToUser === 'function') {
          this.websocketServer.sendToUser(driverId, { ...message, forUser: 'driver' });
          this.websocketServer.sendToUser(passengerId, { ...message, forUser: 'passenger' });
        } else if (typeof this.websocketServer.send === 'function') {
          // Alternative method
          this.websocketServer.send(driverId, JSON.stringify({ ...message, forUser: 'driver' }));
          this.websocketServer.send(passengerId, JSON.stringify({ ...message, forUser: 'passenger' }));
        }
        
        console.log(`📡 Memory location sharing notifications sent for session ${sessionId}`);
      }
    } catch (error) {
      console.error('❌ Error notifying users about location sharing:', error);
    }
  }
  
  // Update location - MEMORY ONLY
  async updateLocation(userId, locationData, userType) {
    try {
      const { latitude, longitude, accuracy, speed, heading, timestamp } = locationData;
      
      // 1. Find active sessions for this user (using memory index)
      const userSessionIds = this.userSessions.get(userId) || [];
      const activeSessions = [];
      
      for (const sessionId of userSessionIds) {
        const session = this.memorySessions.get(sessionId);
        if (session && session.active) {
          // Check if user is driver or passenger in this session
          const isDriver = session.driverId === userId;
          const isPassenger = session.passengerId === userId;
          
          if ((userType === 'driver' && isDriver) || (userType === 'passenger' && isPassenger)) {
            activeSessions.push([sessionId, session]);
          }
        }
      }
      
      if (activeSessions.length === 0) {
        console.log(`⚠️ No active memory sessions for ${userType} ${userId}`);
        return false;
      }
      
      const locationUpdate = {
        userId,
        userType,
        location: {
          lat: latitude,
          lng: longitude,
          accuracy: accuracy || 0,
          speed: speed || 0,
          heading: heading || 0
        },
        timestamp: timestamp || Date.now(),
        serverTimestamp: Date.now()
      };
      
      // 2. Store in memory for each session
      for (const [sessionId, session] of activeSessions) {
        const otherUserId = userType === 'driver' ? session.passengerId : session.driverId;
        const otherUserType = userType === 'driver' ? 'passenger' : 'driver';
        
        // Get session location storage
        const sessionLocations = this.memoryLocations.get(sessionId);
        if (!sessionLocations) continue;
        
        // Store location in memory array
        if (userType === 'driver') {
          sessionLocations.driverLocations.push(locationUpdate);
          sessionLocations.lastDriverUpdate = Date.now();
          
          // Keep only last maxLocations
          if (sessionLocations.driverLocations.length > sessionLocations.maxLocations) {
            sessionLocations.driverLocations.shift();
          }
        } else {
          sessionLocations.passengerLocations.push(locationUpdate);
          sessionLocations.lastPassengerUpdate = Date.now();
          
          if (sessionLocations.passengerLocations.length > sessionLocations.maxLocations) {
            sessionLocations.passengerLocations.shift();
          }
        }
        
        console.log(`📍 Memory location stored for ${userType} ${userId} in session ${sessionId}`);
        
        // 3. Send WebSocket notification to the other user
        await this.notifyLocationUpdate(otherUserId, locationUpdate, userType, sessionId);
        
        // 4. Optional: Periodic sync to Firestore (every 10th update or every 30 seconds)
        const locations = userType === 'driver' 
          ? sessionLocations.driverLocations 
          : sessionLocations.passengerLocations;
        
        if (locations.length % 10 === 0 || Date.now() - session.startedAt > 30000) {
          await this.syncLatestToFirestore(sessionId, userType, locationUpdate);
        }
      }
      
      return true;
      
    } catch (error) {
      console.error('❌ Error updating memory location:', error);
      return false;
    }
  }
  
  // Enhanced notifyLocationUpdate
  async notifyLocationUpdate(userId, locationUpdate, fromUserType, sessionId) {
    try {
      if (this.websocketServer) {
        const message = {
          type: 'LOCATION_UPDATE_MEMORY',
          fromUserType: fromUserType,
          sessionId: sessionId,
          location: locationUpdate.location,
          timestamp: locationUpdate.timestamp,
          accuracy: locationUpdate.location.accuracy,
          speed: locationUpdate.location.speed,
          heading: locationUpdate.location.heading,
          storageType: 'memory',
          serverTimestamp: Date.now()
        };
        
        if (typeof this.websocketServer.sendToUser === 'function') {
          this.websocketServer.sendToUser(userId, message);
        } else if (typeof this.websocketServer.send === 'function') {
          this.websocketServer.send(userId, JSON.stringify(message));
        }
        
        console.log(`📡 Memory location update sent to ${userId}`);
      }
    } catch (error) {
      console.error('❌ Error sending memory location notification:', error);
    }
  }
  
  // Optional: Sync latest location to Firestore periodically
  async syncLatestToFirestore(sessionId, userType, locationUpdate) {
    if (!this.db) return;
    
    try {
      const syncData = {
        [`lastLocation_${userType}`]: {
          ...locationUpdate,
          syncedAt: this.admin?.firestore?.FieldValue?.serverTimestamp() || new Date()
        },
        [`${userType}LastSync`]: this.admin?.firestore?.FieldValue?.serverTimestamp() || new Date(),
        lastUpdated: this.admin?.firestore?.FieldValue?.serverTimestamp() || new Date()
      };
      
      await this.db
        .collection('location_sessions')
        .doc(sessionId)
        .update(syncData);
      
      console.log(`🔄 Synced ${userType} location to Firestore for session ${sessionId}`);
    } catch (error) {
      console.error(`❌ Error syncing to Firestore:`, error.message);
    }
  }
  
  // Stop location sharing - Clean up memory (for timeout/expiry)
  async stopRealtimeLocationSharing(sessionId) {
    try {
      const session = this.memorySessions.get(sessionId);
      if (!session) {
        console.log(`ℹ️ Session ${sessionId} not found in memory`);
        return;
      }
      
      console.log(`🛑 Stopping memory location sharing session ${sessionId} (timeout/expiry)`);
      
      // 1. Mark session as inactive in memory
      session.active = false;
      session.endedAt = Date.now();
      session.stoppedReason = 'timeout_expired';
      
      // 2. Optional: Save final locations to Firestore before cleanup
      if (this.db) {
        await this.saveSessionToFirestore(sessionId);
      }
      
      // 3. Notify users
      this.notifyLocationSharingStopped(session.driverId, session.passengerId, sessionId, 'timeout_expired');
      
      // 4. Schedule memory cleanup (after notification)
      setTimeout(() => {
        this.cleanupSessionFromMemory(sessionId);
      }, 5000); // Keep in memory for 5 seconds after ending
      
      console.log(`✅ Memory location sharing session ${sessionId} stopped (timeout)`);
      
    } catch (error) {
      console.error('❌ Error stopping memory location sharing:', error);
    }
  }
  
  // Optional: Save session data to Firestore when ending
  async saveSessionToFirestore(sessionId) {
    try {
      const session = this.memorySessions.get(sessionId);
      const locations = this.memoryLocations.get(sessionId);
      
      if (!session || !locations) return;
      
      const sessionSummary = {
        matchId: session.matchId,
        driverId: session.driverId,
        passengerId: session.passengerId,
        passengerField: session.passengerField,
        startedAt: new Date(session.startedAt),
        endedAt: new Date(session.endedAt || Date.now()),
        duration: (session.endedAt || Date.now()) - session.startedAt,
        totalDriverLocations: locations.driverLocations.length,
        totalPassengerLocations: locations.passengerLocations.length,
        lastDriverLocation: locations.driverLocations[locations.driverLocations.length - 1] || null,
        lastPassengerLocation: locations.passengerLocations[locations.passengerLocations.length - 1] || null,
        storageType: 'memory',
        summaryGeneratedAt: this.admin?.firestore?.FieldValue?.serverTimestamp() || new Date(),
        durationMinutes: Math.round(((session.endedAt || Date.now()) - session.startedAt) / 60000),
        stoppedReason: session.stoppedReason || 'unknown'
      };
      
      await this.db
        .collection('location_session_summaries')
        .doc(sessionId)
        .set(sessionSummary, { merge: true });
      
      // Also update the main session document
      await this.db
        .collection('location_sessions')
        .doc(sessionId)
        .update({
          status: 'expired',
          endedAt: this.admin?.firestore?.FieldValue?.serverTimestamp() || new Date(),
          expiredReason: session.stoppedReason || 'timeout',
          summarySaved: true
        });
      
      console.log(`📊 Session ${sessionId} summary saved to Firestore`);
      
    } catch (error) {
      console.error('❌ Error saving session to Firestore:', error);
    }
  }
  
  // Clean up from memory
  cleanupSessionFromMemory(sessionId) {
    const session = this.memorySessions.get(sessionId);
    if (session) {
      // Remove from user sessions index
      this.removeFromUserSessionsIndex(session.driverId, sessionId);
      this.removeFromUserSessionsIndex(session.passengerId, sessionId);
    }
    
    this.memorySessions.delete(sessionId);
    this.memoryLocations.delete(sessionId);
    console.log(`🧹 Session ${sessionId} cleaned from memory`);
  }
  
  // Remove session from user index
  removeFromUserSessionsIndex(userId, sessionId) {
    if (this.userSessions.has(userId)) {
      const userSessionList = this.userSessions.get(userId);
      const index = userSessionList.indexOf(sessionId);
      if (index > -1) {
        userSessionList.splice(index, 1);
      }
      if (userSessionList.length === 0) {
        this.userSessions.delete(userId);
      }
    }
  }
  
  // Notify users that location sharing has stopped
  notifyLocationSharingStopped(driverId, passengerId, sessionId, reason = 'unknown') {
    try {
      if (this.websocketServer) {
        const message = {
          type: 'LOCATION_SHARING_STOPPED',
          sessionId,
          message: 'Real-time location sharing has ended',
          reason: reason,
          storageType: 'memory',
          serverTimestamp: Date.now()
        };
        
        if (typeof this.websocketServer.sendToUser === 'function') {
          this.websocketServer.sendToUser(driverId, message);
          this.websocketServer.sendToUser(passengerId, message);
        }
      }
    } catch (error) {
      console.error('❌ Error notifying users about location sharing stop:', error);
    }
  }
  
  // Get latest location from memory
  getLatestLocation(sessionId, userType) {
    const sessionLocations = this.memoryLocations.get(sessionId);
    if (!sessionLocations) return null;
    
    const locations = userType === 'driver' 
      ? sessionLocations.driverLocations 
      : sessionLocations.passengerLocations;
    
    return locations.length > 0 ? locations[locations.length - 1] : null;
  }
  
  // Get session locations history
  getLocationHistory(sessionId, userType, limit = 50) {
    const sessionLocations = this.memoryLocations.get(sessionId);
    if (!sessionLocations) return [];
    
    const locations = userType === 'driver' 
      ? sessionLocations.driverLocations 
      : sessionLocations.passengerLocations;
    
    return locations.slice(-limit); // Return last N locations
  }
  
  // Get active location session for a user (from memory)
  async getActiveSession(userId, userType) {
    const userSessionIds = this.userSessions.get(userId) || [];
    
    for (const sessionId of userSessionIds) {
      const session = this.memorySessions.get(sessionId);
      if (session && session.active) {
        const isDriver = session.driverId === userId;
        const isPassenger = session.passengerId === userId;
        
        if ((userType === 'driver' && isDriver) || (userType === 'passenger' && isPassenger)) {
          return { sessionId, ...session };
        }
      }
    }
    
    return null;
  }
  
  // Get session by ID
  getSession(sessionId) {
    const session = this.memorySessions.get(sessionId);
    if (!session) return null;
    
    const locations = this.memoryLocations.get(sessionId);
    return {
      sessionId,
      ...session,
      locations: locations ? {
        driverCount: locations.driverLocations.length,
        passengerCount: locations.passengerLocations.length,
        lastDriverUpdate: locations.lastDriverUpdate,
        lastPassengerUpdate: locations.lastPassengerUpdate
      } : null
    };
  }
  
  // Cleanup expired sessions
  async cleanupExpiredSessions() {
    try {
      const now = Date.now();
      const expiredSessions = [];
      
      this.memorySessions.forEach((session, sessionId) => {
        if (session.expiresAt <= now) {
          expiredSessions.push(sessionId);
        }
      });
      
      for (const sessionId of expiredSessions) {
        await this.stopRealtimeLocationSharing(sessionId);
      }
      
      if (expiredSessions.length > 0) {
        console.log(`🧹 Cleaned up ${expiredSessions.length} expired memory location sessions`);
      }
      
    } catch (error) {
      console.error('❌ Error cleaning up memory sessions:', error);
    }
  }
  
  // Get all active sessions (for debugging)
  getAllActiveSessions() {
    const sessions = [];
    this.memorySessions.forEach((session, sessionId) => {
      if (session.active) {
        const locations = this.memoryLocations.get(sessionId);
        sessions.push({ 
          sessionId, 
          ...session,
          driverLocationCount: locations?.driverLocations.length || 0,
          passengerLocationCount: locations?.passengerLocations.length || 0
        });
      }
    });
    return sessions;
  }
  
  // Get service stats
  getStats() {
    return {
      activeSessions: this.memorySessions.size,
      totalUsers: this.userSessions.size,
      memorySessions: Array.from(this.memorySessions.keys()),
      userCounts: Array.from(this.userSessions.entries()).map(([userId, sessions]) => ({
        userId,
        sessionCount: sessions.length
      }))
    };
  }
  
  // Start the service
  start() {
    console.log('📍 Starting Memory-First RealtimeLocationService...');
    // Setup periodic cleanup
    setInterval(() => {
      this.cleanupExpiredSessions();
    }, 5 * 60 * 1000); // Every 5 minutes
    
    // Log stats periodically
    setInterval(() => {
      const stats = this.getStats();
      console.log('📍 Location Service Stats:', {
        activeSessions: stats.activeSessions,
        totalUsers: stats.totalUsers
      });
    }, 60 * 1000); // Every minute
  }
  
  // Stop the service
  stop() {
    console.log('📍 Stopping Memory-First RealtimeLocationService...');
    // Save all active sessions to Firestore before shutdown
    if (this.db) {
      this.memorySessions.forEach((session, sessionId) => {
        if (session.active) {
          this.saveSessionToFirestore(sessionId);
        }
      });
    }
    
    // Clear all memory
    this.memorySessions.clear();
    this.memoryLocations.clear();
    this.userSessions.clear();
  }
}

module.exports = RealtimeLocationService;
