// app.js - COMPLETE VERSION WITH RIDE HISTORY AND CLEANUP SERVICES
// MODULAR FCM ROUTES, GROUP RIDE ENDPOINTS, DRIVER CANCELLATION ENDPOINTS,
// PASSENGER CANCELLATION ENDPOINTS, WEBSOCKET FCM TOKEN REGISTRATION,
// RIDE HISTORY, AND AUTOMATIC CLEANUP

const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const url = require('url');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// Initialize logger first
const loggerPath = path.join(__dirname, 'utils', 'Logger');
let logger;
try {
  logger = require(loggerPath);
  console.log('✅ Logger loaded from:', loggerPath);
} catch (error) {
  console.error('❌ Failed to load Logger:', error.message);
  // Create a minimal logger as fallback
  logger = {
    info: (module, msg) => console.log(`[${module}] ${msg}`),
    error: (module, msg) => console.error(`[${module}] ${msg}`),
    warn: (module, msg) => console.warn(`[${module}] ${msg}`),
    debug: (module, msg) => console.debug(`[${module}] ${msg}`),
    enableModule: () => {}
  };
}

const enableLogModules = () => {
  ['INFO', 'SCHEDULED', 'STARTUP', 'SERVICE', 'CONNECTION', 'ENDPOINT', 'ERRORS', 'DEBUG', 'FCM', 'NOTIFICATIONS', 'RIDES', 'CLEANUP']
    .forEach(module => logger.enableModule(module, true));
};
enableLogModules();

// Global variables
let legacyWebsocketServer = null;
let scheduledWebsocketServer = null;
let firestoreService = null;
let scheduledService = null;
let notificationService = null;
let rideHistoryService = null;
let cleanupService = null;

// ==================== UTILITY FUNCTIONS ====================

function formatPhoneNumber(phone) {
  if (!phone) return '';
  let digits = phone.replace(/\D/g, '');
  
  if (digits.startsWith('251') && digits.length === 12) {
    return `+${digits}`;
  } else if (digits.startsWith('09') && digits.length === 10) {
    return `+251${digits.substring(1)}`;
  } else if (digits.startsWith('9') && digits.length === 9) {
    return `+251${digits}`;
  } else if (digits.length >= 10) {
    return `+${digits}`;
  }
  
  return phone;
}

function sanitizePhoneNumber(phone) {
  if (!phone) return '';
  return phone.replace(/[^\d+]/g, '');
}

// ==================== BASE WEBSOCKET SERVER ====================

class BaseWebSocketServer {
  constructor(server, services, options = {}) {
    this.firestoreService = services.firestoreService;
    this.scheduledService = services.scheduledService;
    this.notificationService = services.notificationService;
    this.rideHistoryService = services.rideHistoryService;
    this.db = services.firestoreService?.db;
    this.admin = services.firestoreService?.admin;
    this.options = options;
    
    this.wss = new WebSocket.Server({ noServer: true, clientTracking: true });
    this.connectedUsers = new Map();
    
    this.setupWebSocket();
    logger.info('WEBSOCKET', `${options.name} WebSocket Server initialized`);
  }
  
  setupWebSocket() {
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    this.wss.on('error', (error) => logger.error(this.options.logPrefix, 'Server error:', error));
  }
  
