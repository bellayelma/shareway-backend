// WebSocketServer-Scheduled.js - REFACTORED to use NotificationService and FirestoreService methods
// All direct Firestore access replaced with firestoreService methods
// All FCM logic removed - now uses NotificationService for all notifications

const WebSocket = require('ws');
const logger = require('../utils/Logger');

class ScheduledWebSocketServer {
  constructor(server, firestoreService, scheduledMatchingService = null, notificationService = null) {
    this.firestore = firestoreService?.db;
    this.firestoreService = firestoreService;
    this.scheduledMatchingService = scheduledMatchingService;
    this.notificationService = notificationService;
    
    this.connectedUsers = new Map();
    this.userSubscriptions = new Map();
    this.scheduledSearches = new Map();
    this.activeScheduledRides = new Map();
    this.phoneToUidCache = new Map();
    this.uidToPhoneCache = new Map();
    
    this.wss = new WebSocket.Server({ noServer: true, clientTracking: true });
    
    if (server) server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    
    this.setupWebSocket();
    
    // Cleanup intervals
    setInterval(() => this.cleanupStaleConnections(), 300000);
    setInterval(() => this.cleanupExpiredScheduledData(), 3600000);
    
    logger.info('SCHEDULED_WS', '🔌 Scheduled WebSocket Server initialized');
  }

  handleUpgrade(req, socket, head) {
    const { pathname } = require('url').parse(req.url, true);
    if (pathname !== '/ws-scheduled') return socket.destroy();
    
    const allowedOrigins = ['http://localhost:8082', 'http://127.0.0.1:8082', 'http://localhost:3000', null, undefined, 'null'];
    if (process.env.NODE_ENV !== 'production' || allowedOrigins.includes(req.headers.origin)) {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    } else {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
    }
  }

  setupWebSocket() {
    this.wss.on('connection', async (ws, req) => {
      try {
        const { query: { userId, platform = 'flutter_web', role = 'unknown' } } = require('url').parse(req.url, true);
        if (!userId) return ws.close(1008, 'User ID required');
        
        const formattedUserId = this.formatPhoneNumber(decodeURIComponent(userId).replace(/%2B/g, '+'));
        const isPhone = this.isPhoneNumber(formattedUserId);
        
        // Close existing connection if any
        if (this.connectedUsers.has(formattedUserId)) {
          try { this.connectedUsers.get(formattedUserId).ws.close(1000, 'New connection'); } catch (e) {}
          this.connectedUsers.delete(formattedUserId);
        }
        
        // Get user details
        let userDetails = {};
        try { userDetails = await this.getActualUserDetails(formattedUserId, role); } catch (e) {}
        
        // Store connection
        this.connectedUsers.set(formattedUserId, {
          ws, 
          platform, 
          connectedAt: new Date().toISOString(), 
          lastActivity: Date.now(), 
          role,
          isPhone, 
          originalId: userId, 
          formattedId: formattedUserId, 
          userDetails, 
          subscriptions: new Set()
        });
        
        // Send connection confirmation
        try {
          ws.send(JSON.stringify({
            type: 'CONNECTED', 
            data: {
              userId: formattedUserId, 
              userProfile: userDetails, 
              timestamp: Date.now(),
              message: `Connected as ${userDetails.name || role}`, 
              platform, 
              role,
              server: 'localhost:3000', 
              path: '/ws-scheduled', 
              serviceType: 'scheduled_matching_only'
            }
          }));
        } catch (e) { 
          logger.error('SCHEDULED_WS', 'Error sending connection confirmation:', e); 
        }
        
        // Handle Firebase UID mapping
        if (isPhone) {
          try {
            const firebaseUid = await this.lookupFirebaseUidByPhone(formattedUserId);
            if (firebaseUid) {
              this.phoneToUidCache.set(formattedUserId, firebaseUid);
              this.uidToPhoneCache.set(firebaseUid, formattedUserId);
              this.connectedUsers.set(firebaseUid, {
                ws, 
                platform, 
                connectedAt: new Date().toISOString(), 
                lastActivity: Date.now(), 
                role,
                isPhone: false, 
                originalId: firebaseUid, 
                formattedId: formattedUserId, 
                userDetails, 
                isAlias: true, 
                subscriptions: new Set()
              });
            }
          } catch (e) {}
        }
        
        // Send current status
        await this.checkAndSendScheduledStatus(formattedUserId, role);
        
        // Message handler
        ws.on('message', async (data) => this.handleMessage(formattedUserId, data));
        
        // Close handler
        ws.on('close', () => this.handleConnectionClose(formattedUserId, userId));
        
        // Error handler
        ws.on('error', (error) => { 
          this.handleConnectionClose(formattedUserId, userId); 
          logger.error('SCHEDULED_WS', `WebSocket error for ${formattedUserId}:`, error); 
        });
        
        // Ping/pong for connection health
        const pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.ping(); } catch (e) { clearInterval(pingInterval); }
          } else {
            clearInterval(pingInterval);
          }
        }, 30000);
        
        ws.on('pong', () => { 
          const u = this.connectedUsers.get(formattedUserId); 
          if (u) u.lastActivity = Date.now(); 
        });
        
