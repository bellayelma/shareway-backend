// app.js - COMPLETE VERSION WITH ALL THREE SERVICES PROPERLY INITIALIZED TOGETHER
// MODULAR FCM ROUTES, GROUP RIDE ENDPOINTS, DRIVER CANCELLATION ENDPOINTS,
// PASSENGER CANCELLATION ENDPOINTS, AND WEBSOCKET FCM TOKEN REGISTRATION

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
  ['INFO', 'SCHEDULED', 'STARTUP', 'SERVICE', 'CONNECTION', 'ENDPOINT', 'ERRORS', 'DEBUG', 'FCM', 'NOTIFICATIONS']
    .forEach(module => logger.enableModule(module, true));
};
enableLogModules();

// Global variables
let legacyWebsocketServer = null;
let scheduledWebsocketServer = null;
let firestoreService = null;
let scheduledService = null;
let notificationService = null;

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
  // Remove all non-digit characters except leading +
  return phone.replace(/[^\d+]/g, '');
}

// ==================== BASE WEBSOCKET SERVER ====================

class BaseWebSocketServer {
  constructor(server, services, options = {}) {
    this.firestoreService = services.firestoreService;
    this.scheduledService = services.scheduledService;
    this.notificationService = services.notificationService;
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
      
      // Close existing connection
      if (this.connectedUsers.has(connectionKey)) {
        const existing = this.connectedUsers.get(connectionKey);
        try { existing.ws.close(1000, 'New connection'); } catch (e) {}
      }
      
      this.connectedUsers.set(connectionKey, userInfo);
      
      // Send connection confirmation
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
      
      // Setup message handlers
      ws.on('message', (data) => this.handleMessage(connectionKey, data));
      ws.on('close', () => this.handleDisconnection(connectionKey));
      ws.on('error', (error) => {
        logger.error(this.options.logPrefix, `Error for ${connectionKey}:`, error.message);
        this.handleDisconnection(connectionKey);
      });
      
      // Keep alive
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
      
      // Route to appropriate handler
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
      
      // ========== FCM TOKEN REGISTRATION ==========
      'REGISTER_FCM_TOKEN': () => this.handleFCMTokenRegistration(connectionKey, message, userInfo)
      // ============================================
    };
    
    // ==================== ADD SCHEDULED MATCH HANDLERS TO BOTH SERVERS ====================
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
  
  // ==================== FCM TOKEN REGISTRATION HANDLER ====================
  /**
   * Handle FCM token registration from client
   */
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
      
      // Get user info
      const userId = connectionKey; // Already formatted phone number
      const userType = userInfo?.role || 'unknown';
      
      console.log(`📱 [WEBSOCKET] Registering FCM token for user ${userId} (${userType})`);
      console.log(`📱 [WEBSOCKET] Token: ${token.substring(0, 20)}...`);
      console.log(`📱 [WEBSOCKET] Device Info:`, deviceInfo);
      