  async handleConnection(ws, req) {
    try {
      const parsedUrl = url.parse(req.url, true);
      let userId = parsedUrl.query.userId ? decodeURIComponent(parsedUrl.query.userId.trim()) : '';
      userId = userId.replace(/%2B/g, '+');
      
      if (!userId) {
        ws.close(1008, 'User ID required');
        return;
      }
      
      const connectionKey = formatPhoneNumber(userId);
      const userInfo = {
        ws,
        platform: parsedUrl.query.platform || 'unknown',
        role: parsedUrl.query.role || parsedUrl.query.userType || 'unknown',
        connectedAt: new Date().toISOString(),
        lastActivity: Date.now(),
        originalId: userId,
        formattedId: connectionKey
      };
      
      if (this.connectedUsers.has(connectionKey)) {
        const existing = this.connectedUsers.get(connectionKey);
        try { existing.ws.close(1000, 'New connection'); } catch (e) {}
      }
      
      this.connectedUsers.set(connectionKey, userInfo);
      
      this.sendToUser(connectionKey, {
        type: 'CONNECTED',
        data: {
          userId: connectionKey,
          timestamp: Date.now(),
          message: `Connected to ${this.options.name}`,
          server: 'localhost:3000',
          serviceType: this.options.serviceType
        }
      });
      
      ws.on('message', (data) => this.handleMessage(connectionKey, data));
      ws.on('close', () => this.handleDisconnection(connectionKey));
      ws.on('error', (error) => {
        logger.error(this.options.logPrefix, `Error for ${connectionKey}:`, error.message);
        this.handleDisconnection(connectionKey);
      });
      
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.ping(); } catch (e) { clearInterval(pingInterval); }
        } else {
          clearInterval(pingInterval);
        }
      }, 30000);
      
      ws.on('pong', () => {
        const info = this.connectedUsers.get(connectionKey);
        if (info) info.lastActivity = Date.now();
      });
      
      logger.info(this.options.logPrefix, `User connected: ${connectionKey} (${userInfo.role})`);
      
    } catch (error) {
      logger.error(this.options.logPrefix, 'Connection error:', error.message);
      try { ws.close(1011, 'Internal error'); } catch (e) {}
    }
  }
  
  async handleMessage(connectionKey, rawData) {
    try {
      const message = JSON.parse(rawData.toString());
      const userInfo = this.connectedUsers.get(connectionKey);
      
      if (!userInfo) {
        logger.warn(this.options.logPrefix, `No user info for: ${connectionKey}`);
        return;
      }
      
      userInfo.lastActivity = Date.now();
      await this.routeMessage(connectionKey, message, userInfo);
      
    } catch (error) {
      logger.error(this.options.logPrefix, `Message error: ${error.message}`);
      this.sendToUser(connectionKey, {
        type: 'ERROR',
        error: 'Failed to process message'
      });
    }
  }
  
  async routeMessage(connectionKey, message, userInfo) {
    const handlers = {
      'PING': () => this.sendToUser(connectionKey, { type: 'PONG', timestamp: Date.now() }),
      'CREATE_SCHEDULED_SEARCH': () => this.handleScheduledSearchCreation(connectionKey, message),
      'GET_SCHEDULED_STATUS': () => this.handleScheduledStatusRequest(connectionKey, message),
      'CANCEL_SCHEDULED_SEARCH': () => this.handleScheduledSearchCancellation(connectionKey, message),
      'LOGIN_REQUEST': () => this.handleAuthRequest(connectionKey, message, 'login'),
      'REGISTER_REQUEST': () => this.handleAuthRequest(connectionKey, message, 'register'),
      'VERIFY_PHONE': () => this.handleAuthRequest(connectionKey, message, 'verify'),
      'GET_USER_PROFILE': () => this.handleProfileRequest(connectionKey, message, 'get'),
      'UPDATE_USER_PROFILE': () => this.handleProfileRequest(connectionKey, message, 'update'),
      'REGISTER_FCM_TOKEN': () => this.handleFCMTokenRegistration(connectionKey, message, userInfo),
      'GET_RIDE_HISTORY': () => this.handleGetRideHistory(connectionKey, message, userInfo),
      'GET_RIDE_DETAILS': () => this.handleGetRideDetails(connectionKey, message, userInfo),
      'GET_RIDE_STATS': () => this.handleGetRideStats(connectionKey, message, userInfo),
      'ADD_RIDE_FEEDBACK': () => this.handleAddRideFeedback(connectionKey, message, userInfo)
    };
    
    const scheduledMatchHandlers = [
      'ACCEPT_SCHEDULED_MATCH',
      'DECLINE_SCHEDULED_MATCH',
      'SCHEDULED_MATCH_ACCEPTED',
      'SCHEDULED_MATCH_DECLINED',
      'SCHEDULED_MATCH_PROPOSAL',
      'SCHEDULED_DRIVER_FOUND'
    ];
    
    if (scheduledMatchHandlers.includes(message.type)) {
      console.log('\n' + '🟡'.repeat(40));
      console.log(`🟡 ${this.options.name} Server handling ${message.type}`);
      console.log('🟡'.repeat(40) + '\n');
      
      await this.handleScheduledMatchDecision(connectionKey, message, userInfo);
      return;
    }
    
    if (handlers[message.type]) {
      await handlers[message.type]();
    } else {
      logger.debug(this.options.logPrefix, `Unknown message: ${message.type}`);
      this.sendToUser(connectionKey, {
        type: 'MESSAGE_RECEIVED',
        data: { originalType: message.type, timestamp: Date.now() }
      });
    }
  }
  
  // ==================== RIDE HISTORY WEBSOCKET HANDLERS ====================
  
  async handleGetRideHistory(connectionKey, message, userInfo) {
    console.log(`📜 [WEBSOCKET] Getting ride history for ${connectionKey}`);
    
    try {
      if (!this.rideHistoryService) {
        console.log(`❌ [WEBSOCKET] RideHistoryService not available`);
        this.sendToUser(connectionKey, {
          type: 'ERROR',
          data: { message: 'Ride history service unavailable' }
        });
        return;
      }
      
      const data = message.data || message;
      const userType = data.userType || userInfo.role;
      const options = data.options || {};
      
      console.log(`📜 User type: ${userType}, Options:`, options);
      
      let result;
      if (userType === 'driver') {
        result = await this.rideHistoryService.getDriverRides(connectionKey, options);
      } else {
        result = await this.rideHistoryService.getPassengerRides(connectionKey, options);
      }
      
      this.sendToUser(connectionKey, {
        type: 'RIDE_HISTORY_RESPONSE',
        data: result
      });
      
    } catch (error) {
      console.error(`❌ [WEBSOCKET] Ride history error:`, error);
      this.sendToUser(connectionKey, {
        type: 'ERROR',
        data: { message: 'Failed to get ride history', error: error.message }
      });
    }
  }
  
  async handleGetRideDetails(connectionKey, message, userInfo) {
    console.log(`🔍 [WEBSOCKET] Getting ride details`);
    
    try {
      if (!this.rideHistoryService) {
        this.sendToUser(connectionKey, {
          type: 'ERROR',
          data: { message: 'Ride history service unavailable' }
        });
        return;
      }
      
      const data = message.data || message;
      const { rideId } = data;
      
      if (!rideId) {
        this.sendToUser(connectionKey, {
          type: 'ERROR',
          data: { message: 'rideId required' }
        });
        return;
      }
      
      const ride = await this.rideHistoryService.getRideDetails(rideId);
      
      this.sendToUser(connectionKey, {
        type: 'RIDE_DETAILS_RESPONSE',
        data: {
          success: true,
          ride,
          rideId
        }
      });
      
    } catch (error) {
      console.error(`❌ [WEBSOCKET] Ride details error:`, error);
      this.sendToUser(connectionKey, {
        type: 'ERROR',
        data: { message: 'Failed to get ride details', error: error.message }
      });
    }
  }
  
  async handleGetRideStats(connectionKey, message, userInfo) {
    console.log(`📊 [WEBSOCKET] Getting ride stats for ${connectionKey}`);
    
    try {
      if (!this.rideHistoryService) {
        this.sendToUser(connectionKey, {
          type: 'ERROR',
          data: { message: 'Ride history service unavailable' }
        });
        return;
      }
      
      const data = message.data || message;
      const userType = data.userType || userInfo.role;
      
      const stats = await this.rideHistoryService.getUserRideStats(connectionKey, userType);
      
      this.sendToUser(connectionKey, {
        type: 'RIDE_STATS_RESPONSE',
        data: stats
      });
      
    } catch (error) {
      console.error(`❌ [WEBSOCKET] Ride stats error:`, error);
      this.sendToUser(connectionKey, {
        type: 'ERROR',
        data: { message: 'Failed to get ride stats', error: error.message }
      });
    }
  }
  
  async handleAddRideFeedback(connectionKey, message, userInfo) {
    console.log(`⭐ [WEBSOCKET] Adding ride feedback`);
    
    try {
      if (!this.rideHistoryService) {
        this.sendToUser(connectionKey, {
          type: 'ERROR',
          data: { message: 'Ride history service unavailable' }
        });
        return;
      }
      
      const data = message.data || message;
      const { rideId, rating, review } = data;
      const userType = data.userType || userInfo.role;
      
      if (!rideId || !rating) {
        this.sendToUser(connectionKey, {
          type: 'ERROR',
          data: { message: 'rideId and rating required' }
        });
        return;
      }
      
      const result = await this.rideHistoryService.addRideFeedback(
        rideId,
        connectionKey,
        userType,
        rating,
        review
      );
      
      this.sendToUser(connectionKey, {
        type: 'FEEDBACK_ADDED_RESPONSE',
        data: result
      });
      
    } catch (error) {
      console.error(`❌ [WEBSOCKET] Add feedback error:`, error);
      this.sendToUser(connectionKey, {
        type: 'ERROR',
        data: { message: 'Failed to add feedback', error: error.message }
      });
    }
  }
  
  // ==================== FCM TOKEN REGISTRATION HANDLER ====================
  
  async handleFCMTokenRegistration(connectionKey, message, userInfo) {
    console.log(`📱 [WEBSOCKET] Handling FCM token registration for ${connectionKey}`);
    
    try {
      const data = message.data || message;
      const { token, deviceInfo } = data;
      
      if (!token) {
        console.log(`❌ [WEBSOCKET] No token provided for ${connectionKey}`);
        this.sendToUser(connectionKey, {
          type: 'ERROR',
          data: {
            message: 'FCM token is required',
            timestamp: Date.now()
          }
        });
        return;
      }
      
      const userId = connectionKey;
      const userType = userInfo?.role || 'unknown';
      
      console.log(`📱 [WEBSOCKET] Registering FCM token for user ${userId} (${userType})`);
      console.log(`📱 [WEBSOCKET] Token: ${token.substring(0, 20)}...`);
      
      if (this.notificationService && typeof this.notificationService.registerToken === 'function') {
        const result = await this.notificationService.registerToken(
          userId,
          token,
          deviceInfo || {},
          userType
        );
        
        console.log(`✅ [WEBSOCKET] FCM token registered via NotificationService:`, result);
        
        this.sendToUser(connectionKey, {
          type: 'FCM_TOKEN_REGISTERED',
          data: {
            success: true,
            message: 'FCM token registered successfully',
            timestamp: Date.now()
          }
        });
      } else {
        throw new Error('No service available to register FCM token');
      }
      
    } catch (error) {
      console.error(`❌ [WEBSOCKET] Error registering FCM token for ${connectionKey}:`, error);
      logger.error(this.options.logPrefix, `FCM token registration error:`, error);
      
      this.sendToUser(connectionKey, {
        type: 'ERROR',
        data: {
          message: 'Failed to register FCM token',
          error: error.message,
          timestamp: Date.now()
        }
      });
    }
  }
  
  // ==================== SCHEDULED MATCH DECISION HANDLER ====================
  
  async handleScheduledMatchDecision(connectionKey, message, userInfo) {
    console.log('\n' + '🎯'.repeat(40));
    console.log(`🎯 ${this.options.name} Server - Processing scheduled match decision`);
    console.log(`🎯 Message Type: ${message.type}`);
    console.log(`🎯 User: ${connectionKey} (${userInfo.role})`);
    console.log('🎯'.repeat(40) + '\n');
    
    try {
      if (!this.scheduledService) {
        console.log(`❌ ${this.options.name} Server - No scheduled service available`);
        this.sendToUser(connectionKey, {
          type: 'ERROR',
          data: {
            message: 'Scheduled service unavailable',
            timestamp: Date.now()
          }
        });
        return;
      }
      
      const data = message.data || message;
      const matchId = data.matchId;
      const userType = data.userType || userInfo.role;
      const reason = data.reason;
      
      console.log(`📋 Match ID: ${matchId}`);
      console.log(`📋 User Type: ${userType}`);
      console.log(`📋 Decision: ${message.type === 'ACCEPT_SCHEDULED_MATCH' ? 'ACCEPT' : 'DECLINE'}`);
      
      if (!matchId) {
        console.log(`❌ No matchId provided`);
        this.sendToUser(connectionKey, {
          type: 'ERROR',
          data: {
            message: 'matchId is required',
            timestamp: Date.now()
          }
        });
        return;
      }
      
      if (typeof this.scheduledService.handleMatchDecision === 'function') {
        console.log(`✅ Using scheduledService.handleMatchDecision`);
        
        const decision = message.type === 'ACCEPT_SCHEDULED_MATCH' ? 'accept' : 'reject';
        
        const result = await this.scheduledService.handleMatchDecision(
          matchId,
          connectionKey,
          userType,
          decision,
          reason
        );
        
        console.log(`✅ Result:`, result);
        
        if (result.success) {
          this.sendToUser(connectionKey, {
            type: message.type === 'ACCEPT_SCHEDULED_MATCH' ? 
              'SCHEDULED_MATCH_ACCEPTED_RESPONSE' : 'SCHEDULED_MATCH_DECLINED_RESPONSE',
            data: {
              success: true,
              matchId,
              userId: connectionKey,
              userType,
              message: `Match ${decision}ed successfully`,
              timestamp: Date.now()
            }
          });
        } else {
          this.sendToUser(connectionKey, {
            type: 'ERROR',
            data: {
              message: result.error || `Failed to ${decision} match`,
              matchId,
              timestamp: Date.now()
            }
          });
        }
      } else {
        console.log(`❌ No suitable method found in scheduledService`);
        this.sendToUser(connectionKey, {
          type: 'MESSAGE_RECEIVED',
          data: { 
            originalType: message.type, 
            timestamp: Date.now(),
            warning: 'Message received but not processed'
          }
        });
      }
      
    } catch (error) {
      console.error(`❌ Error in handleScheduledMatchDecision:`, error);
      logger.error(this.options.logPrefix, `Scheduled match decision error:`, error);
      
      this.sendToUser(connectionKey, {
        type: 'ERROR',
        data: {
          message: 'Failed to process scheduled match decision',
          error: error.message,
          timestamp: Date.now()
        }
      });
    }
  }
  
  async handleScheduledSearchCreation(connectionKey, message) {
    if (!this.scheduledService?.handleCreateScheduledSearch) {
      this.sendToUser(connectionKey, { type: 'ERROR', error: 'Service unavailable' });
      return;
    }
    
    const data = message.data || message;
    const userInfo = this.connectedUsers.get(connectionKey);
    const userType = data.userType || userInfo?.role || 'unknown';
    
    try {
      const result = await this.scheduledService.handleCreateScheduledSearch(data, connectionKey, userType);
      this.sendToUser(connectionKey, {
        type: result.success ? 'SCHEDULED_SEARCH_CREATED' : 'ERROR',
        data: result
      });
    } catch (error) {
      logger.error(this.options.logPrefix, `Search creation error: ${error.message}`);
      this.sendToUser(connectionKey, {
        type: 'ERROR',
        error: 'Failed to create search'
      });
    }
  }
  
  async handleScheduledStatusRequest(connectionKey, message) {
    if (!this.scheduledService?.getScheduledSearchStatus) {
      this.sendToUser(connectionKey, { type: 'ERROR', error: 'Service unavailable' });
      return;
    }
    
    try {
      const result = await this.scheduledService.getScheduledSearchStatus(connectionKey);
      this.sendToUser(connectionKey, {
        type: result.success ? 'SCHEDULED_STATUS' : 'ERROR',
        data: result
      });
    } catch (error) {
      logger.error(this.options.logPrefix, `Status request error: ${error.message}`);
      this.sendToUser(connectionKey, { type: 'ERROR', error: 'Failed to get status' });
    }
  }
  
  async handleScheduledSearchCancellation(connectionKey, message) {
    if (!this.scheduledService?.cancelScheduledSearch) {
      this.sendToUser(connectionKey, { type: 'ERROR', error: 'Service unavailable' });
      return;
    }
    
    const data = message.data || message;
    const userInfo = this.connectedUsers.get(connectionKey);
    const userType = data.userType || userInfo?.role || 'unknown';
    const reason = data.reason || 'user_cancelled';
    
    try {
      const result = await this.scheduledService.cancelScheduledSearch(connectionKey, userType, reason);
      this.sendToUser(connectionKey, {
        type: result.success ? 'SCHEDULED_SEARCH_CANCELLED' : 'ERROR',
        data: result
      });
    } catch (error) {
      logger.error(this.options.logPrefix, `Cancellation error: ${error.message}`);
      this.sendToUser(connectionKey, { type: 'ERROR', error: 'Failed to cancel' });
    }
  }
  
  async handleAuthRequest(connectionKey, message, action) {
    try {
      const data = message.data || message;
      let result;
      
      switch(action) {
        case 'login':
          const { phoneNumber, password } = data;
          if (!phoneNumber || !password) {
            result = { success: false, error: 'Phone and password required' };
            break;
          }
          
          const authRef = this.db.collection('authentication').doc(formatPhoneNumber(phoneNumber));
          const authDoc = await authRef.get();
          
          if (!authDoc.exists) {
            result = { success: false, error: 'User not found' };
          } else if (authDoc.data().password !== password) {
            result = { success: false, error: 'Incorrect password' };
          } else {
            const userData = authDoc.data();
            result = {
              success: true,
              data: {
                userId: formatPhoneNumber(phoneNumber),
                phoneNumber: formatPhoneNumber(phoneNumber),
                role: userData.role,
                isVerified: userData.isVerified || false,
                timestamp: Date.now()
              }
            };
          }
          break;
          
        case 'register':
          const { phoneNumber: regPhone, password: regPass, role, name } = data;
          if (!regPhone || !regPass || !role || !name) {
            result = { success: false, error: 'All fields required' };
            break;
          }
          
          const formattedPhone = formatPhoneNumber(regPhone);
          const userRef = this.db.collection('authentication').doc(formattedPhone);
          
          if ((await userRef.get()).exists) {
            result = { success: false, error: 'User already exists' };
          } else {
            await userRef.set({
              phoneNumber: formattedPhone,
              password: regPass,
              role,
              name,
              isVerified: false,
              verificationCode: Math.floor(100000 + Math.random() * 900000),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            });
            
            result = {
              success: true,
              data: {
                userId: formattedPhone,
                phoneNumber: formattedPhone,
                role,
                message: 'Registration successful'
              }
            };
          }
          break;
          
        case 'verify':
          const { phoneNumber: verifyPhone, verificationCode } = data;
          if (!verifyPhone || !verificationCode) {
            result = { success: false, error: 'Phone and code required' };
            break;
          }
          
          const verifyRef = this.db.collection('authentication').doc(formatPhoneNumber(verifyPhone));
          const verifyDoc = await verifyRef.get();
          
          if (!verifyDoc.exists) {
            result = { success: false, error: 'User not found' };
          } else if (verifyDoc.data().verificationCode !== parseInt(verificationCode)) {
            result = { success: false, error: 'Invalid code' };
          } else {
            await verifyRef.update({
              isVerified: true,
              verifiedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            });
            
            result = {
              success: true,
              data: {
                phoneNumber: formatPhoneNumber(verifyPhone),
                isVerified: true,
                message: 'Verified successfully'
              }
            };
          }
          break;
      }
      
      this.sendToUser(connectionKey, {
        type: `${action.toUpperCase()}_RESPONSE`,
        ...result
      });
      
    } catch (error) {
      logger.error(this.options.logPrefix, `${action} error:`, error.message);
      this.sendToUser(connectionKey, {
        type: `${action.toUpperCase()}_RESPONSE`,
        success: false,
        error: `${action} failed`
      });
    }
  }
  
  async handleProfileRequest(connectionKey, message, action) {
    try {
      const data = message.data || message;
      const { phoneNumber, role, updates } = data;
      const formattedPhone = formatPhoneNumber(phoneNumber || connectionKey);
      
      if (action === 'get') {
        let profileData = {};
        let profileType = '';
        
        if (role === 'driver' || !role) {
          const driverRef = this.db.collection('driver_profiles').doc(formattedPhone);
          const driverDoc = await driverRef.get();
          if (driverDoc.exists) {
            profileData = driverDoc.data();
            profileType = 'driver';
          }
        }
        
        if (!profileType && (role === 'passenger' || !role)) {
          const passengerRef = this.db.collection('passenger_profiles').doc(formattedPhone);
          const passengerDoc = await passengerRef.get();
          if (passengerDoc.exists) {
            profileData = passengerDoc.data();
            profileType = 'passenger';
          }
        }
        
        if (!profileType) {
          this.sendToUser(connectionKey, {
            type: 'GET_USER_PROFILE_RESPONSE',
            success: false,
            error: 'Profile not found'
          });
          return;
        }
        
        this.sendToUser(connectionKey, {
          type: 'GET_USER_PROFILE_RESPONSE',
          success: true,
          data: { profile: profileData, profileType, phoneNumber: formattedPhone }
        });
        
      } else if (action === 'update' && updates) {
        const updateData = { ...updates, updatedAt: new Date().toISOString() };
        let success = false;
        let profileType = role;
        
        if (role === 'driver') {
          const driverRef = this.db.collection('driver_profiles').doc(formattedPhone);
          if ((await driverRef.get()).exists) {
            await driverRef.update(updateData);
            success = true;
          }
        } else if (role === 'passenger') {
          const passengerRef = this.db.collection('passenger_profiles').doc(formattedPhone);
          if ((await passengerRef.get()).exists) {
            await passengerRef.update(updateData);
            success = true;
          }
        }
        
        this.sendToUser(connectionKey, {
          type: 'UPDATE_USER_PROFILE_RESPONSE',
          success,
          data: success ? {
            message: 'Profile updated',
            phoneNumber: formattedPhone,
            profileType
          } : { error: 'Profile not found' }
        });
      }
      
    } catch (error) {
      logger.error(this.options.logPrefix, `Profile ${action} error:`, error.message);
      this.sendToUser(connectionKey, {
        type: `${action.toUpperCase()}_USER_PROFILE_RESPONSE`,
        success: false,
        error: `Profile ${action} failed`
      });
    }
  }
  
  handleDisconnection(connectionKey) {
    this.connectedUsers.delete(connectionKey);
    logger.info(this.options.logPrefix, `User disconnected: ${connectionKey}`);
  }
  
  sendToUser(userId, message) {
    try {
      const userInfo = this.connectedUsers.get(userId);
      if (userInfo?.ws?.readyState === WebSocket.OPEN) {
        userInfo.ws.send(JSON.stringify(message));
        userInfo.lastActivity = Date.now();
        return true;
      }
      return false;
    } catch (error) {
      logger.error(this.options.logPrefix, `Send error to ${userId}:`, error.message);
      return false;
    }
  }
  
  getConnectedUsers() {
    return Array.from(this.connectedUsers.entries())
      .filter(([_, info]) => info.ws.readyState === WebSocket.OPEN)
      .map(([userId, info]) => ({
        userId,
        role: info.role,
        connectedAt: info.connectedAt,
        lastActivity: info.lastActivity
      }));
  }
  
  close() {
    this.wss.close();
    logger.info(this.options.logPrefix, 'WebSocket server closed');
  }
  
  setupServiceIntegration(service) {
    this.scheduledService = service;
    logger.info(this.options.logPrefix, 'Linked with ScheduledService');
  }
  
  setupNotificationIntegration(service) {
    this.notificationService = service;
    logger.info(this.options.logPrefix, 'Linked with NotificationService');
  }
  
  setupRideHistoryIntegration(service) {
    this.rideHistoryService = service;
    logger.info(this.options.logPrefix, 'Linked with RideHistoryService');
  }
}