        logger.info('SCHEDULED_WS', `User connected: ${formattedUserId} (${role})`);
      } catch (error) {
        logger.error('SCHEDULED_WS', 'Connection setup error:', error);
        try { ws.close(1011, 'Internal error'); } catch (e) {}
      }
    });
    
    this.wss.on('error', (error) => logger.error('SCHEDULED_WS', 'WebSocket server error:', error));
  }

  async handleMessage(connectionKey, rawData) {
    try {
      const message = JSON.parse(rawData.toString());
      const userInfo = this.connectedUsers.get(connectionKey);
      if (!userInfo) return;
      
      userInfo.lastActivity = Date.now();
      
      // Check if services are available
      if (!this.scheduledMatchingService && !['PING', 'CONNECTED', 'REGISTER_FCM_TOKEN', 'REMOVE_FCM_TOKEN'].includes(message.type)) {
        return this.sendToUser(connectionKey, { 
          type: 'ERROR', 
          data: { message: 'Scheduled matching service unavailable', timestamp: Date.now() } 
        });
      }
      
      // Message handlers
      const handlers = {
        // Basic handlers
        PING: () => this.handlePing(connectionKey, userInfo),
        
        // FCM Token handlers - DELEGATE TO NOTIFICATION SERVICE
        REGISTER_FCM_TOKEN: () => this.handleRegisterFCMToken(connectionKey, message),
        REMOVE_FCM_TOKEN: () => this.handleRemoveFCMToken(connectionKey, message),
        
        // Notification handlers - USE NOTIFICATION SERVICE
        GET_NOTIFICATIONS: () => this.handleGetNotifications(connectionKey, message),
        MARK_NOTIFICATION_READ: () => this.handleMarkNotificationRead(connectionKey, message),
        MARK_ALL_NOTIFICATIONS_READ: () => this.handleMarkAllNotificationsRead(connectionKey, message),
        
        // Scheduled search handlers
        CREATE_SCHEDULED_SEARCH: () => this.handleCreateScheduledSearch(connectionKey, message),
        SCHEDULED_SEARCH_CREATED: () => this.handleFlutterScheduledSearchCreated(connectionKey, message),
        GET_SCHEDULED_STATUS: () => this.handleGetScheduledStatus(connectionKey, message),
        CANCEL_SCHEDULED_SEARCH: () => this.handleCancelScheduledSearch(connectionKey, message),
        UPDATE_SCHEDULED_LOCATION: () => this.handleUpdateScheduledLocation(connectionKey, message),
        
        // Match decision handlers
        ACCEPT_SCHEDULED_MATCH: () => this.handleAcceptScheduledMatch(connectionKey, message),
        DECLINE_SCHEDULED_MATCH: () => this.handleDeclineScheduledMatch(connectionKey, message),
        GET_SCHEDULED_MATCHES: () => this.handleGetScheduledMatches(connectionKey, message),
        SCHEDULED_MATCH_DECISION: () => this.handleScheduledMatchDecision(connectionKey, message),
        
        // Ride management handlers
        CONFIRM_SCHEDULED_RIDE: () => this.handleConfirmScheduledRide(connectionKey, message),
        CANCEL_SCHEDULED_RIDE: () => this.handleCancelScheduledRide(connectionKey, message),
        START_SCHEDULED_RIDE: () => this.handleStartScheduledRide(connectionKey, message),
        COMPLETE_SCHEDULED_RIDE: () => this.handleCompleteScheduledRide(connectionKey, message),
        UPDATE_RIDE_LOCATION: () => this.handleUpdateRideLocation(connectionKey, message),
        GET_RIDE_LOCATION: () => this.handleGetRideLocation(connectionKey, message),
        
        // Driver management handlers
        driver_cancel_all: () => this.handleDriverCancelAll(connectionKey, message),
        driver_cancel_passenger: () => this.handleDriverCancelPassenger(connectionKey, message),
        get_driver_passengers: () => this.handleGetDriverPassengers(connectionKey, message),
        
        // Schedule and stats handlers
        GET_SCHEDULE_CALENDAR: () => this.handleGetScheduleCalendar(connectionKey, message),
        UPDATE_SCHEDULE_PREFERENCES: () => this.handleUpdateSchedulePreferences(connectionKey, message),
        GET_SCHEDULED_STATS: () => this.handleGetScheduledStats(connectionKey, message),
        
        // Test handler
        TEST_SCHEDULED_MATCHING: () => this.handleTestScheduledMatching(connectionKey, message)
      };
      
      const handler = handlers[message.type];
      if (handler) {
        await handler();
      } else {
        this.sendToUser(connectionKey, { 
          type: 'MESSAGE_RECEIVED', 
          data: { originalType: message.type, timestamp: Date.now() } 
        });
      }
    } catch (error) {
      logger.error('SCHEDULED_WS', `Error processing message from ${connectionKey}:`, error);
      try {
        const u = this.connectedUsers.get(connectionKey);
        if (u?.ws.readyState === WebSocket.OPEN) {
          u.ws.send(JSON.stringify({ 
            type: 'ERROR', 
            data: { message: 'Failed to process message', error: error.message, timestamp: Date.now() } 
          }));
        }
      } catch (e) {}
    }
  }

  // ==================== FCM TOKEN HANDLERS - DELEGATE TO NOTIFICATION SERVICE ====================

  async handleRegisterFCMToken(userId, message) {
    try {
      const { token, deviceInfo } = message.data || message;
      if (!token) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'FCM token is required', timestamp: Date.now() } 
        });
      }
      
      if (!this.notificationService) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'Notification service unavailable', timestamp: Date.now() } 
        });
      }
      
      const userInfo = this.connectedUsers.get(userId);
      const userType = userInfo?.role || 'unknown';
      
      // Delegate to NotificationService
      const result = await this.notificationService.registerFCMToken(
        userId, 
        token, 
        deviceInfo || {}, 
        userType
      );
      
      this.sendToUser(userId, { 
        type: 'FCM_TOKEN_REGISTERED', 
        data: { 
          success: result.success, 
          message: result.success ? 'FCM token registered' : result.error,
          timestamp: Date.now() 
        } 
      });
      
      if (result.success) {
        logger.info('FCM_REGISTER', `✅ FCM token registered for ${userId}`);
      }
    } catch (error) {
      logger.error('SCHEDULED_WS', 'Error registering FCM token:', error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to register FCM token', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  async handleRemoveFCMToken(userId, message) {
    try {
      const { token } = message.data || message;
      
      if (!this.notificationService) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'Notification service unavailable', timestamp: Date.now() } 
        });
      }
      
      const result = await this.notificationService.removeFCMToken(userId, token);
      
      this.sendToUser(userId, { 
        type: 'FCM_TOKEN_REMOVED', 
        data: { 
          success: result.success, 
          message: result.success ? 'FCM token removed' : result.error,
          timestamp: Date.now() 
        } 
      });
    } catch (error) {
      logger.error('SCHEDULED_WS', 'Error removing FCM token:', error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to remove FCM token', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  // ==================== NOTIFICATION HANDLERS - DELEGATE TO NOTIFICATION SERVICE ====================

  async handleGetNotifications(userId, message) {
    try {
      const { limit = 50, unreadOnly = false } = message.data || message;
      
      if (!this.notificationService) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'Notification service unavailable', timestamp: Date.now() } 
        });
      }
      
      const result = await this.notificationService.getUserNotifications(userId, limit, unreadOnly);
      
      this.sendToUser(userId, { 
        type: 'NOTIFICATIONS_RESPONSE', 
        data: { 
          success: result.success, 
          notifications: result.notifications || [],
          count: result.notifications?.length || 0,
          unreadCount: result.notifications?.filter(n => !n.read).length || 0,
          timestamp: new Date().toISOString() 
        } 
      });
    } catch (error) {
      logger.error('SCHEDULED_WS', 'Error getting notifications:', error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to get notifications', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  async handleMarkNotificationRead(userId, message) {
    try {
      const { notificationId } = message.data || message;
      if (!notificationId) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'notificationId is required', timestamp: Date.now() } 
        });
      }
      
      if (!this.notificationService) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'Notification service unavailable', timestamp: Date.now() } 
        });
      }
      
      const result = await this.notificationService.markNotificationRead(notificationId);
      
      this.sendToUser(userId, { 
        type: 'NOTIFICATION_MARKED_READ', 
        data: { 
          success: result.success, 
          notificationId,
          timestamp: new Date().toISOString() 
        } 
      });
    } catch (error) {
      logger.error('SCHEDULED_WS', 'Error marking notification as read:', error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to mark notification as read', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  async handleMarkAllNotificationsRead(userId, message) {
    try {
      const notifications = await this.notificationService.getUserNotifications(userId, 100, true);
      
      if (!notifications.success) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'Failed to fetch notifications', timestamp: Date.now() } 
        });
      }
      
      const batch = this.firestore.batch();
      let count = 0;
      
      for (const notif of notifications.notifications) {
        if (!notif.read) {
          batch.update(this.firestore.collection('notifications').doc(notif.id), {
            read: true,
            readAt: new Date().toISOString()
          });
          count++;
        }
      }
      
      if (count > 0) await batch.commit();
      
      this.sendToUser(userId, { 
        type: 'ALL_NOTIFICATIONS_MARKED_READ', 
        data: { 
          success: true, 
          count,
          timestamp: new Date().toISOString() 
        } 
      });
    } catch (error) {
      logger.error('SCHEDULED_WS', 'Error marking all notifications as read:', error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to mark all notifications as read', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  // ==================== SCHEDULED SEARCH HANDLERS ====================

  async handleCreateScheduledSearch(userId, message) {
    try {
      const userInfo = this.connectedUsers.get(userId);
      if (!userInfo) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'User not connected', timestamp: Date.now() } 
        });
      }
      
      const data = message.data || message;
      const userType = data.userType || userInfo.role;
      
      if (!['driver', 'passenger'].includes(userType.toLowerCase())) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'Invalid userType. Must be "driver" or "passenger"', timestamp: Date.now() } 
        });
      }
      
      const nUserId = this.formatPhoneNumber(userId);
      
      // Prepare search data based on user type
      let searchData;
      
      if (userType.toLowerCase() === 'driver') {
        if (!data.capacity) {
          return this.sendToUser(userId, { 
            type: 'ERROR', 
            data: { message: 'capacity is required for driver', timestamp: Date.now() } 
          });
        }
        
        searchData = {
          type: 'CREATE_SCHEDULED_SEARCH',
          userId: nUserId,
          userType: 'driver',
          driverName: data.driverName || data.vehicleInfo?.driverName || 'Driver',
          driverPhone: nUserId,
          vehicleInfo: {
            driverName: data.vehicleInfo?.driverName || data.driverName || 'Driver',
            model: data.vehicleInfo?.model || data.vehicleModel || 'Standard',
            color: data.vehicleInfo?.color || data.vehicleColor || 'Not specified',
            plate: data.vehicleInfo?.plate || data.licensePlate || 'Not specified',
            type: data.vehicleInfo?.type || data.vehicleType || 'Car',
            capacity: data.vehicleInfo?.capacity || data.capacity || 4
          },
          vehicleModel: data.vehicleModel || data.vehicleInfo?.model || 'Standard',
          vehicleColor: data.vehicleColor || data.vehicleInfo?.color || 'Not specified',
          licensePlate: data.licensePlate || data.vehicleInfo?.plate || 'Not specified',
          vehicleType: data.vehicleType || data.vehicleInfo?.type || 'Car',
          capacity: data.capacity || data.vehicleInfo?.capacity || 4,
          availableSeats: data.capacity || data.vehicleInfo?.capacity || 4,
          pickupLocation: data.pickupLocation || data.currentLocation,
          destinationLocation: data.destinationLocation,
          currentLocation: data.currentLocation || data.pickupLocation,
          scheduledTime: data.scheduledTime ? new Date(data.scheduledTime).toISOString() : null,
          scheduledTimestamp: data.scheduledTime ? new Date(data.scheduledTime).getTime() : null,
          departureTime: data.scheduledTime,
          status: 'scheduled',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastUpdated: Date.now(),
          ...data
        };
      } else { // passenger
        const pSrc = data.passenger || data.passengerInfo || {};
        const rSrc = data.rideDetails || {};
        const scheduledTime = data.scheduledTime || rSrc.scheduledTime || data.departureTime;
        const parsedTime = scheduledTime ? new Date(scheduledTime) : null;
        const pPhone = this.formatPhoneNumber(pSrc.phone || pSrc.userId || data.userId || nUserId);
        
        if (!scheduledTime) {
          return this.sendToUser(userId, { 
            type: 'ERROR', 
            data: { message: 'scheduledTime is required for passenger', timestamp: Date.now() } 
          });
        }
        
        searchData = {
          type: 'SCHEDULE_SEARCH',
          userId: pPhone,
          userType: 'passenger',
          passengerInfo: {
            name: pSrc.name || data.passengerName || 'Passenger',
            phone: pPhone,
            photoUrl: pSrc.photoUrl || pSrc.profilePhoto || pSrc.photoURL || data.passengerPhotoUrl || null,
            rating: pSrc.rating || data.rating || 5.0
          },
          passengerName: pSrc.name || data.passengerName || 'Passenger',
          passengerPhone: pPhone,
          passengerPhotoUrl: pSrc.photoUrl || data.passengerPhotoUrl || null,
          passengerCount: data.passengerCount || rSrc.passengerCount || pSrc.passengerCount || 1,
          luggageCount: data.luggageCount || rSrc.luggageCount || pSrc.luggageCount || 0,
          rideDetails: {
            scheduledTime: parsedTime?.toISOString() || null,
            scheduledTimestamp: parsedTime?.getTime() || null,
            pickupLocation: data.pickupLocation || rSrc.pickupLocation,
            destinationLocation: data.destinationLocation || rSrc.destinationLocation,
            pickupName: data.pickupName || rSrc.pickupName || '',
            destinationName: data.destinationName || rSrc.destinationName || '',
            passengerCount: data.passengerCount || rSrc.passengerCount || 1,
            luggageCount: data.luggageCount || rSrc.luggageCount || 0,
            estimatedFare: data.estimatedFare || rSrc.estimatedFare,
            estimatedDistance: data.estimatedDistance || rSrc.estimatedDistance,
            paymentMethod: data.paymentMethod || rSrc.paymentMethod || 'cash',
            specialRequests: data.specialRequests || rSrc.specialRequests || ''
          },
          pickupLocation: data.pickupLocation || rSrc.pickupLocation,
          destinationLocation: data.destinationLocation || rSrc.destinationLocation,
          pickupName: data.pickupName || rSrc.pickupName || '',
          destinationName: data.destinationName || rSrc.destinationName || '',
          scheduledTime: parsedTime?.toISOString() || null,
          scheduledTimestamp: parsedTime?.getTime() || null,
          estimatedFare: data.estimatedFare || rSrc.estimatedFare,
          estimatedDistance: data.estimatedDistance || rSrc.estimatedDistance,
          paymentMethod: data.paymentMethod || rSrc.paymentMethod || 'cash',
          specialRequests: data.specialRequests || rSrc.specialRequests || '',
          status: 'scheduled',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastUpdated: Date.now(),
          ...data
        };
      }
      
      // Delegate to ScheduledService
      const result = await this.scheduledMatchingService.handleCreateScheduledSearch(
        searchData, 
        searchData.userId, 
        searchData.userType
      );
      
      if (result.success) {
        this.sendToUser(userId, { 
          type: 'SCHEDULED_SEARCH_CREATED_RESPONSE', 
          data: { 
            success: true, 
            userId: searchData.userId, 
            userType: searchData.userType, 
            searchId: result.searchId, 
            scheduledTime: searchData.scheduledTime, 
            message: 'Scheduled search created successfully', 
            timestamp: Date.now() 
          } 
        });
        
        logger.info('SCHEDULED_WS', `✅ Scheduled search created for ${searchData.userId} as ${searchData.userType}`);
      } else {
        this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: result.error || 'Failed to create scheduled search', timestamp: Date.now() } 
        });
      }
    } catch (error) {
      logger.error('SCHEDULED_WS', `❌ Error creating scheduled search for ${userId}:`, error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to create scheduled search', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  async handleFlutterScheduledSearchCreated(userId, message) {
    // This is essentially the same as handleCreateScheduledSearch
    // but structured for Flutter's format
    await this.handleCreateScheduledSearch(userId, message);
  }

  // ==================== MATCH DECISION HANDLERS ====================

  async handleAcceptScheduledMatch(userId, message) {
    try {
      const { matchId, userType } = message.data || message;
      if (!matchId) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'matchId is required', timestamp: Date.now() } 
        });
      }
      
      const userInfo = this.connectedUsers.get(userId);
      const actualUserType = userType || userInfo?.role || 'unknown';
      const nPhone = this.formatPhoneNumber(userId);
      
      const result = await this.scheduledMatchingService.handleMatchDecision(
        matchId, 
        nPhone, 
        actualUserType, 
        'accept'
      );
      
      if (result.success) {
        this.sendToUser(userId, { 
          type: 'SCHEDULED_MATCH_ACCEPTED_RESPONSE', 
          data: { 
            success: true, 
            matchId, 
            acceptedBy: userId, 
            userType: actualUserType, 
            status: 'accepted', 
            message: 'Match accepted successfully', 
            timestamp: Date.now() 
          } 
        });
        
        logger.info('SCHEDULED_WS', `✅ Scheduled match ${matchId} accepted by ${userId} (${actualUserType})`);
      } else {
        this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'Failed to accept scheduled match', error: result.error, timestamp: Date.now() } 
        });
      }
    } catch (error) {
      logger.error('SCHEDULED_WS', `❌ Error accepting scheduled match:`, error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to accept scheduled match', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  async handleDeclineScheduledMatch(userId, message) {
    try {
      const { matchId, reason = 'Not specified', userType } = message.data || message;
      if (!matchId) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'matchId is required', timestamp: Date.now() } 
        });
      }
      
      const userInfo = this.connectedUsers.get(userId);
      const actualUserType = userType || userInfo?.role || 'unknown';
      const nPhone = this.formatPhoneNumber(userId);
      
      const result = await this.scheduledMatchingService.handleMatchDecision(
        matchId, 
        nPhone, 
        actualUserType, 
        'reject', 
        reason
      );
      
      if (result.success) {
        this.sendToUser(userId, { 
          type: 'SCHEDULED_MATCH_DECLINED_RESPONSE', 
          data: { 
            success: true, 
            matchId, 
            declinedBy: userId, 
            userType: actualUserType, 
            reason, 
            message: 'Match declined successfully', 
            timestamp: Date.now() 
          } 
        });
        
        logger.info('SCHEDULED_WS', `❌ Scheduled match ${matchId} declined by ${userId}: ${reason}`);
      } else {
        this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'Failed to decline scheduled match', error: result.error, timestamp: Date.now() } 
        });
      }
    } catch (error) {
      logger.error('SCHEDULED_WS', `❌ Error declining scheduled match:`, error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to decline scheduled match', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  handleScheduledMatchDecision(userId, message) {
    const { matchId, decision, reason } = message.data || message;
    if (decision === 'ACCEPTED' || decision === 'accept') {
      return this.handleAcceptScheduledMatch(userId, { data: { matchId } });
    }
    if (decision === 'DECLINED' || decision === 'decline' || decision === 'reject') {
      return this.handleDeclineScheduledMatch(userId, { data: { matchId, reason } });
    }
  }

  async handleGetScheduledMatches(userId, message) {
    try {
      const { status, limit = 20 } = message.data || message;
      const nPhone = this.formatPhoneNumber(userId);
      
      // Build query constraints
      let constraints = [];
      
      if (status) {
        constraints.push({ 
          field: 'status', 
          operator: Array.isArray(status) ? 'in' : '==', 
          value: status 
        });
      }
      
      // Use firestoreService.queryCollection
      const snapshot = await this.firestoreService.queryCollection(
        'scheduled_matches',
        constraints,
        limit
      );
      
      const matches = [];
      snapshot.forEach(d => { 
        const m = d.data(); 
        if (m.driverPhone === nPhone || m.passengerPhone === nPhone) {
          matches.push({ matchId: d.id, ...m });
        }
      });
      
      this.sendToUser(userId, { 
        type: 'SCHEDULED_MATCHES_RESPONSE', 
        data: { 
          success: true, 
          userId, 
          matches, 
          count: matches.length, 
          timestamp: new Date().toISOString() 
        } 
      });
    } catch (error) {
      logger.error('SCHEDULED_WS', `❌ Error getting scheduled matches:`, error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to get scheduled matches', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  // ==================== RIDE MANAGEMENT HANDLERS ====================

  async handleConfirmScheduledRide(userId, message) {
    try {
      const { rideId, confirmationType } = message.data || message;
      if (!rideId) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'rideId is required', timestamp: Date.now() } 
        });
      }
      
      // Use firestoreService.getDocument
      const rideDoc = await this.firestoreService.getDocument('active_scheduled_matches', rideId);
      
      if (!rideDoc.exists) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'Ride not found', timestamp: Date.now() } 
        });
      }
      
      const ride = rideDoc.data();
      const nUserId = this.formatPhoneNumber(userId);
      
      if (ride.driverPhone !== nUserId && ride.passengerPhone !== nUserId) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'Not authorized to confirm this ride', timestamp: Date.now() } 
        });
      }
      
      const userType = nUserId === ride.driverPhone ? 'driver' : 'passenger';
      const now = new Date().toISOString();
      const update = { updatedAt: now };
      
      const confirmMap = {
        pickup_confirmed: 'pickupConfirmedAt',
        passenger_boarded: 'passengerBoardedAt',
        ride_started: 'rideStartedAt',
        arrived_at_destination: 'arrivedAtDestinationAt'
      };
      
      if (confirmMap[confirmationType]) {
        update[confirmMap[confirmationType]] = now;
      } else {
        update.confirmedAt = now;
      }
      
      // Use firestoreService.updateDocument
      await this.firestoreService.updateDocument('active_scheduled_matches', rideId, update);
      
      const other = nUserId === ride.driverPhone ? ride.passengerPhone : ride.driverPhone;
      
      // Send notification via NotificationService
      if (this.notificationService) {
        await this.notificationService.sendNotification(other, {
          type: 'SCHEDULED_RIDE_CONFIRMED_NOTIFICATION',
          data: { 
            rideId, 
            confirmedBy: userId, 
            confirmationType, 
            timestamp: now 
          }
        }, { important: true });
      } else {
        // Fallback to direct WebSocket
        await this.sendToUser(other, { 
          type: 'SCHEDULED_RIDE_CONFIRMED_NOTIFICATION', 
          data: { rideId, confirmedBy: userId, confirmationType, timestamp: now } 
        });
      }
      
      this.sendToUser(userId, { 
        type: 'SCHEDULED_RIDE_CONFIRMED_RESPONSE', 
        data: { success: true, rideId, confirmationType, timestamp: now } 
      });
    } catch (error) {
      logger.error('SCHEDULED_WS', `❌ Error confirming scheduled ride:`, error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to confirm scheduled ride', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  async handleCancelScheduledRide(userId, message) {
    try {
      const { rideId, reason = 'user_cancelled' } = message.data || message;
      if (!rideId) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'rideId is required', timestamp: Date.now() } 
        });
      }
      
      // Use firestoreService.getDocument
      const rideDoc = await this.firestoreService.getDocument('active_scheduled_matches', rideId);
      
      if (!rideDoc.exists) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'Ride not found', timestamp: Date.now() } 
        });
      }
      
      const ride = rideDoc.data();
      const nUserId = this.formatPhoneNumber(userId);
      
      if (ride.driverPhone !== nUserId && ride.passengerPhone !== nUserId) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'Not authorized to cancel this ride', timestamp: Date.now() } 
        });
      }
      
      const userType = nUserId === ride.driverPhone ? 'driver' : 'passenger';
      const now = new Date().toISOString();
      
      // Update ride document
      await this.firestoreService.updateDocument('active_scheduled_matches', rideId, { 
        status: 'cancelled', 
        cancelledAt: now, 
        cancelledBy: userType, 
        cancellationReason: reason, 
        updatedAt: now 
      });
      
      // Move to history
      await this.firestoreService.setDocument('scheduled_ride_history', rideId, {
        ...ride,
        status: 'cancelled',
        cancelledAt: now,
        cancelledBy: userType,
        cancellationReason: reason,
        historyCreatedAt: now
      });
      
      // Delete from active
      await this.firestoreService.deleteDocument('active_scheduled_matches', rideId);
      
      // Update stats
      await this.updateRideStats(ride.driverPhone, ride.passengerPhone, 0, true);
      
      const other = nUserId === ride.driverPhone ? ride.passengerPhone : ride.driverPhone;
      const notification = {
        type: 'SCHEDULED_RIDE_CANCELLED_NOTIFICATION',
        data: { 
          rideId, 
          cancelledBy: userId, 
          reason, 
          timestamp: now,
          message: userType === 'driver' ? 'Your driver has cancelled the ride' : 'Your ride has been cancelled'
        }
      };
      
      // Send notification via NotificationService
      if (this.notificationService) {
        await this.notificationService.sendNotification(other, notification, { important: true });
      } else {
        await this.sendToUser(other, notification);
      }
      
      this.sendToUser(userId, { 
        type: 'SCHEDULED_RIDE_CANCELLED_RESPONSE', 
        data: { success: true, rideId, reason, timestamp: now } 
      });
      
      logger.info('SCHEDULED_RIDE', `❌ Ride ${rideId} cancelled by ${userId}`);
    } catch (error) {
      logger.error('SCHEDULED_WS', `❌ Error cancelling scheduled ride:`, error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to cancel scheduled ride', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  async handleStartScheduledRide(userId, message) {
    try {
      const { rideId } = message.data || message;
      if (!rideId) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'rideId is required', timestamp: Date.now() } 
        });
      }
      
      // Use firestoreService.getDocument
      const rideDoc = await this.firestoreService.getDocument('active_scheduled_matches', rideId);
      
      if (!rideDoc.exists) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'Ride not found', timestamp: Date.now() } 
        });
      }
      
      const ride = rideDoc.data();
      const nUserId = this.formatPhoneNumber(userId);
      
      if (ride.driverPhone !== nUserId) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'Only driver can start the ride', timestamp: Date.now() } 
        });
      }
      
      const now = new Date().toISOString();
      await this.firestoreService.updateDocument('active_scheduled_matches', rideId, { 
        status: 'enroute', 
        rideStartedAt: now, 
        updatedAt: now 
      });
      
      const notification = {
        type: 'SCHEDULED_RIDE_STARTED_NOTIFICATION',
        data: { 
          rideId, 
          driverId: userId, 
          timestamp: now,
          message: 'Your ride has started! Track your driver live.'
        }
      };
      
      // Send notification via NotificationService
      if (this.notificationService) {
        await this.notificationService.sendNotification(ride.passengerPhone, notification, { important: true });
      } else {
        await this.sendToUser(ride.passengerPhone, notification);
      }
      
      this.sendToUser(userId, { 
        type: 'SCHEDULED_RIDE_STARTED_RESPONSE', 
        data: { success: true, rideId, timestamp: now } 
      });
      
      logger.info('SCHEDULED_RIDE', `🚗 Ride ${rideId} started by driver ${userId}`);
    } catch (error) {
      logger.error('SCHEDULED_WS', `❌ Error starting scheduled ride:`, error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to start scheduled ride', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  async handleCompleteScheduledRide(userId, message) {
    try {
      const { rideId, paymentAmount, paymentMethod = 'cash' } = message.data || message;
      if (!rideId) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'rideId is required', timestamp: Date.now() } 
        });
      }
      
      // Use firestoreService.getDocument
      const rideDoc = await this.firestoreService.getDocument('active_scheduled_matches', rideId);
      
      if (!rideDoc.exists) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'Ride not found', timestamp: Date.now() } 
        });
      }
      
      const ride = rideDoc.data();
      const nUserId = this.formatPhoneNumber(userId);
      
      if (ride.driverPhone !== nUserId) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'Only driver can complete the ride', timestamp: Date.now() } 
        });
      }
      
      const now = new Date().toISOString();
      const finalAmount = paymentAmount || ride.estimatedFare || 0;
      
      // Update ride
      await this.firestoreService.updateDocument('active_scheduled_matches', rideId, { 
        status: 'completed', 
        rideCompletedAt: now, 
        paymentAmount: finalAmount, 
        paymentMethod, 
        paymentStatus: 'paid', 
        updatedAt: now 
      });
      
      // Move to history
      await this.firestoreService.setDocument('scheduled_ride_history', rideId, {
        ...ride,
        status: 'completed',
        rideCompletedAt: now,
        paymentAmount: finalAmount,
        paymentMethod,
        paymentStatus: 'paid',
        historyCreatedAt: now
      });
      
      // Delete from active
      await this.firestoreService.deleteDocument('active_scheduled_matches', rideId);
      
      // Update stats
      await this.updateRideStats(ride.driverPhone, ride.passengerPhone, finalAmount);
      
      const notification = {
        type: 'SCHEDULED_RIDE_COMPLETED_NOTIFICATION',
        data: { 
          rideId, 
          driverId: userId, 
          paymentAmount: finalAmount, 
          paymentMethod, 
          timestamp: now,
          message: 'Your ride is complete! Rate your experience.'
        }
      };
      
      // Send notification via NotificationService
      if (this.notificationService) {
        await this.notificationService.sendNotification(ride.passengerPhone, notification, { important: true });
      } else {
        await this.sendToUser(ride.passengerPhone, notification);
      }
      
      this.sendToUser(userId, { 
        type: 'SCHEDULED_RIDE_COMPLETED_RESPONSE', 
        data: { success: true, rideId, paymentAmount: finalAmount, paymentMethod, timestamp: now } 
      });
      
      logger.info('SCHEDULED_RIDE', `✨ Ride ${rideId} completed by driver ${userId}, amount: ${finalAmount}`);
    } catch (error) {
      logger.error('SCHEDULED_WS', `❌ Error completing scheduled ride:`, error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to complete scheduled ride', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  async handleUpdateRideLocation(userId, message) {
    try {
      const { rideId, latitude, longitude, accuracy = 0, userType = 'driver' } = message.data || message;
      if (!rideId || !latitude || !longitude) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'rideId, latitude, and longitude are required', timestamp: Date.now() } 
        });
      }
      
      // Use firestoreService.getDocument
      const rideDoc = await this.firestoreService.getDocument('active_scheduled_matches', rideId);
      
      if (!rideDoc.exists) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'Ride not found', timestamp: Date.now() } 
        });
      }
      
      const ride = rideDoc.data();
      const nUserId = this.formatPhoneNumber(userId);
      
      if (ride.driverPhone !== nUserId && ride.passengerPhone !== nUserId) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'Not authorized to update location for this ride', timestamp: Date.now() } 
        });
      }
      
      const now = new Date().toISOString();
      const updateField = userType === 'driver' ? 'currentDriverLocation' : 'currentPassengerLocation';
      
      await this.firestoreService.updateDocument('active_scheduled_matches', rideId, { 
        [updateField]: { 
          lat: latitude, 
          lng: longitude, 
          accuracy, 
          updatedAt: now 
        }, 
        lastLocationUpdate: now, 
        updatedAt: now 
      });
      
      const other = nUserId === ride.driverPhone ? ride.passengerPhone : ride.driverPhone;
      
      // Send location update to other party
      await this.sendToUser(other, { 
        type: 'RIDE_LOCATION_UPDATED', 
        data: { 
          rideId, 
          userId, 
          userType, 
          location: { latitude, longitude }, 
          accuracy, 
          timestamp: now 
        } 
      });
      
      this.sendToUser(userId, { 
        type: 'RIDE_LOCATION_UPDATED_RESPONSE', 
        data: { 
          success: true, 
          rideId, 
          location: { latitude, longitude }, 
          userType, 
          timestamp: now 
        } 
      });
    } catch (error) {
      logger.error('SCHEDULED_WS', `Error updating ride location:`, error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to update ride location', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  async handleGetRideLocation(userId, message) {
    try {
      const { rideId, requestUserType = 'passenger' } = message.data || message;
      if (!rideId) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'rideId is required', timestamp: Date.now() } 
        });
      }
      
      // Use firestoreService.getDocument
      const rideDoc = await this.firestoreService.getDocument('active_scheduled_matches', rideId);
      
      if (!rideDoc.exists) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'Ride not found', timestamp: Date.now() } 
        });
      }
      
      const ride = rideDoc.data();
      const nUserId = this.formatPhoneNumber(userId);
      
      if (ride.driverPhone !== nUserId && ride.passengerPhone !== nUserId) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'Not authorized to get location for this ride', timestamp: Date.now() } 
        });
      }
      
      const location = requestUserType === 'driver' 
        ? ride.currentPassengerLocation 
        : ride.currentDriverLocation;
      
      this.sendToUser(userId, { 
        type: 'RIDE_LOCATION_RESPONSE', 
        data: { 
          success: true, 
          rideId, 
          location, 
          requestUserType, 
          timestamp: new Date().toISOString() 
        } 
      });
    } catch (error) {
      logger.error('SCHEDULED_WS', `Error getting ride location:`, error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to get ride location', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  // ==================== DRIVER MANAGEMENT HANDLERS ====================

  async handleDriverCancelAll(userId, message) {
    try {
      const { driverPhone, reason = 'driver_cancelled_all' } = message;
      const nDriverPhone = this.formatPhoneNumber(driverPhone || userId);
      
      if (!nDriverPhone) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'Driver phone is required', timestamp: Date.now() } 
        });
      }
      
      const result = await this.scheduledMatchingService.handleDriverCancelAll(
        nDriverPhone,
        reason
      );
      
      // Send confirmation back to driver
      this.sendToUser(userId, {
        type: 'CANCEL_ALL_CONFIRMED',
        data: result
      });
      
      // Notify affected passengers via NotificationService
      if (result.success && result.passengers && result.passengers.length > 0 && this.notificationService) {
        for (const passenger of result.passengers) {
          await this.notificationService.sendNotification(passenger.passengerPhone, {
            type: 'DRIVER_CANCELLED_ALL_NOTIFICATION',
            data: {
              driverPhone: nDriverPhone,
              driverName: passenger.driverName || 'Your driver',
              reason: reason,
              cancelledAt: new Date().toISOString(),
              message: `Your driver has cancelled all rides. We'll help you find a new driver.`
            }
          }, { important: true });
        }
      }
      
      logger.info('SCHEDULED_WS', `✅ Driver ${nDriverPhone} cancelled all passengers: ${result.cancelledCount} cancelled`);
    } catch (error) {
      logger.error('SCHEDULED_WS', `❌ Error in driver cancel all:`, error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to cancel all passengers', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  async handleDriverCancelPassenger(userId, message) {
    try {
      const { driverPhone, passengerPhone, reason = 'driver_cancelled_passenger' } = message;
      const nDriverPhone = this.formatPhoneNumber(driverPhone || userId);
      const nPassengerPhone = this.formatPhoneNumber(passengerPhone);
      
      if (!nDriverPhone || !nPassengerPhone) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'Driver phone and passenger phone are required', timestamp: Date.now() } 
        });
      }
      
      const result = await this.scheduledMatchingService.handleDriverCancelPassenger(
        nDriverPhone,
        nPassengerPhone,
        reason
      );
      
      // Send confirmation to driver
      this.sendToUser(userId, {
        type: 'CANCEL_PASSENGER_CONFIRMED',
        data: result
      });
      
      // Notify the cancelled passenger via NotificationService
      if (result.success && this.notificationService) {
        await this.notificationService.sendNotification(nPassengerPhone, {
          type: 'DRIVER_CANCELLED_PASSENGER_NOTIFICATION',
          data: {
            driverPhone: nDriverPhone,
            driverName: result.driverName || 'Your driver',
            reason: reason,
            cancelledAt: new Date().toISOString(),
            message: `Your driver has cancelled your ride. We'll help you find a new driver.`
          }
        }, { important: true });
      }
      
      logger.info('SCHEDULED_WS', `✅ Driver ${nDriverPhone} cancelled passenger ${nPassengerPhone}`);
    } catch (error) {
      logger.error('SCHEDULED_WS', `❌ Error in driver cancel passenger:`, error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to cancel passenger', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  async handleGetDriverPassengers(userId, message) {
    try {
      const { driverPhone } = message;
      const nDriverPhone = this.formatPhoneNumber(driverPhone || userId);
      
      if (!nDriverPhone) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'Driver phone is required', timestamp: Date.now() } 
        });
      }
      
      const result = await this.scheduledMatchingService.getDriverAcceptedPassengers(
        nDriverPhone
      );
      
      this.sendToUser(userId, {
        type: 'DRIVER_PASSENGERS_LIST',
        data: result
      });
      
      logger.info('SCHEDULED_WS', `📋 Sent passenger list to driver ${nDriverPhone}: ${result.passengers?.length || 0} passengers`);
    } catch (error) {
      logger.error('SCHEDULED_WS', `❌ Error getting driver passengers:`, error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to get driver passengers', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  // ==================== SCHEDULE AND STATS HANDLERS ====================

  async handleGetScheduleCalendar(userId, message) {
    try {
      const { startDate, endDate, userType } = message.data || message;
      const userInfo = this.connectedUsers.get(userId);
      const actualUserType = userType || userInfo?.role || 'unknown';
      const collection = actualUserType === 'driver' 
        ? 'scheduled_searches_driver' 
        : 'scheduled_searches_passenger';
      const nUserId = this.formatPhoneNumber(userId);
      
      // Build query constraints
      let constraints = [
        { field: 'userId', operator: '==', value: nUserId }
      ];
      
      if (startDate) {
        constraints.push({ 
          field: 'scheduledTime', 
          operator: '>=', 
          value: new Date(startDate).toISOString() 
        });
      }
      if (endDate) {
        constraints.push({ 
          field: 'scheduledTime', 
          operator: '<=', 
          value: new Date(endDate).toISOString() 
        });
      }
      
      // Use firestoreService.queryCollection
      const snapshot = await this.firestoreService.queryCollection(
        collection,
        constraints,
        100, // limit
        { field: 'scheduledTime', direction: 'asc' } // orderBy
      );
      
      const schedules = [];
      snapshot.forEach(d => {
        const s = d.data();
        schedules.push({ 
          id: d.id, 
          ...s, 
          scheduledDate: s.scheduledTime 
            ? new Date(s.scheduledTime).toISOString().split('T')[0] 
            : null 
        });
      });
      
      const grouped = {};
      schedules.forEach(s => { 
        if (s.scheduledDate) { 
          if (!grouped[s.scheduledDate]) grouped[s.scheduledDate] = []; 
          grouped[s.scheduledDate].push(s); 
        } 
      });
      
      this.sendToUser(userId, { 
        type: 'SCHEDULE_CALENDAR_RESPONSE', 
        data: { 
          success: true, 
          userId, 
          userType: actualUserType, 
          schedules: grouped, 
          total: schedules.length, 
          timestamp: new Date().toISOString() 
        } 
      });
    } catch (error) {
      logger.error('SCHEDULED_WS', `Error getting schedule calendar:`, error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to get schedule calendar', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  async handleUpdateSchedulePreferences(userId, message) {
    try {
      const { preferences } = message.data || message;
      if (!preferences) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'preferences object is required', timestamp: Date.now() } 
        });
      }
      
      const nUserId = this.formatPhoneNumber(userId);
      
      // Use firestoreService.setDocument
      await this.firestoreService.setDocument('user_preferences', nUserId, { 
        userId: nUserId, 
        schedulePreferences: preferences, 
        updatedAt: new Date().toISOString() 
      }, { merge: true });
      
      this.sendToUser(userId, { 
        type: 'SCHEDULE_PREFERENCES_UPDATED', 
        data: { 
          success: true, 
          userId, 
          preferences, 
          timestamp: new Date().toISOString() 
        } 
      });
    } catch (error) {
      logger.error('SCHEDULED_WS', `Error updating schedule preferences:`, error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to update schedule preferences', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  async handleGetScheduledStats(userId, message) {
    try {
      let stats;
      
      if (this.scheduledMatchingService?.getStats) {
        stats = await this.scheduledMatchingService.getStats();
      } else {
        stats = { 
          connectedUsers: this.getConnectedUsers().length, 
          drivers: this.getConnectedUsers().filter(u => u.role === 'driver').length, 
          passengers: this.getConnectedUsers().filter(u => u.role === 'passenger').length, 
          activeScheduledRides: this.activeScheduledRides.size, 
          serviceType: 'scheduled_only', 
          timestamp: new Date().toISOString() 
        };
      }
      
      // Add WebSocket specific stats
      stats.wsConnections = this.getConnectedUsers().length;
      stats.wsActive = true;
      stats.notificationServiceAvailable = !!this.notificationService;
      
      this.sendToUser(userId, { 
        type: 'SCHEDULED_STATS_RESPONSE', 
        data: stats 
      });
    } catch (error) {
      logger.error('SCHEDULED_WS', `Error getting scheduled stats:`, error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to get scheduled stats', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  async handleTestScheduledMatching(userId, message) {
    try {
      const testType = (message.data || message).testType;
      
      this.sendToUser(userId, { 
        type: 'TEST_SCHEDULED_MATCHING_RESPONSE', 
        data: { 
          success: true, 
          testType,
          scheduledServiceAvailable: !!this.scheduledMatchingService,
          notificationServiceAvailable: !!this.notificationService,
          connectedUsers: this.getConnectedUsers().length,
          timestamp: Date.now() 
        } 
      });
    } catch (error) {
      logger.error('SCHEDULED_WS', `Error in test handler:`, error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Test failed', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  // ==================== BASIC HANDLERS ====================

  async handlePing(userId, userInfo) {
    try {
      if (userInfo.ws.readyState === WebSocket.OPEN) {
        userInfo.ws.send(JSON.stringify({ 
          type: 'PONG', 
          timestamp: Date.now(), 
          userId 
        }));
      }
    } catch (error) {
      logger.error('SCHEDULED_WS', `Error handling PING:`, error);
    }
  }

  async handleUpdateScheduledLocation(userId, message) {
    try {
      const { latitude, longitude, accuracy = 0, userType = 'passenger' } = message.data || message;
      if (!latitude || !longitude) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'latitude and longitude are required', timestamp: Date.now() } 
        });
      }
      
      if (!this.userSubscriptions.has(userId)) {
        this.userSubscriptions.set(userId, new Set());
      }
      
      this.sendToUser(userId, { 
        type: 'SCHEDULED_LOCATION_UPDATED', 
        data: { 
          userId, 
          location: { latitude, longitude }, 
          accuracy, 
          timestamp: Date.now() 
        } 
      });
    } catch (error) {
      logger.error('SCHEDULED_WS', `Error updating scheduled location:`, error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to update scheduled location', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  async handleGetScheduledStatus(userId, message) {
    try {
      const userInfo = this.connectedUsers.get(userId);
      if (!userInfo) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'User not connected', timestamp: Date.now() } 
        });
      }
      
      const nUserId = this.formatPhoneNumber(userId);
      
      // Use firestoreService.getDocument for both collections
      const [driverDoc, passengerDoc] = await Promise.all([
        this.firestoreService.getDocument('scheduled_searches_driver', nUserId),
        this.firestoreService.getDocument('scheduled_searches_passenger', nUserId)
      ]);
      
      this.sendToUser(userId, { 
        type: 'SCHEDULED_STATUS_RESPONSE', 
        data: { 
          success: true, 
          userId: nUserId, 
          hasDriverScheduled: driverDoc.exists, 
          hasPassengerScheduled: passengerDoc.exists, 
          driverData: driverDoc.exists ? driverDoc.data() : null, 
          passengerData: passengerDoc.exists ? passengerDoc.data() : null, 
          timestamp: new Date().toISOString() 
        } 
      });
    } catch (error) {
      logger.error('SCHEDULED_WS', `Error getting scheduled status:`, error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to get scheduled status', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  async checkAndSendScheduledStatus(userId, role) {
    try {
      const nUserId = this.formatPhoneNumber(userId);
      
      // Use firestoreService.getDocument for searches
      const [driverDoc, passengerDoc] = await Promise.all([
        this.firestoreService.getDocument('scheduled_searches_driver', nUserId),
        this.firestoreService.getDocument('scheduled_searches_passenger', nUserId)
      ]);
      
      const scheduled = [];
      if (driverDoc.exists) scheduled.push({ type: 'driver', ...driverDoc.data() });
      if (passengerDoc.exists) scheduled.push({ type: 'passenger', ...passengerDoc.data() });
      
      // Query active rides using firestoreService.queryCollection
      const activeSnapshot = await this.firestoreService.queryCollection(
        'active_scheduled_matches',
        [
          { field: 'status', operator: 'in', value: ['active', 'enroute', 'arrived'] }
        ],
        50 // limit
      );
      
      const active = [];
      activeSnapshot.forEach(d => {
        const r = d.data();
        if (r.driverPhone === nUserId || r.passengerPhone === nUserId) {
          active.push({ rideId: d.id, ...r });
        }
      });
      
      this.sendToUser(userId, { 
        type: 'SCHEDULED_STATUS_ON_CONNECT', 
        data: { 
          userId, 
          role, 
          scheduledSearches: scheduled, 
          activeRides: active, 
          timestamp: new Date().toISOString() 
        } 
      });
    } catch (error) {
      logger.error('SCHEDULED_WS', `Error checking scheduled status:`, error);
    }
  }

  async handleCancelScheduledSearch(userId, message) {
    try {
      const userInfo = this.connectedUsers.get(userId);
      if (!userInfo) {
        return this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: 'User not connected', timestamp: Date.now() } 
        });
      }
      
      const { userType = userInfo.role, reason = 'user_cancelled' } = message.data || message;
      const nUserId = this.formatPhoneNumber(userId);
      
      const result = await this.scheduledMatchingService.cancelScheduledSearch(
        nUserId, 
        userType, 
        reason
      );
      
      if (result.success) {
        this.sendToUser(userId, { 
          type: 'SCHEDULED_SEARCH_CANCELLED_RESPONSE', 
          data: { 
            success: true, 
            userId, 
            userType, 
            reason, 
            message: 'Scheduled search cancelled successfully', 
            timestamp: Date.now() 
          } 
        });
        
        logger.info('SCHEDULED_WS', `✅ Scheduled search cancelled for ${userId} (${userType})`);
      } else {
        this.sendToUser(userId, { 
          type: 'ERROR', 
          data: { message: result.error || 'Failed to cancel scheduled search', timestamp: Date.now() } 
        });
      }
    } catch (error) {
      logger.error('SCHEDULED_WS', `Error cancelling scheduled search:`, error);
      this.sendToUser(userId, { 
        type: 'ERROR', 
        data: { message: 'Failed to cancel scheduled search', error: error.message, timestamp: Date.now() } 
      });
    }
  }

  // ==================== UTILITY METHODS ====================

  async updateRideStats(driverPhone, passengerPhone, amount, isCancelled = false) {
    try {
      const now = new Date().toISOString();
      const batch = this.firestore.batch();
      
      const driverRef = this.firestore.collection('driver_stats').doc(driverPhone);
      batch.set(driverRef, { 
        completedRides: isCancelled ? 0 : admin.firestore.FieldValue.increment(1),
        cancelledRides: isCancelled ? admin.firestore.FieldValue.increment(1) : 0,
        totalEarnings: admin.firestore.FieldValue.increment(amount), 
        lastUpdated: now 
      }, { merge: true });
      
      const passengerRef = this.firestore.collection('passenger_stats').doc(passengerPhone);
      batch.set(passengerRef, { 
        completedRides: isCancelled ? 0 : admin.firestore.FieldValue.increment(1),
        cancelledRides: isCancelled ? admin.firestore.FieldValue.increment(1) : 0,
        lastRideAt: isCancelled ? null : now,
        lastUpdated: now 
      }, { merge: true });
      
      await batch.commit();
    } catch (error) {
      logger.error('SCHEDULED_WS', 'Error updating ride stats:', error);
    }
  }

  async getActualUserDetails(userId, userType) {
    try {
      const formatted = this.formatPhoneNumber(userId);
      
      // Check cache
      if (this.connectedUsers.has(userId) && this.connectedUsers.get(userId).userDetails) {
        return this.connectedUsers.get(userId).userDetails;
      }
      
      let userData = { 
        id: userId, 
        name: userType === 'driver' ? 'Driver' : 'Passenger', 
        phone: formatted || userId, 
        photoUrl: '', 
        rating: userType === 'driver' ? 4.5 : 4.0 
      };
      
      // Use firestoreService.queryCollection to find user by phone
      const userQuery = await this.firestoreService.queryCollection(
        'users',
        [{ field: 'phone', operator: '==', value: formatted }],
        1
      );
      
      if (!userQuery.empty) {
        const d = userQuery.docs[0].data();
        userData = { 
          id: userQuery.docs[0].id, 
          name: d.name || d.fullName || d.displayName || userData.name, 
          phone: d.phone || formatted, 
          email: d.email || '', 
          photoUrl: d.photoURL || d.profileImage || d.photoUrl || '', 
          rating: d.rating || d.averageRating || userData.rating 
        };
        
        if (userType === 'driver') {
          const driverDoc = await this.firestoreService.getDocument('drivers', userQuery.docs[0].id);
          if (driverDoc.exists) {
            const dd = driverDoc.data();
            userData.vehicleInfo = dd.vehicleInfo || {};
            userData.driverRating = dd.driverRating || d.rating || 4.5;
            userData.totalRides = dd.totalRides || 0;
            userData.driverName = dd.driverName || d.name || 'Driver';
          }
        }
      }
      
      // Cache the result
      if (this.connectedUsers.has(userId)) {
        this.connectedUsers.get(userId).userDetails = userData;
      }
      
      return userData;
    } catch (error) {
      logger.error('SCHEDULED_WS', 'Error fetching user details:', error);
      return { 
        id: userId, 
        name: userType === 'driver' ? 'Driver' : 'Passenger', 
        phone: this.formatPhoneNumber(userId) || userId, 
        photoUrl: '', 
        rating: userType === 'driver' ? 4.5 : 4.0 
      };
    }
  }

  async lookupFirebaseUidByPhone(phone) {
    try {
      const formatted = this.formatPhoneNumber(phone);
      
      if (this.phoneToUidCache.has(formatted)) {
        return this.phoneToUidCache.get(formatted);
      }
      
      // Use firestoreService.queryCollection to find user by phone
      const userQuery = await this.firestoreService.queryCollection(
        'users',
        [{ field: 'phone', operator: '==', value: formatted }],
        1
      );
      
      if (!userQuery.empty) {
        const uid = userQuery.docs[0].id;
        this.phoneToUidCache.set(formatted, uid);
        this.uidToPhoneCache.set(uid, formatted);
        return uid;
      }
      
      // Try drivers collection
      const driverQuery = await this.firestoreService.queryCollection(
        'drivers',
        [{ field: 'phone', operator: '==', value: formatted }],
        1
      );
      
      if (!driverQuery.empty) {
        const uid = driverQuery.docs[0].id;
        this.phoneToUidCache.set(formatted, uid);
        this.uidToPhoneCache.set(uid, formatted);
        return uid;
      }
      
      return null;
    } catch (error) {
      logger.error('SCHEDULED_WS', 'Error looking up Firebase UID:', error);
      return null;
    }
  }

  isPhoneNumber(str) {
    if (!str) return false;
    str = str.toString().trim();
    
    // Check for Firebase UID format (28 chars, alphanumeric with underscores/hyphens)
    if (str.length === 28 && /^[A-Za-z0-9_-]{28}$/.test(str)) return false;
    
    // Check for test user formats
    if (str.includes('passenger_') || str.includes('driver_') || str.includes('test_')) return false;
    if (str.includes('_') && str.length > 20) return false;
    
    // Phone number patterns
    return [
      /^\+251[1-9]\d{8}$/,  // +251XXXXXXXXX
      /^251[1-9]\d{8}$/,     // 251XXXXXXXXX
      /^09[1-9]\d{7}$/,      // 09XXXXXXXX
      /^9[1-9]\d{7}$/,       // 9XXXXXXXX
      /^\d{10,15}$/          // Generic 10-15 digits
    ].some(p => p.test(str));
  }

  formatPhoneNumber(phone) {
    if (!phone) return null;
    phone = phone.toString().trim();
    
    // Extract digits
    let digits = phone.replace(/\D/g, '');
    if (!digits.length) return phone;
    
    // Format Ethiopian phone numbers
    if (digits.startsWith('251') && digits.length === 12) {
      return `+${digits}`;
    }
    if (digits.startsWith('09') && digits.length === 10) {
      return `+251${digits.substring(1)}`;
    }
    if (digits.startsWith('9') && digits.length === 9) {
      return `+251${digits}`;
    }
    
    // Return original if starts with +, otherwise add +
    return phone.startsWith('+') ? phone : `+${phone}`;
  }

  // ==================== CLEANUP METHODS ====================

  handleConnectionClose(connectionKey, originalUserId) {
    this.cleanupUserData(connectionKey);
    
    for (const [key, u] of this.connectedUsers.entries()) {
      if (u.formattedId === connectionKey || 
          u.originalId === originalUserId || 
          (u.isAlias && u.ws === this.connectedUsers.get(connectionKey)?.ws)) {
        this.connectedUsers.delete(key);
      }
    }
    
    logger.info('SCHEDULED_WS', `User disconnected: ${connectionKey}`);
  }

  cleanupUserData(userId) {
    if (this.userSubscriptions.has(userId)) {
      this.userSubscriptions.delete(userId);
    }
    if (this.scheduledSearches.has(userId)) {
      this.scheduledSearches.delete(userId);
    }
    for (const [rideId, ride] of this.activeScheduledRides.entries()) {
      if (ride.driverPhone === userId || ride.passengerPhone === userId) {
        this.activeScheduledRides.delete(rideId);
      }
    }
  }

  cleanupStaleConnections() {
    const now = Date.now();
    const maxInactive = 300000; // 5 minutes
    
    for (const [id, u] of this.connectedUsers.entries()) {
      if (now - u.lastActivity > maxInactive) {
        try { 
          if (u.ws.readyState === WebSocket.OPEN) {
            u.ws.close(1000, 'Connection timeout'); 
          }
        } catch (e) {}
        
        this.cleanupUserData(id);
        this.connectedUsers.delete(id);
        logger.info('SCHEDULED_WS', `Cleaned up stale connection: ${id}`);
      }
    }
  }

  cleanupExpiredScheduledData() {
    this.cleanupExpiredSearches();
    this.cleanupExpiredMatches();
  }

  async cleanupExpiredSearches() {
    try {
      const expiry = new Date(Date.now() - 7*24*60*60*1000).toISOString();
      
      // Use firestoreService.queryCollection for both collections
      const [driverQ, passengerQ] = await Promise.all([
        this.firestoreService.queryCollection(
          'scheduled_searches_driver',
          [
            { field: 'scheduledTime', operator: '<', value: expiry },
            { field: 'status', operator: 'in', value: ['completed', 'cancelled', 'expired'] }
          ],
          50
        ),
        this.firestoreService.queryCollection(
          'scheduled_searches_passenger',
          [
            { field: 'scheduledTime', operator: '<', value: expiry },
            { field: 'status', operator: 'in', value: ['completed', 'cancelled', 'expired'] }
          ],
          50
        )
      ]);
      
      const batch = this.firestore.batch();
      driverQ.forEach(d => batch.delete(d.ref));
      passengerQ.forEach(d => batch.delete(d.ref));
      
      if (driverQ.size + passengerQ.size > 0) {
        await batch.commit();
      }
    } catch (error) {
      logger.error('SCHEDULED_WS', 'Error cleaning up expired searches:', error);
    }
  }

  async cleanupExpiredMatches() {
    try {
      const expiry = new Date(Date.now() - 30*24*60*60*1000).toISOString();
      
      // Use firestoreService.queryCollection
      const matchQ = await this.firestoreService.queryCollection(
        'scheduled_matches',
        [
          { field: 'createdAt', operator: '<', value: expiry },
          { field: 'status', operator: 'in', value: ['expired', 'cancelled', 'declined'] }
        ],
        50
      );
      
      const batch = this.firestore.batch();
      matchQ.forEach(d => batch.delete(d.ref));
      
      if (matchQ.size > 0) {
        await batch.commit();
      }
    } catch (error) {
      logger.error('SCHEDULED_WS', 'Error cleaning up expired matches:', error);
    }
  }

  // ==================== SEND METHODS ====================

  async sendToUser(userIdentifier, message) {
    try {
      if (!userIdentifier) return false;
      
      const possibleKeys = [userIdentifier];
      const formatted = this.formatPhoneNumber(userIdentifier);
      
      if (formatted && formatted !== userIdentifier) {
        possibleKeys.push(formatted);
      }
      
      if (this.isPhoneNumber(userIdentifier) || this.isPhoneNumber(formatted)) {
        const uid = await this.lookupFirebaseUidByPhone(formatted || userIdentifier);
        if (uid) possibleKeys.push(uid);
      }
      
      for (const key of possibleKeys) {
        const u = this.connectedUsers.get(key);
        if (u?.ws?.readyState === WebSocket.OPEN) {
          try {
            u.ws.send(JSON.stringify(message));
            u.lastActivity = Date.now();
            return true;
          } catch (e) {
            this.connectedUsers.delete(key);
          }
        }
      }
      
      return false;
    } catch (error) {
      logger.error('SCHEDULED_WS', 'Error in sendToUser:', error);
      return false;
    }
  }

  setupScheduledMatchingServiceIntegration(scheduledMatchingService) {
    this.scheduledMatchingService = scheduledMatchingService;
    logger.info('SCHEDULED_WS', '🔗 Linked to ScheduledMatchingService');
  }

  // ==================== STATS METHODS ====================

  getStats() {
    const connected = this.getConnectedUsers();
    return { 
      connectedUsers: connected.length, 
      drivers: connected.filter(u => u.role === 'driver').length, 
      passengers: connected.filter(u => u.role === 'passenger').length, 
      userSubscriptions: this.userSubscriptions.size, 
      activeScheduledRides: this.activeScheduledRides.size, 
      scheduledSearches: this.scheduledSearches.size, 
      serviceType: 'scheduled_only', 
      notificationServiceAvailable: !!this.notificationService,
      timestamp: new Date().toISOString(), 
      server: 'localhost:3000', 
      path: '/ws-scheduled' 
    };
  }

  getConnectedUsers() {
    const connected = [];
    const seen = new Set();
    
    for (const [id, u] of this.connectedUsers.entries()) {
      if (u.ws.readyState === WebSocket.OPEN && !seen.has(u.ws)) {
        seen.add(u.ws);
        connected.push({ 
          userId: id, 
          role: u.role, 
          connectedAt: u.connectedAt, 
          formattedId: u.formattedId, 
          isPhone: u.isPhone, 
          lastActivity: u.lastActivity 
        });
      }
    }
    
    return connected;
  }

  close() {
    this.wss.close();
    logger.info('SCHEDULED_WS', '🔌 Scheduled WebSocket Server closed');
  }
}

module.exports = ScheduledWebSocketServer;