      // Use notificationService to register the token (primary method)
      if (this.notificationService && typeof this.notificationService.registerToken === 'function') {
        const result = await this.notificationService.registerToken(
          userId,
          token,
          deviceInfo || {},
          userType
        );
        
        console.log(`✅ [WEBSOCKET] FCM token registered via NotificationService:`, result);
        
        // Send confirmation back to client
        this.sendToUser(connectionKey, {
          type: 'FCM_TOKEN_REGISTERED',
          data: {
            success: true,
            message: 'FCM token registered successfully',
            timestamp: Date.now()
          }
        });
      } 
      // Fallback to scheduledService.registerFCMToken
      else if (this.scheduledService && typeof this.scheduledService.registerFCMToken === 'function') {
        const result = await this.scheduledService.registerFCMToken(
          userId,
          token,
          deviceInfo || {},
          userType
        );
        
        console.log(`✅ [WEBSOCKET] FCM token registered via ScheduledService:`, result);
        
        this.sendToUser(connectionKey, {
          type: 'FCM_TOKEN_REGISTERED',
          data: {
            success: true,
            message: 'FCM token registered successfully',
            timestamp: Date.now()
          }
        });
      } 
      // Try storeFCMToken as fallback
      else if (this.scheduledService && typeof this.scheduledService.storeFCMToken === 'function') {
        console.log(`📱 [WEBSOCKET] Using storeFCMToken fallback`);
        
        const result = await this.scheduledService.storeFCMToken(
          userId,
          token,
          deviceInfo || {}
        );
        
        console.log(`✅ [WEBSOCKET] FCM token stored via storeFCMToken:`, result);
        
        this.sendToUser(connectionKey, {
          type: 'FCM_TOKEN_REGISTERED',
          data: {
            success: true,
            message: 'FCM token stored successfully',
            timestamp: Date.now()
          }
        });
      }
      // Fallback: try to use firestoreService directly
      else if (this.firestoreService && this.firestoreService.db) {
        console.log(`📱 [WEBSOCKET] Using direct Firestore fallback`);
        
        try {
          const db = this.firestoreService.db;
          const FCM_TOKENS = 'fcm_tokens';
          const sanitizedUserId = sanitizePhoneNumber(userId);
          const now = new Date().toISOString();
          
          // Store in fcm_tokens collection
          await db.collection(FCM_TOKENS).doc(sanitizedUserId).set({
            userId: sanitizedUserId,
            originalUserId: userId,
            token: token,
            deviceInfo: deviceInfo || {},
            active: true,
            platform: deviceInfo?.platform || 'unknown',
            lastUpdated: now,
            lastUsed: now,
            createdAt: now,
            userType: userType
          }, { merge: true });
          
          console.log(`✅ [WEBSOCKET] FCM token stored directly in Firestore`);
          
          this.sendToUser(connectionKey, {
            type: 'FCM_TOKEN_REGISTERED',
            data: {
              success: true,
              message: 'FCM token registered successfully (fallback)',
              timestamp: Date.now()
            }
          });
        } catch (dbError) {
          console.error(`❌ [WEBSOCKET] Firestore fallback error:`, dbError);
          throw dbError;
        }
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
  
  // ==================== NEW HANDLER FOR SCHEDULED MATCH DECISIONS ====================
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
      
      // Check if scheduledService has the method
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
        
        // Send appropriate response
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
      } 
      // Fallback to individual methods
      else if (message.type === 'ACCEPT_SCHEDULED_MATCH' && 
               typeof this.scheduledService.acceptScheduledMatch === 'function') {
        console.log(`✅ Using scheduledService.acceptScheduledMatch`);
        
        const result = await this.scheduledService.acceptScheduledMatch(
          matchId,
          connectionKey,
          userType
        );
        
        this.sendToUser(connectionKey, {
          type: 'SCHEDULED_MATCH_ACCEPTED_RESPONSE',
          data: {
            success: result.success,
            matchId,
            userId: connectionKey,
            userType,
            message: result.success ? 'Match accepted' : result.error,
            timestamp: Date.now()
          }
        });
      }
      else if (message.type === 'DECLINE_SCHEDULED_MATCH' && 
               typeof this.scheduledService.declineScheduledMatch === 'function') {
        console.log(`✅ Using scheduledService.declineScheduledMatch`);
        
        const result = await this.scheduledService.declineScheduledMatch(
          matchId,
          connectionKey,
          userType,
          reason
        );
        
        this.sendToUser(connectionKey, {
          type: 'SCHEDULED_MATCH_DECLINED_RESPONSE',
          data: {
            success: result.success,
            matchId,
            userId: connectionKey,
            userType,
            reason,
            message: result.success ? 'Match declined' : result.error,
            timestamp: Date.now()
          }
        });
      }
      else {
        console.log(`❌ No suitable method found in scheduledService`);
        console.log(`Available methods:`, Object.keys(this.scheduledService));
        
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
  
  // Specific method for ScheduledWebSocketServer to link with scheduled service
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

// Middleware
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '500kb' }));
app.use(express.urlencoded({ extended: true, limit: '500kb' }));

const server = http.createServer(app);

// ==================== SERVICE INITIALIZATION ====================