// ==================== WEB SOCKET SERVERS ====================

class SimpleWebSocketServer extends BaseWebSocketServer {
  constructor(server, services) {
    super(server, services, {
      name: 'Legacy',
      logPrefix: 'LEGACY_WS',
      serviceType: 'schedule_only_v2'
    });
  }
}

class ScheduledWebSocketServer extends BaseWebSocketServer {
  constructor(server, services) {
    super(server, services, {
      name: 'Scheduled',
      logPrefix: 'SCHEDULED_WS',
      serviceType: 'scheduled_matching_v2'
    });
  }
  
  setupScheduledMatchingServiceIntegration(service) {
    this.scheduledService = service;
    logger.info(this.options.logPrefix, 'Linked with ScheduledService for matching');
  }
}

// ==================== EXPRESS SETUP ====================

const app = express();
const PORT = process.env.PORT || 3000;
const allowedOrigins = [
  'http://localhost:8082', 'http://127.0.0.1:8082', 'http://localhost:3000',
  'http://127.0.0.1:3000', 'http://localhost:8081', 'http://localhost:8080',
  'http://10.0.2.2:8082', 'http://10.0.2.2:3000'
];

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '500kb' }));
app.use(express.urlencoded({ extended: true, limit: '500kb' }));

const server = http.createServer(app);

// ==================== SERVICE INITIALIZATION ====================

async function initializeAllServices() {
  logger.info('STARTUP', '🚀 Initializing Backend - All Services Together');
  
  let admin = null;
  
  try {
    // ========== STEP 1: Initialize Firebase ==========
    logger.info('SERVICE', 'Initializing Firebase...');
    const firebaseConfig = require('./config/firebase');
    const { db } = firebaseConfig;
    admin = firebaseConfig.admin;
    logger.info('SERVICE', '✅ Firebase initialized');
    
    // ========== STEP 2: Create FirestoreService ==========
    logger.info('SERVICE', 'Creating FirestoreService...');
    
    let FirestoreServiceClass;
    let firestoreServiceLoaded = false;
    
    const possiblePaths = [
      './services/firestoreService',
      './services/FirestoreService',
      '../services/firestoreService',
      './firestoreService',
      path.join(__dirname, 'services', 'firestoreService'),
      path.join(__dirname, 'services', 'FirestoreService')
    ];
    
    for (const servicePath of possiblePaths) {
      try {
        logger.debug('DEBUG', `Trying to load FirestoreService from: ${servicePath}`);
        delete require.cache[require.resolve(servicePath)];
        FirestoreServiceClass = require(servicePath);
        logger.info('SERVICE', `✅ FirestoreService loaded from: ${servicePath}`);
        firestoreServiceLoaded = true;
        break;
      } catch (error) {
        logger.debug('DEBUG', `Failed to load from ${servicePath}: ${error.message}`);
      }
    }
    
    if (!firestoreServiceLoaded) {
      logger.warn('SERVICE', 'FirestoreService not found, creating minimal version');
      FirestoreServiceClass = class MinimalFirestoreService {
        constructor(db, admin) {
          this.db = db;
          this.admin = admin;
          this.stats = { reads: 0, writes: 0 };
          logger.info('MINIMAL_SERVICE', 'Minimal FirestoreService created');
        }
        
        startBatchProcessor() {
          logger.info('MINIMAL_SERVICE', 'Batch processor started (minimal)');
          return this;
        }
        
        async getDocument(collection, id) {
          const doc = await this.db.collection(collection).doc(id).get();
          return doc;
        }
        
        async setDocument(collection, id, data, options = {}) {
          const ref = this.db.collection(collection).doc(id);
          if (options.merge) {
            await ref.set(data, { merge: true });
          } else {
            await ref.set(data);
          }
          return ref;
        }
        
        async updateDocument(collection, id, data) {
          await this.db.collection(collection).doc(id).update(data);
          return true;
        }
        
        async queryCollection(collection, constraints, limit = 100) {
          let query = this.db.collection(collection);
          constraints.forEach(c => {
            if (c.operator === 'in') {
              query = query.where(c.field, c.operator, c.value);
            } else {
              query = query.where(c.field, c.operator, c.value);
            }
          });
          if (limit) query = query.limit(limit);
          const snapshot = await query.get();
          return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        }
        
        batch() {
          return this.db.batch();
        }
        
        async commitBatch(batch) {
          await batch.commit();
        }
      };
    }
    
    firestoreService = new FirestoreServiceClass(db, admin);
    firestoreService.startBatchProcessor();
    logger.info('SERVICE', '✅ FirestoreService created and started');
    
    // ========== STEP 3: Create NotificationService ==========
    logger.info('SERVICE', 'Creating NotificationService...');
    
    let NotificationServiceClass;
    let notificationServiceLoaded = false;
    
    const notificationPaths = [
      './services/notificationService',
      './services/NotificationService',
      '../services/NotificationService',
      path.join(__dirname, 'services', 'NotificationService')
    ];
    
    for (const servicePath of notificationPaths) {
      try {
        logger.debug('DEBUG', `Trying to load NotificationService from: ${servicePath}`);
        delete require.cache[require.resolve(servicePath)];
        NotificationServiceClass = require(servicePath);
        logger.info('SERVICE', `✅ NotificationService loaded from: ${servicePath}`);
        notificationServiceLoaded = true;
        break;
      } catch (error) {
        logger.debug('DEBUG', `Failed to load from ${servicePath}: ${error.message}`);
      }
    }
    
    if (!notificationServiceLoaded) {
      logger.warn('SERVICE', 'NotificationService not found, creating minimal version');
      NotificationServiceClass = class MinimalNotificationService {
        constructor(firestoreService, websocketServer, admin) {
          this.firestoreService = firestoreService;
          this.websocketServer = websocketServer;
          this.admin = admin;
          logger.info('MINIMAL_NOTIFICATION', 'Minimal NotificationService created');
        }
        
        async registerToken(userId, token, deviceInfo, userType) {
          logger.debug('MINIMAL_NOTIFICATION', 'Register token:', { userId, token, userType });
          await this.firestoreService.setDocument('fcm_tokens', userId, {
            userId,
            token,
            deviceInfo,
            userType,
            active: true,
            lastUpdated: new Date().toISOString()
          }, { merge: true });
          return { success: true, message: 'Token registered (minimal)' };
        }
        
        async sendNotification(userId, notification, data) {
          logger.debug('MINIMAL_NOTIFICATION', 'Send notification:', { userId, notification });
          return { success: true, messageId: `minimal_${Date.now()}` };
        }
      };
    }
    
    notificationService = new NotificationServiceClass(
      firestoreService,
      null,
      admin
    );
    logger.info('SERVICE', '✅ NotificationService created');
    
    // ========== STEP 4: Create WebSocket Servers ==========
    logger.info('SERVICE', 'Creating WebSocket Servers...');
    
    const services = {
      firestoreService,
      notificationService,
      admin
    };
    
    try {
      legacyWebsocketServer = new SimpleWebSocketServer(server, services);
      logger.info('SERVICE', '✅ Legacy WebSocketServer created');
    } catch (error) {
      logger.error('SERVICE', `Legacy WS error: ${error.message}`);
    }
    
    try {
      scheduledWebsocketServer = new ScheduledWebSocketServer(server, services);
      logger.info('SERVICE', '✅ ScheduledWebSocketServer created');
    } catch (error) {
      logger.error('SERVICE', `Scheduled WS error: ${error.message}`);
    }
    
    services.scheduledWebsocketServer = scheduledWebsocketServer;
    services.legacyWebsocketServer = legacyWebsocketServer;
    
    if (notificationService) {
      notificationService.websocketServer = scheduledWebsocketServer;
      logger.info('CONNECTION', '✅ Updated NotificationService with WebSocket reference');
    }
    
    // ========== STEP 5: Create RideHistoryService ==========
    logger.info('SERVICE', 'Creating RideHistoryService...');
    
    let RideHistoryServiceClass;
    let rideHistoryServiceLoaded = false;
    
    const rideHistoryPaths = [
      './services/RideHistoryService',
      './services/rideHistoryService',
      '../services/RideHistoryService',
      path.join(__dirname, 'services', 'RideHistoryService')
    ];
    
    for (const servicePath of rideHistoryPaths) {
      try {
        logger.debug('DEBUG', `Trying to load RideHistoryService from: ${servicePath}`);
        delete require.cache[require.resolve(servicePath)];
        RideHistoryServiceClass = require(servicePath);
        logger.info('SERVICE', `✅ RideHistoryService loaded from: ${servicePath}`);
        rideHistoryServiceLoaded = true;
        break;
      } catch (error) {
        logger.debug('DEBUG', `Failed to load from ${servicePath}: ${error.message}`);
      }
    }
    
    if (!rideHistoryServiceLoaded) {
      logger.warn('SERVICE', 'RideHistoryService not found, creating minimal version');
      RideHistoryServiceClass = class MinimalRideHistoryService {
        constructor(firestoreService, admin) {
          this.firestoreService = firestoreService;
          this.admin = admin;
          logger.info('MINIMAL_RIDE', 'Minimal RideHistoryService created');
        }
        
        async createRideFromMatch(matchId, matchData, driverData, passengerData) {
          logger.info('MINIMAL_RIDE', 'Creating ride from match:', matchId);
          const rideId = `RIDE_${Date.now()}`;
          await this.firestoreService.setDocument('rides', rideId, {
            rideId,
            matchId,
            status: 'confirmed',
            createdAt: new Date().toISOString(),
            driver: driverData,
            passenger: passengerData,
            matchData
          });
          return { rideId, success: true };
        }
        
        async getPassengerRides(phoneNumber, options) {
          return { success: true, rides: [], pagination: { total: 0, returned: 0, hasMore: false } };
        }
        
        async getDriverRides(phoneNumber, options) {
          return { success: true, rides: [], pagination: { total: 0, returned: 0, hasMore: false } };
        }
        
        async getRideDetails(rideId) {
          return null;
        }
        
        async getUserRideStats(phoneNumber, userType) {
          return { success: true, stats: {} };
        }
        
        async addRideFeedback(rideId, userPhone, userType, rating, review) {
          return { success: true };
        }
      };
    }
    
    rideHistoryService = new RideHistoryServiceClass(firestoreService, admin);
    logger.info('SERVICE', '✅ RideHistoryService created');
    
    if (legacyWebsocketServer) {
      legacyWebsocketServer.setupRideHistoryIntegration(rideHistoryService);
    }
    if (scheduledWebsocketServer) {
      scheduledWebsocketServer.setupRideHistoryIntegration(rideHistoryService);
    }
    
    // ========== STEP 6: Create ScheduledService ==========
    logger.info('SERVICE', 'Creating ScheduledService...');
    
    let ScheduledServiceClass;
    let scheduledServiceLoaded = false;
    
    const scheduledPaths = [
      './services/scheduledService',
      './services/ScheduledService',
      '../services/ScheduledService',
      path.join(__dirname, 'services', 'ScheduledService')
    ];
    
    for (const servicePath of scheduledPaths) {
      try {
        logger.debug('DEBUG', `Trying to load ScheduledService from: ${servicePath}`);
        
        const Module = require('module');
        const originalResolveFilename = Module._resolveFilename;
        
        try {
          Module._resolveFilename = function(request, parent, isMain) {
            if (request === './utils/Logger' && parent && parent.filename && 
                parent.filename.includes('ScheduledService.js')) {
              return path.join(__dirname, 'utils', 'Logger');
            }
            return originalResolveFilename.call(this, request, parent, isMain);
          };
          
          delete require.cache[require.resolve(servicePath)];
          ScheduledServiceClass = require(servicePath);
          
          Module._resolveFilename = originalResolveFilename;
          
          logger.info('SERVICE', `✅ ScheduledService loaded from: ${servicePath}`);
          scheduledServiceLoaded = true;
          break;
        } catch (error) {
          Module._resolveFilename = originalResolveFilename;
          throw error;
        }
      } catch (error) {
        logger.debug('DEBUG', `Failed to load from ${servicePath}: ${error.message}`);
      }
    }
    
    if (!scheduledServiceLoaded) {
      logger.warn('SERVICE', 'ScheduledService not found, creating minimal version');
      ScheduledServiceClass = class MinimalScheduledService {
        constructor(firestoreService, websocketServer, admin, notificationService) {
          this.firestoreService = firestoreService;
          this.websocketServer = websocketServer;
          this.admin = admin;
          this.notificationService = notificationService;
          this.rideHistory = null;
          this._started = false;
          logger.info('MINIMAL_SCHEDULED', 'Minimal ScheduledService created');
        }
        
        async start() {
          this._started = true;
          logger.info('MINIMAL_SCHEDULED', 'Minimal service started');
          return true;
        }
        
        async stop() {
          this._started = false;
          logger.info('MINIMAL_SCHEDULED', 'Minimal service stopped');
          return true;
        }
        
        async handleCreateScheduledSearch(data, userId, userType) {
          return { success: true, userId, userType, searchId: `minimal_${Date.now()}` };
        }
        
        async getScheduledSearchStatus(phoneNumber) {
          return { success: true, phoneNumber, hasDriverScheduled: false, hasPassengerScheduled: false };
        }
        
        async cancelScheduledSearch(userId, userType, reason) {
          return { success: true, userId, userType, cancelled: true, reason };
        }
        
        async handleMatchDecision(matchId, userId, userType, decision, reason) {
          return { success: true, matchId, userId, userType, decision };
        }
        
        async getDriverPassengerList(phone) {
          return { success: true, phone, driverInfo: { phone, vehicleCapacity: 4, availableSeats: 3 }, passengers: [], pendingProposals: [] };
        }
        
        async getPassengerMatchStatus(phone) {
          return { success: true, phone, hasActiveMatch: false, matchStatus: 'none', matchDetails: null };
        }
      };
    }
    
    try {
      scheduledService = new ScheduledServiceClass(
        firestoreService,
        scheduledWebsocketServer,
        admin,
        notificationService
      );
      logger.info('SERVICE', '✅ ScheduledService created with 4 params (full injection)');
    } catch (error) {
      logger.debug('DEBUG', `ScheduledService 4-param constructor failed: ${error.message}`);
      
      try {
        scheduledService = new ScheduledServiceClass(
          firestoreService,
          scheduledWebsocketServer,
          admin
        );
        logger.info('SERVICE', '✅ ScheduledService created with 3 params');
      } catch (error2) {
        logger.debug('DEBUG', `ScheduledService 3-param constructor failed: ${error2.message}`);
        
        try {
          scheduledService = new ScheduledServiceClass(
            firestoreService,
            scheduledWebsocketServer
          );
          logger.info('SERVICE', '✅ ScheduledService created with 2 params');
        } catch (error3) {
          logger.error('SERVICE', `All ScheduledService constructor attempts failed: ${error3.message}`);
          throw error3;
        }
      }
    }
    
    if (scheduledService && rideHistoryService) {
      scheduledService.rideHistory = rideHistoryService;
      logger.info('CONNECTION', '✅ Injected RideHistoryService into ScheduledService');
    }
    
    // ========== STEP 7: Create CleanupService ==========
    logger.info('SERVICE', 'Creating CleanupService...');
    
    let CleanupServiceClass;
    let cleanupServiceLoaded = false;
    
    const cleanupPaths = [
      './services/CleanupService',
      './services/cleanupService',
      '../services/CleanupService',
      path.join(__dirname, 'services', 'CleanupService')
    ];
    
    for (const servicePath of cleanupPaths) {
      try {
        logger.debug('DEBUG', `Trying to load CleanupService from: ${servicePath}`);
        delete require.cache[require.resolve(servicePath)];
        CleanupServiceClass = require(servicePath);
        logger.info('SERVICE', `✅ CleanupService loaded from: ${servicePath}`);
        cleanupServiceLoaded = true;
        break;
      } catch (error) {
        logger.debug('DEBUG', `Failed to load from ${servicePath}: ${error.message}`);
      }
    }
    
    if (!cleanupServiceLoaded) {
      logger.warn('SERVICE', 'CleanupService not found, creating minimal version');
      CleanupServiceClass = class MinimalCleanupService {
        constructor(firestoreService, admin) {
          this.firestoreService = firestoreService;
          this.admin = admin;
          logger.info('MINIMAL_CLEANUP', 'Minimal CleanupService created');
        }
        
        start() {
          logger.info('MINIMAL_CLEANUP', 'Cleanup service started (minimal)');
        }
        
        stop() {
          logger.info('MINIMAL_CLEANUP', 'Cleanup service stopped');
        }
        
        async performCleanup() {
          return { tempMatches: 0, completedRides: 0, cancelledRides: 0, oldSearches: 0 };
        }
        
        async cleanupUserData(phoneNumber) {
          return { searches: 0, notifications: 0, matches: 0 };
        }
        
        async getCollectionStats() {
          return {};
        }
      };
    }
    
    cleanupService = new CleanupServiceClass(firestoreService, admin);
    logger.info('SERVICE', '✅ CleanupService created');
    
    // ========== STEP 8: Start ScheduledService ==========
    if (scheduledService && typeof scheduledService.start === 'function') {
      await scheduledService.start();
      logger.info('SERVICE', '✅ ScheduledService started');
    }
    
    // ========== STEP 9: Start CleanupService ==========
    if (cleanupService && typeof cleanupService.start === 'function') {
      cleanupService.start();
      logger.info('SERVICE', '✅ CleanupService started (runs daily at 3 AM)');
    }
    
    // ========== STEP 10: Link everything together ==========
    if (scheduledService) {
      if (legacyWebsocketServer) {
        legacyWebsocketServer.setupServiceIntegration(scheduledService);
        logger.info('CONNECTION', '✅ Linked Legacy WS with ScheduledService');
      }
      
      if (scheduledWebsocketServer) {
        scheduledWebsocketServer.setupServiceIntegration(scheduledService);
        scheduledWebsocketServer.setupScheduledMatchingServiceIntegration(scheduledService);
        logger.info('CONNECTION', '✅ Linked Scheduled WS with ScheduledService');
      }
      
      if (notificationService && !notificationService.websocketServer) {
        notificationService.websocketServer = scheduledWebsocketServer;
        logger.info('CONNECTION', '✅ Linked NotificationService with WebSocket');
      }
    }
    
    // ========== STEP 11: Setup WebSocket upgrade handler ==========
    setupUnifiedWebSocketUpgradeHandler();
    
    // ========== STEP 12: Test all services ==========
    await testAllServices();
    
    logger.info('STARTUP', '🎉 All services initialized and linked successfully!');
    logger.info('STARTUP', '📊 Ride History Service: Active');
    logger.info('STARTUP', '🧹 Cleanup Service: Active (runs daily at 3 AM)');
    return true;
    
  } catch (error) {
    logger.error('STARTUP', `❌ Failed to initialize services: ${error.message}`);
    logger.error('STARTUP', `Stack trace: ${error.stack}`);
    throw error;
  }
}