/**
 * Initialize all three services together in the correct order:
 * 1. FirestoreService (no dependencies)
 * 2. NotificationService (depends on FirestoreService)
 * 3. WebSocket Servers (depends on FirestoreService)
 * 4. ScheduledService (depends on all above)
 * 5. Link everything together
 */
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
    
    // Try multiple possible locations for FirestoreService
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
      // Create a minimal FirestoreService if not found
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
      };
    }
    
    // Create FirestoreService instance
    firestoreService = new FirestoreServiceClass(db, admin);
    firestoreService.startBatchProcessor();
    logger.info('SERVICE', '✅ FirestoreService created and started');
    
    // ========== STEP 3: Create NotificationService (depends on FirestoreService) ==========
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
          return { success: true, message: 'Token registered (minimal)' };
        }
        
        async sendNotification(userId, notification, data) {
          logger.debug('MINIMAL_NOTIFICATION', 'Send notification:', { userId, notification });
          return { success: true, messageId: `minimal_${Date.now()}` };
        }
        
        async sendToDriver(driverPhone, notification, data) {
          logger.debug('MINIMAL_NOTIFICATION', 'Send to driver:', { driverPhone, notification });
          return { success: true };
        }
        
        async sendToPassenger(passengerPhone, notification, data) {
          logger.debug('MINIMAL_NOTIFICATION', 'Send to passenger:', { passengerPhone, notification });
          return { success: true };
        }
        
        async sendToMultipleUsers(userIds, notification, data) {
          logger.debug('MINIMAL_NOTIFICATION', 'Send to multiple:', { userIds, notification });
          return { success: true, results: [] };
        }
        
        async removeToken(userId, token) {
          logger.debug('MINIMAL_NOTIFICATION', 'Remove token:', { userId, token });
          return { success: true };
        }
        
        async getUserTokens(userId) {
          logger.debug('MINIMAL_NOTIFICATION', 'Get user tokens:', userId);
          return { success: true, tokens: [] };
        }
      };
    }
    
    // Create NotificationService instance (websocketServer will be added later)
    notificationService = new NotificationServiceClass(
      firestoreService,
      null, // websocket will be added after creation
      admin
    );
    logger.info('SERVICE', '✅ NotificationService created');
    
    // ========== STEP 4: Create WebSocket Servers ==========
    logger.info('SERVICE', 'Creating WebSocket Servers...');
    
    const services = {
      firestoreService,
      notificationService, // Pass notification service to websockets
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
    
    // Update services object with websocket servers
    services.scheduledWebsocketServer = scheduledWebsocketServer;
    services.legacyWebsocketServer = legacyWebsocketServer;
    
    // Update notification service with WebSocket reference
    if (notificationService) {
      notificationService.websocketServer = scheduledWebsocketServer;
      logger.info('CONNECTION', '✅ Updated NotificationService with WebSocket reference');
    }
    
    // ========== STEP 5: Create ScheduledService (depends on all above) ==========
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
        
        // Temporarily modify module resolution to handle path issues
        const Module = require('module');
        const originalResolveFilename = Module._resolveFilename;
        
        try {
          // Override module resolution to handle relative paths
          Module._resolveFilename = function(request, parent, isMain) {
            if (request === './utils/Logger' && parent && parent.filename && 
                parent.filename.includes('ScheduledService.js')) {
              const resolvedPath = path.join(__dirname, 'utils', 'Logger');
              return resolvedPath;
            }
            return originalResolveFilename.call(this, request, parent, isMain);
          };
          
          delete require.cache[require.resolve(servicePath)];
          ScheduledServiceClass = require(servicePath);
          
          // Restore original resolution
          Module._resolveFilename = originalResolveFilename;
          
          logger.info('SERVICE', `✅ ScheduledService loaded from: ${servicePath}`);
          scheduledServiceLoaded = true;
          break;
        } catch (error) {
          // Restore original resolution
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
        
        async performScheduledMatchingCycle(windowName) {
          return { success: true, window: windowName, matched: 0, checked: 0 };
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
    
    // Try different constructor signatures
    try {
      // Try with 4 parameters (full injection)
      scheduledService = new ScheduledServiceClass(
        firestoreService,
        scheduledWebsocketServer,
        admin,
        notificationService // Inject notification service
      );
      logger.info('SERVICE', '✅ ScheduledService created with 4 params (full injection)');
    } catch (error) {
      logger.debug('DEBUG', `ScheduledService 4-param constructor failed: ${error.message}`);
      
      try {
        // Try with 3 parameters
        scheduledService = new ScheduledServiceClass(
          firestoreService,
          scheduledWebsocketServer,
          admin
        );
        logger.info('SERVICE', '✅ ScheduledService created with 3 params');
      } catch (error2) {
        logger.debug('DEBUG', `ScheduledService 3-param constructor failed: ${error2.message}`);
        
        try {
          // Try with 2 parameters
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
    
    // ========== STEP 6: Start ScheduledService ==========
    if (scheduledService && typeof scheduledService.start === 'function') {
      await scheduledService.start();
      logger.info('SERVICE', '✅ ScheduledService started');
    }
    
    // ========== STEP 7: Link everything together ==========
    if (scheduledService) {
      // Link websocket servers with scheduled service
      if (legacyWebsocketServer) {
        legacyWebsocketServer.setupServiceIntegration(scheduledService);
        logger.info('CONNECTION', '✅ Linked Legacy WS with ScheduledService');
      }
      
      if (scheduledWebsocketServer) {
        scheduledWebsocketServer.setupServiceIntegration(scheduledService);
        scheduledWebsocketServer.setupScheduledMatchingServiceIntegration(scheduledService);
        logger.info('CONNECTION', '✅ Linked Scheduled WS with ScheduledService');
      }
      
      // Ensure notification service has websocket reference
      if (notificationService && !notificationService.websocketServer) {
        notificationService.websocketServer = scheduledWebsocketServer;
        logger.info('CONNECTION', '✅ Linked NotificationService with WebSocket');
      }
    }
    
    // ========== STEP 8: Setup WebSocket upgrade handler ==========
    setupUnifiedWebSocketUpgradeHandler();
    
    // ========== STEP 9: Test all services ==========
    await testAllServices();
    
    logger.info('STARTUP', '🎉 All services initialized and linked successfully!');
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
    { name: 'Scheduled Service', test: () => !!scheduledService }
  ];
  
  tests.forEach(({ name, test }) => {
    logger.debug('TEST', `${test() ? '✅' : '❌'} ${name}`);
  });
  
  // Test service methods
  if (notificationService) {
    const methodTests = [
      'registerToken',
      'sendNotification',
      'sendToDriver',
      'sendToPassenger',
      'sendToMultipleUsers',
      'removeToken',
      'getUserTokens'
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
      'performScheduledMatchingCycle',
      'handleMatchDecision',
      'getDriverPassengerList',
      'getPassengerMatchStatus',
      'handleDriverCancelAll',
      'handleDriverCancelPassenger',
      'getDriverAcceptedPassengers',
      'handlePassengerCancelSchedule',
      'handlePassengerCancelRide',
      'handlePassengerMatchDecision'
    ];
    
    methodTests.forEach(method => {
      const exists = typeof scheduledService[method] === 'function';
      logger.debug('TEST', `${exists ? '✅' : '❌'} ScheduledService.${method}()`);
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
  // Create fallback FCM routes
  fcmRoutes = express.Router();
  fcmRoutes.post('/register-token', (req, res) => {
    res.json({ success: true, message: 'FCM token registration endpoint (fallback)' });
  });
  fcmRoutes.post('/remove-token', (req, res) => {
    res.json({ success: true, message: 'FCM token removal endpoint (fallback)' });
  });
}

// ==================== MOUNT ROUTES ====================

// Mount FCM routes
app.use('/api/fcm', fcmRoutes);
logger.info('ROUTES', '✅ FCM routes mounted at /api/fcm');

// ==================== HTTP ROUTES ====================

// Authentication endpoints
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

// Health endpoint
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
      
      // GROUP RIDE ENDPOINTS
      driverPassengers: 'GET /api/driver/passengers/:phone',
      passengerStatus: 'GET /api/passenger/status/:phone',
      matchDecision: 'POST /api/match/decision',
      driverAvailableSeats: 'GET /api/driver/available-seats/:phone',
      driverPendingProposals: 'GET /api/driver/pending-proposals/:phone',
      
      // DRIVER CANCELLATION ENDPOINTS
      driverCancelAll: 'POST /api/driver/cancel-all',
      driverCancelPassenger: 'POST /api/driver/cancel-passenger',
      driverAcceptedPassengers: 'GET /api/driver/accepted-passengers/:driverPhone',
      
      // PASSENGER CANCELLATION ENDPOINTS
      passengerCancelSchedule: 'POST /api/passenger/cancel-schedule',
      passengerMatchDecision: 'POST /api/passenger/match-decision',
      passengerRideStatus: 'GET /api/passenger/ride-status/:passengerPhone'
    }
  });
});

// Schedule endpoints
app.post('/api/schedule/search', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Schedule search endpoint ready', 
    timestamp: new Date().toISOString() 
  });
});