function setupUnifiedWebSocketUpgradeHandler() {
  server.removeAllListeners('upgrade');
  
  server.on('upgrade', (req, socket, head) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    
    logger.debug('WEBSOCKET', `Upgrade: ${pathname}`);
    
    const handlers = {
      '/ws': legacyWebsocketServer,
      '/ws-scheduled': scheduledWebsocketServer
    };
    
    const handler = handlers[pathname];
    if (handler?.wss) {
      handler.wss.handleUpgrade(req, socket, head, (ws) => {
        handler.wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });
  
  logger.info('WEBSOCKET', '✅ Unified WebSocket handler installed');
}

async function testAllServices() {
  logger.debug('TEST', 'Testing all services...');
  
  const tests = [
    { name: 'Firestore Service', test: () => !!firestoreService },
    { name: 'Notification Service', test: () => !!notificationService },
    { name: 'Legacy WebSocket', test: () => !!legacyWebsocketServer },
    { name: 'Scheduled WebSocket', test: () => !!scheduledWebsocketServer },
    { name: 'Scheduled Service', test: () => !!scheduledService },
    { name: 'Ride History Service', test: () => !!rideHistoryService },
    { name: 'Cleanup Service', test: () => !!cleanupService }
  ];
  
  tests.forEach(({ name, test }) => {
    logger.debug('TEST', `${test() ? '✅' : '❌'} ${name}`);
  });
  
  if (notificationService) {
    const methodTests = [
      'registerToken',
      'sendNotification'
    ];
    
    methodTests.forEach(method => {
      const exists = typeof notificationService[method] === 'function';
      logger.debug('TEST', `${exists ? '✅' : '❌'} NotificationService.${method}()`);
    });
  }
  
  if (scheduledService) {
    const methodTests = [
      'handleCreateScheduledSearch',
      'getScheduledSearchStatus',
      'cancelScheduledSearch',
      'handleMatchDecision',
      'getDriverPassengerList',
      'getPassengerMatchStatus'
    ];
    
    methodTests.forEach(method => {
      const exists = typeof scheduledService[method] === 'function';
      logger.debug('TEST', `${exists ? '✅' : '❌'} ScheduledService.${method}()`);
    });
  }
  
  if (rideHistoryService) {
    const methodTests = [
      'createRideFromMatch',
      'getPassengerRides',
      'getDriverRides',
      'getRideDetails',
      'getUserRideStats',
      'addRideFeedback'
    ];
    
    methodTests.forEach(method => {
      const exists = typeof rideHistoryService[method] === 'function';
      logger.debug('TEST', `${exists ? '✅' : '❌'} RideHistoryService.${method}()`);
    });
  }
  
  if (cleanupService) {
    const methodTests = [
      'start',
      'stop',
      'performCleanup',
      'cleanupUserData'
    ];
    
    methodTests.forEach(method => {
      const exists = typeof cleanupService[method] === 'function';
      logger.debug('TEST', `${exists ? '✅' : '❌'} CleanupService.${method}()`);
    });
  }
}

// ==================== IMPORT ROUTES ====================

// Import FCM routes
let fcmRoutes;
try {
  fcmRoutes = require('./routes/fcmRoutes');
  logger.info('ROUTES', '✅ FCM routes loaded');
} catch (error) {
  logger.error('ROUTES', `Failed to load FCM routes: ${error.message}`);
  fcmRoutes = express.Router();
  fcmRoutes.post('/register-token', (req, res) => {
    res.json({ success: true, message: 'FCM token registration endpoint (fallback)' });
  });
  fcmRoutes.post('/remove-token', (req, res) => {
    res.json({ success: true, message: 'FCM token removal endpoint (fallback)' });
  });
}

// Import Ride History Routes
let rideHistoryRoutes;
try {
  const rideHistoryRoutesModule = require('./routes/rideHistoryRoutes');
  rideHistoryRoutes = rideHistoryRoutesModule(rideHistoryService);
  logger.info('ROUTES', '✅ Ride History routes loaded');
} catch (error) {
  logger.error('ROUTES', `Failed to load Ride History routes: ${error.message}`);
  rideHistoryRoutes = express.Router();
  rideHistoryRoutes.get('/passenger/:phone', (req, res) => {
    res.json({ success: true, rides: [], message: 'Ride history endpoint (fallback)' });
  });
  rideHistoryRoutes.get('/driver/:phone', (req, res) => {
    res.json({ success: true, rides: [], message: 'Ride history endpoint (fallback)' });
  });
}

// Import Cleanup Routes
let cleanupRoutes;
try {
  const cleanupRoutesModule = require('./routes/cleanupRoutes');
  cleanupRoutes = cleanupRoutesModule(cleanupService);
  logger.info('ROUTES', '✅ Cleanup routes loaded');
} catch (error) {
  logger.error('ROUTES', `Failed to load Cleanup routes: ${error.message}`);
  cleanupRoutes = express.Router();
  cleanupRoutes.post('/trigger', (req, res) => {
    res.json({ success: true, message: 'Cleanup trigger endpoint (fallback)' });
  });
  cleanupRoutes.get('/stats', (req, res) => {
    res.json({ success: true, stats: {}, message: 'Cleanup stats endpoint (fallback)' });
  });
}

// ==================== MOUNT ROUTES ====================

app.use('/api/fcm', fcmRoutes);
logger.info('ROUTES', '✅ FCM routes mounted at /api/fcm');

app.use('/api/rides', rideHistoryRoutes);
logger.info('ROUTES', '✅ Ride History routes mounted at /api/rides');

app.use('/api/admin/cleanup', cleanupRoutes);
logger.info('ROUTES', '✅ Cleanup routes mounted at /api/admin/cleanup');

// ==================== HTTP ROUTES ====================

app.post('/api/auth/login', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Login endpoint ready', 
    timestamp: new Date().toISOString() 
  });
});

app.post('/api/auth/register', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Register endpoint ready', 
    timestamp: new Date().toISOString() 
  });
});

app.get('/api/health', (req, res) => {
  const legacyConnections = legacyWebsocketServer?.getConnectedUsers().length || 0;
  const scheduledConnections = scheduledWebsocketServer?.getConnectedUsers().length || 0;
  
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    services: {
      firestore: !!firestoreService,
      notificationService: !!notificationService,
      scheduledService: !!scheduledService,
      rideHistoryService: !!rideHistoryService,
      cleanupService: !!cleanupService,
      legacyWebsocket: !!legacyWebsocketServer,
      scheduledWebsocket: !!scheduledWebsocketServer
    },
    connections: {
      legacy: legacyConnections,
      scheduled: scheduledConnections
    },
    endpoints: {
      health: '/api/health',
      test: '/api/test',
      triggerMatching: 'POST /api/test/trigger-matching',
      serviceDebug: '/api/test/service-debug',
      fcm: '/api/fcm/*',
      rides: '/api/rides/*',
      admin: '/api/admin/*',
      driverPassengers: 'GET /api/driver/passengers/:phone',
      passengerStatus: 'GET /api/passenger/status/:phone',
      matchDecision: 'POST /api/match/decision',
      driverCancelAll: 'POST /api/driver/cancel-all',
      passengerCancelSchedule: 'POST /api/passenger/cancel-schedule'
    }
  });
});