app.get('/api/schedule/status/:phoneNumber', (req, res) => {
  res.json({ 
    success: true, 
    phoneNumber: req.params.phoneNumber,
    message: 'Schedule status endpoint ready',
    timestamp: new Date().toISOString() 
  });
});

// ==================== SCHEDULED SEARCH HTTP ENDPOINTS ====================

app.post('/api/scheduled-search/create', async (req, res) => {
  try {
    if (!scheduledService?.handleCreateScheduledSearch) {
      return res.status(503).json({ 
        success: false, 
        error: 'Scheduled service unavailable',
        timestamp: new Date().toISOString()
      });
    }
    
    const { userId, userType, ...data } = req.body;
    
    // Extract data from type+data format if needed
    let searchData = req.body;
    if (req.body.type && req.body.data) {
      searchData = req.body.data;
    }
    
    // Get user ID and type
    const actualUserId = userId || searchData.userId;
    const actualUserType = userType || searchData.userType;
    
    if (!actualUserId || !actualUserType) {
      return res.status(400).json({
        success: false,
        error: 'userId and userType are required',
        timestamp: new Date().toISOString()
      });
    }
    
    logger.info('ENDPOINT', `Creating scheduled search for ${actualUserId} (${actualUserType})`);
    
    const result = await scheduledService.handleCreateScheduledSearch(
      searchData, 
      actualUserId, 
      actualUserType
    );
    
    res.json({
      ...result,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('ENDPOINT', `Create scheduled search error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/scheduled-search/status/:phoneNumber', async (req, res) => {
  try {
    if (!scheduledService?.getScheduledSearchStatus) {
      return res.status(503).json({ 
        success: false, 
        error: 'Scheduled service unavailable',
        timestamp: new Date().toISOString()
      });
    }
    
    const phoneNumber = req.params.phoneNumber;
    logger.info('ENDPOINT', `Getting scheduled status for: ${phoneNumber}`);
    
    const result = await scheduledService.getScheduledSearchStatus(phoneNumber);
    
    res.json({
      ...result,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('ENDPOINT', `Get scheduled status error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/scheduled-search/cancel', async (req, res) => {
  try {
    if (!scheduledService?.cancelScheduledSearch) {
      return res.status(503).json({ 
        success: false, 
        error: 'Scheduled service unavailable',
        timestamp: new Date().toISOString()
      });
    }
    
    const { phoneNumber, userType, reason = 'user_cancelled' } = req.body;
    
    if (!phoneNumber || !userType) {
      return res.status(400).json({
        success: false,
        error: 'phoneNumber and userType are required',
        timestamp: new Date().toISOString()
      });
    }
    
    logger.info('ENDPOINT', `Cancelling scheduled search for ${phoneNumber} (${userType})`);
    
    const result = await scheduledService.cancelScheduledSearch(
      phoneNumber, 
      userType, 
      reason
    );
    
    res.json({
      ...result,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('ENDPOINT', `Cancel scheduled search error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/scheduled-search/stats', async (req, res) => {
  try {
    if (!scheduledService?.getStats) {
      return res.status(503).json({ 
        success: false, 
        error: 'Scheduled service unavailable',
        timestamp: new Date().toISOString()
      });
    }
    
    logger.info('ENDPOINT', 'Getting scheduled search stats');
    
    const result = await scheduledService.getStats();
    
    res.json({
      ...result,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('ENDPOINT', `Get stats error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Accept match endpoint
app.post('/api/scheduled-matches/accept', async (req, res) => {
  try {
    if (!scheduledService?.acceptScheduledMatch) {
      return res.status(503).json({ 
        success: false, 
        error: 'Scheduled service unavailable',
        timestamp: new Date().toISOString()
      });
    }
    
    const { matchId, userId, userType } = req.body;
    
    if (!matchId || !userId || !userType) {
      return res.status(400).json({
        success: false,
        error: 'matchId, userId, and userType are required',
        timestamp: new Date().toISOString()
      });
    }
    
    logger.info('ENDPOINT', `Accepting match ${matchId} for ${userId} (${userType})`);
    
    const result = await scheduledService.acceptScheduledMatch(matchId, userId, userType);
    
    res.json({
      ...result,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('ENDPOINT', `Accept match error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ==================== GROUP RIDE ENDPOINTS ====================

/**
 * Get driver's accepted passenger list (for Flutter app)
 */
app.get('/api/driver/passengers/:phone', async (req, res) => {
  try {
    if (!scheduledService?.getDriverPassengerList) {
      return res.status(503).json({ 
        success: false, 
        error: 'Scheduled service unavailable',
        timestamp: new Date().toISOString()
      });
    }
    
    const phone = req.params.phone;
    logger.info('ENDPOINT', `Getting passenger list for driver: ${phone}`);
    
    const result = await scheduledService.getDriverPassengerList(phone);
    
    res.json({
      ...result,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('ENDPOINT', `Get driver passengers error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Get passenger's match status
 */
app.get('/api/passenger/status/:phone', async (req, res) => {
  try {
    if (!scheduledService?.getPassengerMatchStatus) {
      return res.status(503).json({ 
        success: false, 
        error: 'Scheduled service unavailable',
        timestamp: new Date().toISOString()
      });
    }
    
    const phone = req.params.phone;
    logger.info('ENDPOINT', `Getting match status for passenger: ${phone}`);
    
    const result = await scheduledService.getPassengerMatchStatus(phone);
    
    res.json({
      ...result,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('ENDPOINT', `Get passenger status error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Handle match decision (accept/reject)
 */
app.post('/api/match/decision', async (req, res) => {
  try {
    if (!scheduledService?.handleMatchDecision) {
      return res.status(503).json({ 
        success: false, 
        error: 'Scheduled service unavailable',
        timestamp: new Date().toISOString()
      });
    }
    
    const { matchId, userPhone, userType, decision, reason } = req.body;
    
    if (!matchId || !userPhone || !userType || !decision) {
      return res.status(400).json({
        success: false,
        error: 'matchId, userPhone, userType, and decision are required',
        timestamp: new Date().toISOString()
      });
    }
    
    logger.info('ENDPOINT', `Match decision: ${userPhone} (${userType}) ${decision} match ${matchId}`);
    
    const result = await scheduledService.handleMatchDecision(
      matchId, 
      userPhone, 
      userType, 
      decision, 
      reason
    );
    
    res.json({
      ...result,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('ENDPOINT', `Match decision error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Get driver's available seats count
 */
app.get('/api/driver/available-seats/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    
    if (!scheduledService?.getDriverAvailableSeats) {
      // Fallback to getDriverPassengerList
      const result = await scheduledService.getDriverPassengerList(phone);
      
      if (result.success) {
        return res.json({
          success: true,
          phone,
          availableSeats: result.driverInfo?.availableSeats || 0,
          totalCapacity: result.driverInfo?.vehicleCapacity || 0,
          filledSeats: result.passengers?.length || 0,
          timestamp: new Date().toISOString()
        });
      }
      
      return res.status(404).json(result);
    }
    
    const availableSeats = await scheduledService.getDriverAvailableSeats(phone);
    
    res.json({
      success: true,
      phone,
      availableSeats,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('ENDPOINT', `Get available seats error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Get driver's pending proposals
 */
app.get('/api/driver/pending-proposals/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    
    const result = await scheduledService.getDriverPassengerList(phone);
    
    if (result.success) {
      return res.json({
        success: true,
        phone,
        pendingProposals: result.pendingProposals || [],
        count: result.pendingProposals?.length || 0,
        timestamp: new Date().toISOString()
      });
    }
    
    res.json(result);
    
  } catch (error) {
    logger.error('ENDPOINT', `Get pending proposals error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ==================== DRIVER CANCELLATION ENDPOINTS ====================

/**
 * Driver cancels entire trip (all accepted passengers)
 */
app.post('/api/driver/cancel-all', async (req, res) => {
  try {
    const { driverPhone, reason } = req.body;
    
    if (!driverPhone) {
      return res.status(400).json({ 
        success: false, 
        error: 'Driver phone required',
        timestamp: new Date().toISOString()
      });
    }
    
    if (!scheduledService?.handleDriverCancelAll) {
      return res.status(503).json({ 
        success: false, 
        error: 'Driver cancellation service unavailable',
        timestamp: new Date().toISOString()
      });
    }
    
    logger.info('ENDPOINT', `Driver cancel all trips: ${driverPhone}, reason: ${reason || 'driver_cancelled_trip'}`);
    
    const result = await scheduledService.handleDriverCancelAll(
      driverPhone, 
      reason || 'driver_cancelled_trip'
    );
    
    if (result.success) {
      res.json({
        ...result,
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(400).json({
        ...result,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    logger.error('ENDPOINT', `Driver cancel all error: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Driver cancels a specific passenger
 */
app.post('/api/driver/cancel-passenger', async (req, res) => {
  try {
    const { driverPhone, passengerPhone, reason } = req.body;
    
    if (!driverPhone || !passengerPhone) {
      return res.status(400).json({ 
        success: false, 
        error: 'Driver and passenger phone required',
        timestamp: new Date().toISOString()
      });
    }
    
    if (!scheduledService?.handleDriverCancelPassenger) {
      return res.status(503).json({ 
        success: false, 
        error: 'Driver cancellation service unavailable',
        timestamp: new Date().toISOString()
      });
    }
    
    logger.info('ENDPOINT', `Driver cancel passenger: ${driverPhone} cancelling ${passengerPhone}, reason: ${reason || 'driver_cancelled_passenger'}`);
    
    const result = await scheduledService.handleDriverCancelPassenger(
      driverPhone, 
      passengerPhone, 
      reason || 'driver_cancelled_passenger'
    );
    
    if (result.success) {
      res.json({
        ...result,
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(400).json({
        ...result,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    logger.error('ENDPOINT', `Driver cancel passenger error: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Get driver's accepted passengers list (simplified version)
 */
app.get('/api/driver/accepted-passengers/:driverPhone', async (req, res) => {
  try {
    const { driverPhone } = req.params;
    
    if (!scheduledService?.getDriverAcceptedPassengers) {
      // Fallback to getDriverPassengerList
      const result = await scheduledService.getDriverPassengerList(driverPhone);
      
      if (result.success) {
        return res.json({
          success: true,
          driverPhone,
          passengers: result.passengers || [],
          count: result.passengers?.length || 0,
          timestamp: new Date().toISOString()
        });
      }
      
      return res.status(404).json(result);
    }
    
    const result = await scheduledService.getDriverAcceptedPassengers(driverPhone);
    
    if (result.success) {
      res.json({
        ...result,
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(400).json({
        ...result,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    logger.error('ENDPOINT', `Get driver accepted passengers error: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ==================== PASSENGER CANCELLATION ENDPOINTS ====================

/**
 * @route POST /api/passenger/cancel-schedule
 * @desc Cancel passenger's scheduled ride and notify driver
 */
app.post('/api/passenger/cancel-schedule', async (req, res) => {
  try {
    const { passengerPhone, reason } = req.body;
    
    console.log('🚫 Passenger cancelling ride:', { passengerPhone, reason });
    
    if (!passengerPhone) {
      return res.status(400).json({ 
        success: false, 
        error: 'Passenger phone is required',
        timestamp: new Date().toISOString()
      });
    }
    
    if (!scheduledService) {
      return res.status(500).json({ 
        success: false, 
        error: 'Scheduled service not available',
        timestamp: new Date().toISOString()
      });
    }
    
    // Get passenger's current schedule to find driver
    let passengerDoc = null;
    if (typeof scheduledService.getUserScheduledSearch === 'function') {
      passengerDoc = await scheduledService.getUserScheduledSearch('passenger', passengerPhone);
    } else {
      // Fallback to getPassengerMatchStatus
      const statusResult = await scheduledService.getPassengerMatchStatus(passengerPhone);
      if (statusResult.success && statusResult.matchDetails) {
        passengerDoc = {
          status: statusResult.matchStatus,
          matchId: statusResult.matchDetails.matchId,
          matchedWith: statusResult.matchDetails.driverPhone,
          driverDetails: statusResult.matchDetails.driverDetails
        };
      }
    }
    
    const hadMatch = passengerDoc && 
                     (passengerDoc.status === 'matched_confirmed' || 
                      passengerDoc.status === 'accepted' ||
                      passengerDoc.matchId != null);
    
    const driverPhone = passengerDoc?.matchedWith || 
                       (passengerDoc?.driverDetails ? passengerDoc.driverDetails.phone : null);
    
    let result;
    
    // If there's a confirmed ride with a driver, use the passenger cancel ride handler
    if (hadMatch && driverPhone && typeof scheduledService.handlePassengerCancelRide === 'function') {
      logger.info('ENDPOINT', `Passenger cancelling confirmed ride: ${passengerPhone} with driver ${driverPhone}`);
      result = await scheduledService.handlePassengerCancelRide(
        passengerPhone, 
        driverPhone, 
        reason || 'passenger_cancelled'
      );
    } 
    // Otherwise just cancel the passenger's own schedule
    else if (typeof scheduledService.handlePassengerCancelSchedule === 'function') {
      logger.info('ENDPOINT', `Passenger cancelling own schedule: ${passengerPhone}`);
      result = await scheduledService.handlePassengerCancelSchedule(
        passengerPhone, 
        reason || 'passenger_cancelled'
      );
    }
    // Fallback to generic cancel
    else if (typeof scheduledService.cancelScheduledSearch === 'function') {
      logger.info('ENDPOINT', `Passenger generic cancel: ${passengerPhone}`);
      result = await scheduledService.cancelScheduledSearch(
        passengerPhone, 
        'passenger', 
        reason || 'passenger_cancelled'
      );
    } else {
      return res.status(503).json({ 
        success: false, 
        error: 'Passenger cancellation service unavailable',
        timestamp: new Date().toISOString()
      });
    }
    
    if (result && result.success) {
      res.json({
        success: true,
        hadMatch: hadMatch,
        message: hadMatch ? 'Ride cancelled - Driver notified' : 'Schedule cancelled',
        data: result,
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: result?.error || 'Failed to cancel ride',
        timestamp: new Date().toISOString()
      });
    }
    
  } catch (error) {
    logger.error('ENDPOINT', `Passenger cancel schedule error: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * @route POST /api/passenger/match-decision
 * @desc Handle passenger's decision on match proposal
 */
app.post('/api/passenger/match-decision', async (req, res) => {
  try {
    const { matchId, passengerPhone, decision } = req.body;
    
    if (!matchId || !passengerPhone || !decision) {
      return res.status(400).json({ 
        success: false, 
        error: 'Match ID, passenger phone, and decision required',
        timestamp: new Date().toISOString()
      });
    }
    
    if (!scheduledService?.handlePassengerMatchDecision) {
      return res.status(503).json({ 
        success: false, 
        error: 'Passenger match decision service unavailable',
        timestamp: new Date().toISOString()
      });
    }
    
    logger.info('ENDPOINT', `Passenger match decision: ${passengerPhone} ${decision} for match ${matchId}`);
    
    const result = await scheduledService.handlePassengerMatchDecision(
      matchId,
      passengerPhone,
      decision
    );
    
    if (result.success) {
      res.json({
        ...result,
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(400).json({
        ...result,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    logger.error('ENDPOINT', `Passenger match decision error: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * @route GET /api/passenger/ride-status/:passengerPhone
 * @desc Get passenger's current ride status
 */
app.get('/api/passenger/ride-status/:passengerPhone', async (req, res) => {
  try {
    const { passengerPhone } = req.params;
    
    if (!scheduledService?.getUserScheduledSearch) {
      // Fallback to getPassengerMatchStatus
      const result = await scheduledService.getPassengerMatchStatus(passengerPhone);
      
      if (result.success) {
        return res.json({
          success: true,
          hasActiveRide: result.hasActiveMatch || false,
          status: result.matchStatus || 'none',
          matchDetails: result.matchDetails || null,
          timestamp: new Date().toISOString()
        });
      }
      
      return res.status(404).json(result);
    }
    
    const passengerDoc = await scheduledService.getUserScheduledSearch(
      'passenger', 
      passengerPhone
    );
    
    if (!passengerDoc) {
      return res.json({ 
        success: true, 
        hasActiveRide: false,
        status: 'none',
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({
      success: true,
      hasActiveRide: passengerDoc.status !== 'cancelled' && 
                     passengerDoc.status !== 'completed' &&
                     passengerDoc.status !== 'expired',
      status: passengerDoc.status,
      matchId: passengerDoc.matchId,
      matchedWith: passengerDoc.matchedWith,
      scheduledTime: passengerDoc.scheduledTime,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('ENDPOINT', `Get passenger ride status error: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Test endpoints
app.post('/api/test/trigger-matching', async (req, res) => {
  try {
    if (!scheduledService?.performScheduledMatchingCycle) {
      throw new Error('Scheduled service unavailable');
    }
    
    const { windowName = '30m' } = req.body;
    const result = await scheduledService.performScheduledMatchingCycle(windowName);
    
    res.json({
      success: true,
      message: `Matching triggered for ${windowName}`,
      result,
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
    methods: {
      notification: notificationService ? Object.getOwnPropertyNames(Object.getPrototypeOf(notificationService))
        .filter(name => typeof notificationService[name] === 'function' && name !== 'constructor') : [],
      scheduled: scheduledService ? Object.getOwnPropertyNames(Object.getPrototypeOf(scheduledService))
        .filter(name => typeof scheduledService[name] === 'function' && name !== 'constructor') : []
    },
    timestamp: new Date().toISOString()
  };
  
  res.json(debugInfo);
});

// Simple test endpoint
app.get('/api/test', (req, res) => {
  res.json({
    success: true,
    message: 'Server running',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/api/health',
      triggerMatching: 'POST /api/test/trigger-matching',
      serviceDebug: '/api/test/service-debug',
      login: 'POST /api/auth/login',
      register: 'POST /api/auth/register',
      fcm: '/api/fcm/*',
      
      // GROUP RIDE ENDPOINTS
      driverPassengers: 'GET /api/driver/passengers/:phone',
      passengerStatus: 'GET /api/passenger/status/:phone',
      matchDecision: 'POST /api/match/decision',
      driverAvailableSeats: 'GET /api/driver/available-seats/:phone',
      driverPendingProposals: 'GET /api/driver/pending-proposals/:phone',
      
      // DRIVER CANCELLATION ENDPOINTS
      driverCancelAll: 'POST /api/driver/cancel-all',
      driverCancelPassenger: 'POST /api/driver/cancel-passenger',
      driverAcceptedPassengers: 'GET /api/driver/accepted-passengers/:driverPhone',
      
      // PASSENGER CANCELLATION ENDPOINTS
      passengerCancelSchedule: 'POST /api/passenger/cancel-schedule',
      passengerMatchDecision: 'POST /api/passenger/match-decision',
      passengerRideStatus: 'GET /api/passenger/ride-status/:passengerPhone'
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
      logger.info('STARTUP', `🌐 Flutter Web: http://localhost:8082`);
      logger.info('STARTUP', `📱 FCM Routes: /api/fcm/*`);
      logger.info('STARTUP', '✅ All services initialized and linked');
      
      // Show service status
      logger.info('STATUS', '=== Service Status ===');
      logger.info('STATUS', `FirestoreService: ${firestoreService?.constructor?.name || 'Not found'}`);
      logger.info('STATUS', `NotificationService: ${notificationService?.constructor?.name || 'Not found'}`);
      logger.info('STATUS', `ScheduledService: ${scheduledService?.constructor?.name || 'Not found'}`);
      logger.info('STATUS', `Legacy WebSocket: ${legacyWebsocketServer?.constructor?.name || 'Not found'}`);
      logger.info('STATUS', `Scheduled WebSocket: ${scheduledWebsocketServer?.constructor?.name || 'Not found'}`);
      
      logger.info('STATUS', '=== Method Availability ===');
      logger.info('STATUS', `Matching cycle: ${!!scheduledService?.performScheduledMatchingCycle}`);
      logger.info('STATUS', `Match decision handler: ${!!scheduledService?.handleMatchDecision}`);
      logger.info('STATUS', `Driver passenger list: ${!!scheduledService?.getDriverPassengerList}`);
      logger.info('STATUS', `Passenger match status: ${!!scheduledService?.getPassengerMatchStatus}`);
      logger.info('STATUS', `FCM register: ${!!notificationService?.registerToken}`);
      logger.info('STATUS', `Send notification: ${!!notificationService?.sendNotification}`);
      logger.info('STATUS', `Driver cancel all: ${!!scheduledService?.handleDriverCancelAll}`);
      logger.info('STATUS', `Passenger cancel: ${!!scheduledService?.handlePassengerCancelSchedule}`);
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
  
  // Stop services in reverse order
  if (scheduledService && typeof scheduledService.stop === 'function') {
    try {
      await scheduledService.stop();
      logger.info('SHUTDOWN', '✅ ScheduledService stopped');
    } catch (error) {
      logger.error('SHUTDOWN', `ScheduledService stop error: ${error.message}`);
    }
  }
  
  // Close WebSocket servers
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
  firestoreService
};