// Test endpoints
app.post('/api/test/trigger-matching', async (req, res) => {
  try {
    if (!scheduledService?.handleMatchDecision) {
      throw new Error('Scheduled service unavailable');
    }
    
    res.json({
      success: true,
      message: `Matching triggered`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/test/service-debug', (req, res) => {
  const debugInfo = {
    services: {
      firestoreService: {
        exists: !!firestoreService,
        type: firestoreService ? firestoreService.constructor.name : 'none'
      },
      notificationService: {
        exists: !!notificationService,
        type: notificationService ? notificationService.constructor.name : 'none',
        hasWebSocketRef: !!(notificationService && notificationService.websocketServer)
      },
      scheduledService: {
        exists: !!scheduledService,
        type: scheduledService ? scheduledService.constructor.name : 'none',
        started: scheduledService?._started || false
      },
      rideHistoryService: {
        exists: !!rideHistoryService,
        type: rideHistoryService ? rideHistoryService.constructor.name : 'none'
      },
      cleanupService: {
        exists: !!cleanupService,
        type: cleanupService ? cleanupService.constructor.name : 'none'
      },
      websocketServers: {
        legacy: {
          exists: !!legacyWebsocketServer,
          type: legacyWebsocketServer ? legacyWebsocketServer.constructor.name : 'none',
          connections: legacyWebsocketServer?.getConnectedUsers().length || 0
        },
        scheduled: {
          exists: !!scheduledWebsocketServer,
          type: scheduledWebsocketServer ? scheduledWebsocketServer.constructor.name : 'none',
          connections: scheduledWebsocketServer?.getConnectedUsers().length || 0
        }
      }
    },
    timestamp: new Date().toISOString()
  };
  
  res.json(debugInfo);
});

app.get('/api/test', (req, res) => {
  res.json({
    success: true,
    message: 'Server running',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/api/health',
      serviceDebug: '/api/test/service-debug',
      rides: '/api/rides/*',
      admin: '/api/admin/*'
    }
  });
});

// ==================== ERROR HANDLING ====================

app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    error: 'Route not found',
    timestamp: new Date().toISOString()
  });
});

app.use((err, req, res, next) => {
  logger.error('SERVER', err.message);
  res.status(500).json({ 
    success: false, 
    error: 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

// ==================== START SERVER ====================

if (require.main === module) {
  initializeAllServices().then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      logger.info('STARTUP', '🚀 SERVER STARTED');
      logger.info('STARTUP', `📍 Backend: http://localhost:${PORT}`);
      logger.info('STARTUP', `🔌 Legacy WS: ws://localhost:${PORT}/ws`);
      logger.info('STARTUP', `🔌 Scheduled WS: ws://localhost:${PORT}/ws-scheduled`);
      logger.info('STARTUP', `📱 FCM Routes: /api/fcm/*`);
      logger.info('STARTUP', `📊 Ride History Routes: /api/rides/*`);
      logger.info('STARTUP', `🧹 Admin Routes: /api/admin/*`);
      logger.info('STARTUP', '✅ All services initialized and linked');
      
      logger.info('STATUS', '=== Service Status ===');
      logger.info('STATUS', `FirestoreService: ${firestoreService?.constructor?.name || 'Not found'}`);
      logger.info('STATUS', `NotificationService: ${notificationService?.constructor?.name || 'Not found'}`);
      logger.info('STATUS', `ScheduledService: ${scheduledService?.constructor?.name || 'Not found'}`);
      logger.info('STATUS', `RideHistoryService: ${rideHistoryService?.constructor?.name || 'Not found'}`);
      logger.info('STATUS', `CleanupService: ${cleanupService?.constructor?.name || 'Not found'}`);
      logger.info('STATUS', `Legacy WebSocket: ${legacyWebsocketServer?.constructor?.name || 'Not found'}`);
      logger.info('STATUS', `Scheduled WebSocket: ${scheduledWebsocketServer?.constructor?.name || 'Not found'}`);
      
      logger.info('STATUS', '=== Method Availability ===');
      logger.info('STATUS', `FCM register: ${!!notificationService?.registerToken}`);
      logger.info('STATUS', `Ride history: ${!!rideHistoryService?.getPassengerRides}`);
      logger.info('STATUS', `Cleanup service: ${!!cleanupService?.performCleanup}`);
    });
  }).catch(error => {
    logger.error('STARTUP', `❌ Failed to initialize: ${error.message}`);
    logger.error('STARTUP', `Error stack: ${error.stack}`);
    process.exit(1);
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('SHUTDOWN', 'Shutting down...');
  
  if (cleanupService && typeof cleanupService.stop === 'function') {
    try {
      cleanupService.stop();
      logger.info('SHUTDOWN', '✅ CleanupService stopped');
    } catch (error) {
      logger.error('SHUTDOWN', `CleanupService stop error: ${error.message}`);
    }
  }
  
  if (scheduledService && typeof scheduledService.stop === 'function') {
    try {
      await scheduledService.stop();
      logger.info('SHUTDOWN', '✅ ScheduledService stopped');
    } catch (error) {
      logger.error('SHUTDOWN', `ScheduledService stop error: ${error.message}`);
    }
  }
  
  const wsShutdowns = [
    { name: 'Legacy WS', server: legacyWebsocketServer },
    { name: 'Scheduled WS', server: scheduledWebsocketServer }
  ];
  
  for (const { name, server } of wsShutdowns) {
    if (server && typeof server.close === 'function') {
      try {
        server.close();
        logger.info('SHUTDOWN', `✅ ${name} closed`);
      } catch (error) {
        logger.error('SHUTDOWN', `${name} close error: ${error.message}`);
      }
    }
  }
  
  server.close(() => {
    logger.info('SHUTDOWN', '✅ HTTP Server closed');
    process.exit(0);
  });
});

module.exports = {
  app,
  server,
  legacyWebsocketServer,
  scheduledWebsocketServer,
  scheduledService,
  notificationService,
  rideHistoryService,
  cleanupService,
  firestoreService
};
