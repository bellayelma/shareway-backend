// services/NotificationService.js
// COMPLETE FIXED VERSION with FCM SIZE OPTIMIZATION and STRING TYPE ENFORCEMENT
// Prevents "Android message is too big" AND "data must only contain string values" errors

const logger = require('../utils/Logger');
const crypto = require('crypto');

class NotificationService {
  constructor(firestoreService, websocketServer, admin) {
    console.log('📱 [NOTIFICATION] Initializing NotificationService');
    
    this.firestoreService = firestoreService;
    this.websocketServer = websocketServer;
    this.admin = admin;
    
    // Collection names
    this.FCM_TOKENS = 'fcm_tokens';
    this.NOTIFICATIONS = 'notifications';
    this.CANCELLATIONS = 'trip_cancellations';
    
    // Retry configuration
    this.MAX_FCM_RETRIES = 3;
    this.FCM_RETRY_DELAY = 1000; // 1 second
    
    // Deduplication cache
    this.sentMessagesCache = new Map(); // userId -> Map of messageId -> timestamp
    this.DEDUP_TTL = 5000; // 5 seconds - don't send same message twice within this window
    this.DEDUP_CLEANUP_INTERVAL = 60000; // Cleanup every minute
    
    // Start cleanup interval
    setInterval(() => this.cleanupDedupCache(), this.DEDUP_CLEANUP_INTERVAL);
    
    logger.info('NOTIFICATION_SERVICE', '📱 Notification Service initialized with deduplication');
  }

  // ========== DEDUPLICATION METHODS ==========

  /**
   * Generate a unique ID for a message to detect duplicates
   */
  generateMessageId(userId, notification) {
    const type = notification.type || 'unknown';
    const data = notification.data || notification;
    
    // Create a hash of the message content
    const content = JSON.stringify({
      type,
      // Only include key fields that identify the message uniquely
      matchId: data.matchId || data.rideId || null,
      status: data.status || null,
      timestamp: data.timestamp || null
    });
    
    return crypto.createHash('md5').update(content).digest('hex');
  }

  /**
   * Check if a message is a duplicate (already sent recently)
   */
  isDuplicateMessage(userId, messageId) {
    if (!this.sentMessagesCache.has(userId)) {
      return false;
    }
    
    const userMessages = this.sentMessagesCache.get(userId);
    const sentTime = userMessages.get(messageId);
    
    if (!sentTime) {
      return false;
    }
    
    // Check if within TTL
    const now = Date.now();
    if (now - sentTime < this.DEDUP_TTL) {
      console.log(`🔄 [DEDUP] Duplicate message detected for ${userId}: ${messageId} (${now - sentTime}ms ago)`);
      return true;
    }
    
    // Expired, remove it
    userMessages.delete(messageId);
    return false;
  }

  /**
   * Mark a message as sent
   */
  markMessageAsSent(userId, messageId) {
    if (!this.sentMessagesCache.has(userId)) {
      this.sentMessagesCache.set(userId, new Map());
    }
    
    const userMessages = this.sentMessagesCache.get(userId);
    userMessages.set(messageId, Date.now());
    
    // Limit cache size per user (prevent memory leaks)
    if (userMessages.size > 20) {
      // Remove oldest entries
      const entries = Array.from(userMessages.entries());
      entries.sort((a, b) => a[1] - b[1]);
      const toRemove = entries.slice(0, entries.length - 20);
      toRemove.forEach(([key]) => userMessages.delete(key));
    }
  }

  /**
   * Clean up expired entries from dedup cache
   */
  cleanupDedupCache() {
    const now = Date.now();
    let totalRemoved = 0;
    
    for (const [userId, userMessages] of this.sentMessagesCache.entries()) {
      const toRemove = [];
      
      for (const [messageId, timestamp] of userMessages.entries()) {
        if (now - timestamp > this.DEDUP_TTL) {
          toRemove.push(messageId);
        }
      }
      
      toRemove.forEach(id => userMessages.delete(id));
      totalRemoved += toRemove.length;
      
      // Remove empty user entries
      if (userMessages.size === 0) {
        this.sentMessagesCache.delete(userId);
      }
    }
    
    if (totalRemoved > 0) {
      console.log(`🧹 [DEDUP] Cleaned up ${totalRemoved} expired message entries`);
    }
  }

  // ========== PHONE NUMBER UTILITIES ==========

  sanitizePhoneNumber(phoneNumber) {
    if (!phoneNumber) return 'unknown_user';
    
    let sanitized = String(phoneNumber).trim();
    if (sanitized.length === 0) return 'unknown_user';
    
    // Preserve plus at start, replace other special chars
    sanitized = sanitized.replace(/[^a-zA-Z0-9_\-.]/g, (match, index) => {
      return (index === 0 && match === '+') ? '+' : '_';
    });
    
    if (sanitized.startsWith('_')) sanitized = 'user' + sanitized;
    if (sanitized.length > 100) sanitized = sanitized.substring(0, 100);
    if (sanitized.length === 0) sanitized = 'user_' + Date.now();
    
    return sanitized;
  }

  // ========== TOKEN MANAGEMENT ==========

  /**
   * Register FCM token for a user
   * Stores in fcm_tokens collection with phone number as document ID
   */
  async registerFCMToken(userId, token, deviceInfo = {}, userType = null) {
    console.log(`📱 [FCM] Registering token for user ${userId}`);
    
    try {
      if (!userId || !token) throw new Error('User ID and token are required');
      
      const documentId = userId; // Keep plus sign!
      const sanitizedUserId = this.sanitizePhoneNumber(userId);
      const now = new Date().toISOString();
      
      // Start a batch transaction
      const batch = this.firestoreService.batch();
      
      // Get existing token data to preserve history
      const existingDoc = await this.firestoreService.getDocument(this.FCM_TOKENS, documentId);
      const previousTokens = existingDoc.exists ? (existingDoc.data().previousTokens || []) : [];
      
      // If there was a previous token and it's different, archive it
      if (existingDoc.exists && existingDoc.data().token && existingDoc.data().token !== token) {
        previousTokens.push({
          token: existingDoc.data().token,
          deviceInfo: existingDoc.data().deviceInfo,
          registeredAt: existingDoc.data().lastUpdated || existingDoc.data().createdAt,
          replacedAt: now,
          reason: 'token_updated'
        });
        
        // Keep only last 5 tokens in history
        if (previousTokens.length > 5) previousTokens.shift();
      }
      
      // Set the new token data - ALWAYS set active to true when registering
      batch.set(this.FCM_TOKENS, documentId, {
        userId: documentId,
        sanitizedUserId: sanitizedUserId,
        originalUserId: userId,
        token: token,
        phoneNumber: userId,
        platform: deviceInfo.platform || deviceInfo.os || 'unknown',
        deviceInfo: deviceInfo || {},
        deviceModel: deviceInfo.model || deviceInfo.deviceModel || 'unknown',
        deviceOS: deviceInfo.osVersion || deviceInfo.platformVersion || 'unknown',
        appVersion: deviceInfo.appVersion || 'unknown',
        previousTokens: previousTokens,
        active: true,
        registrationCount: existingDoc.exists ? (existingDoc.data().registrationCount || 0) + 1 : 1,
        lastUpdated: now,
        lastUsed: now,
        lastRegistration: now,
        createdAt: existingDoc.exists ? existingDoc.data().createdAt : now,
        updatedAt: now
      }, { merge: true });
      
      console.log(`✅ [FCM] Token stored/updated in fcm_tokens collection for ${documentId} (active: true)`);
      
      // Also store in user document if userType is provided
      if (userType) {
        const userCollection = userType === 'driver' ? 'users_driver' : 'users_passenger';
        
        batch.set(userCollection, sanitizedUserId, {
          phone: userId,
          sanitizedPhone: sanitizedUserId,
          fcmToken: token,
          fcmTokenUpdatedAt: now,
          fcmPlatform: deviceInfo.platform || 'unknown',
          lastActive: now,
          updatedAt: now
        }, { merge: true });
        
        console.log(`✅ [FCM] Token also stored in ${userCollection} for ${sanitizedUserId}`);
      }
      
      // Also store in general users collection
      batch.set('users', sanitizedUserId, {
        phone: userId,
        sanitizedPhone: sanitizedUserId,
        fcmToken: token,
        fcmTokenUpdatedAt: now,
        fcmPlatform: deviceInfo.platform || 'unknown',
        lastActive: now,
        updatedAt: now,
        userType: userType || 'unknown'
      }, { merge: true });
      
      // Execute batch
      await this.firestoreService.commitBatch(batch);
      
      console.log(`✅ [FCM] Token registration complete for ${userId}`);
      
      return {
        success: true,
        userId: documentId,
        token: token,
        message: 'FCM token registered successfully',
        timestamp: now
      };
      
    } catch (error) {
      console.error('❌ [FCM] Error registering token:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Remove/invalidate FCM token for a user
   */
  async removeFCMToken(userId, token = null) {
    try {
      const documentId = userId;
      const sanitizedUserId = this.sanitizePhoneNumber(userId);
      const now = new Date().toISOString();
      
      const batch = this.firestoreService.batch();
      
      // Update fcm_tokens document - mark as inactive but KEEP the token
      const fcmDoc = await this.firestoreService.getDocument(this.FCM_TOKENS, documentId);
      
      if (fcmDoc.exists) {
        const data = fcmDoc.data();
        
        // If specific token provided and it matches current token, deactivate
        if (token && data.token === token) {
          batch.update(this.FCM_TOKENS, documentId, {
            active: false,
            deactivatedAt: now,
            deactivationReason: 'user_logout',
            lastUpdated: now,
            token: data.token // Keep the token for reference
          });
          console.log(`✅ [FCM] Deactivated token for ${documentId} (kept for reference)`);
        } 
        // If no token specified, deactivate all
        else if (!token) {
          batch.update(this.FCM_TOKENS, documentId, {
            active: false,
            deactivatedAt: now,
            deactivationReason: 'user_logout_all',
            lastUpdated: now,
            token: data.token // Keep the token for reference
          });
          console.log(`✅ [FCM] Deactivated all tokens for ${documentId} (kept for reference)`);
        }
      }
      
      // Update users_driver if exists
      const driverDoc = await this.firestoreService.getDocument('users_driver', sanitizedUserId);
      if (driverDoc.exists) {
        batch.update('users_driver', sanitizedUserId, {
          fcmToken: null,
          fcmTokenRemovedAt: now
        });
      }
      
      // Update users_passenger if exists
      const passengerDoc = await this.firestoreService.getDocument('users_passenger', sanitizedUserId);
      if (passengerDoc.exists) {
        batch.update('users_passenger', sanitizedUserId, {
          fcmToken: null,
          fcmTokenRemovedAt: now
        });
      }
      
      // Update general users collection
      const generalUserDoc = await this.firestoreService.getDocument('users', sanitizedUserId);
      if (generalUserDoc.exists) {
        batch.update('users', sanitizedUserId, {
          fcmToken: null,
          fcmTokenRemovedAt: now
        });
      }
      
      // Execute batch
      await this.firestoreService.commitBatch(batch);
      
      return {
        success: true,
        message: 'FCM token deactivated successfully'
      };
      
    } catch (error) {
      console.error('❌ [FCM] Error removing token:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get user's FCM token from Firestore - PRIORITY: fcm_tokens collection
   */
  async getUserFCMToken(userId) {
    try {
      console.log(`🔍 [FCM] Getting token for user: ${userId}`);
      
      // PRIORITY 1: Try with original userId (with plus sign)
      const originalTokenDoc = await this.firestoreService.getDocument(this.FCM_TOKENS, userId);
      
      if (originalTokenDoc.exists) {
        const tokenData = originalTokenDoc.data();
        console.log(`📄 [FCM] Found document with original ID: ${userId}`);
        console.log(`   - active: ${tokenData.active}`);
        console.log(`   - has token: ${!!tokenData.token}`);
        
        // Check if token is active AND has a token value
        if (tokenData.active !== false && tokenData.token) {
          console.log(`✅ [FCM] Found active token using original userId for ${userId}`);
          
          // Update last used timestamp (fire and forget)
          this.firestoreService.updateDocument(this.FCM_TOKENS, userId, {
            lastUsed: new Date().toISOString()
          }).catch(() => {});
          
          return {
            success: true,
            token: tokenData.token,
            source: 'fcm_tokens_original',
            deviceInfo: tokenData.deviceInfo || {},
            platform: tokenData.platform || 'unknown'
          };
        } else {
          console.log(`⚠️ [FCM] Token in fcm_tokens is inactive or missing for ${userId}`);
        }
      } else {
        console.log(`📄 [FCM] No document found with original ID: ${userId}`);
      }
      
      // PRIORITY 2: Try with sanitized userId (without plus sign)
      const sanitizedUserId = this.sanitizePhoneNumber(userId);
      if (sanitizedUserId !== userId) {
        const sanitizedTokenDoc = await this.firestoreService.getDocument(this.FCM_TOKENS, sanitizedUserId);
        
        if (sanitizedTokenDoc.exists) {
          const tokenData = sanitizedTokenDoc.data();
          console.log(`📄 [FCM] Found document with sanitized ID: ${sanitizedUserId}`);
          
          if (tokenData.active !== false && tokenData.token) {
            console.log(`✅ [FCM] Found active token using sanitized userId for ${sanitizedUserId}`);
            
            this.firestoreService.updateDocument(this.FCM_TOKENS, sanitizedUserId, {
              lastUsed: new Date().toISOString()
            }).catch(() => {});
            
            return {
              success: true,
              token: tokenData.token,
              source: 'fcm_tokens_sanitized',
              deviceInfo: tokenData.deviceInfo || {},
              platform: tokenData.platform || 'unknown'
            };
          }
        }
      }
      
      // PRIORITY 3: Check users_driver collection
      const driverDoc = await this.firestoreService.getDocument('users_driver', sanitizedUserId);
      if (driverDoc.exists && driverDoc.data().fcmToken) {
        const token = driverDoc.data().fcmToken;
        console.log(`✅ [FCM] Found token in users_driver for ${sanitizedUserId}`);
        
        // Migrate to fcm_tokens
        await this.migrateTokenToFCMCollection(userId, token, driverDoc.data());
        
        return {
          success: true,
          token: token,
          source: 'users_driver'
        };
      }
      
      // PRIORITY 4: Check users_passenger collection
      const passengerDoc = await this.firestoreService.getDocument('users_passenger', sanitizedUserId);
      if (passengerDoc.exists && passengerDoc.data().fcmToken) {
        const token = passengerDoc.data().fcmToken;
        console.log(`✅ [FCM] Found token in users_passenger for ${sanitizedUserId}`);
        
        // Migrate to fcm_tokens
        await this.migrateTokenToFCMCollection(userId, token, passengerDoc.data());
        
        return {
          success: true,
          token: token,
          source: 'users_passenger'
        };
      }
      
      // PRIORITY 5: Check general users collection
      const userDoc = await this.firestoreService.getDocument('users', sanitizedUserId);
      if (userDoc.exists && userDoc.data().fcmToken) {
        const token = userDoc.data().fcmToken;
        console.log(`✅ [FCM] Found token in users for ${sanitizedUserId}`);
        
        // Migrate to fcm_tokens
        await this.migrateTokenToFCMCollection(userId, token, userDoc.data());
        
        return {
          success: true,
          token: token,
          source: 'users'
        };
      }
      
      console.log(`📱 [FCM] No token found for ${userId}`);
      return {
        success: false,
        token: null,
        error: 'No token found'
      };
      
    } catch (error) {
      console.error(`❌ [FCM] Error getting token for ${userId}:`, error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Migrate token from old location to fcm_tokens collection
   */
  async migrateTokenToFCMCollection(userId, token, userData) {
    try {
      const documentId = userId;
      const existing = await this.firestoreService.getDocument(this.FCM_TOKENS, documentId);
      
      const now = new Date().toISOString();
      const sanitizedUserId = this.sanitizePhoneNumber(userId);
      
      if (existing.exists) {
        const existingData = existing.data();
        
        // If the token is different, update it and reactivate
        if (existingData.token !== token) {
          console.log(`📱 [FCM] Updating token for ${documentId} (was different)`);
          
          // Archive the old token
          const previousTokens = existingData.previousTokens || [];
          previousTokens.push({
            token: existingData.token,
            deviceInfo: existingData.deviceInfo,
            registeredAt: existingData.lastUpdated || existingData.createdAt,
            replacedAt: now,
            reason: 'token_migrated'
          });
          
          // Keep only last 5
          if (previousTokens.length > 5) previousTokens.shift();
          
          await this.firestoreService.updateDocument(this.FCM_TOKENS, documentId, {
            token: token,
            active: true,
            previousTokens: previousTokens,
            lastUpdated: now,
            lastUsed: now,
            updatedAt: now,
            registrationCount: (existingData.registrationCount || 0) + 1,
            sanitizedUserId: sanitizedUserId
          });
          console.log(`✅ [FCM] Updated and activated token for ${documentId}`);
        } else if (existingData.active === false) {
          // Same token but inactive - reactivate it
          console.log(`📱 [FCM] Reactivating token for ${documentId}`);
          await this.firestoreService.updateDocument(this.FCM_TOKENS, documentId, {
            active: true,
            reactivatedAt: now,
            lastUsed: now,
            updatedAt: now,
            sanitizedUserId: sanitizedUserId
          });
          console.log(`✅ [FCM] Reactivated token for ${documentId}`);
        } else {
          // Already exists and active with same token
          console.log(`📱 [FCM] Token already exists and active for ${documentId}`);
          // Still update last used
          await this.firestoreService.updateDocument(this.FCM_TOKENS, documentId, {
            lastUsed: now,
            sanitizedUserId: sanitizedUserId
          }).catch(() => {});
        }
      } else {
        // Create token document
        await this.firestoreService.setDocument(this.FCM_TOKENS, documentId, {
          userId: documentId,
          sanitizedUserId: sanitizedUserId,
          token: token,
          phoneNumber: userId,
          platform: userData.fcmPlatform || userData.platform || 'unknown',
          deviceInfo: {
            platform: userData.fcmPlatform || userData.platform,
            migratedFrom: 'legacy_collection',
            migrationDate: now
          },
          active: true,
          registrationCount: 1,
          migratedAt: now,
          createdAt: userData.fcmTokenUpdatedAt || now,
          lastUpdated: now,
          lastUsed: now
        });
        
        console.log(`✅ [FCM] Migrated token to fcm_tokens for ${documentId}`);
      }
      
    } catch (error) {
      console.error(`❌ [FCM] Error migrating token for ${userId}:`, error.message);
    }
  }

  /**
   * Get all active FCM tokens (for broadcasting)
   */
  async getAllActiveFCMTokens(limit = 1000) {
    try {
      const constraints = [
        { field: 'active', operator: '==', value: true }
      ];
      
      const snapshot = await this.firestoreService.queryCollection(
        this.FCM_TOKENS,
        constraints,
        limit
      );
      
      const tokens = [];
      snapshot.forEach(doc => {
        tokens.push({
          userId: doc.id,
          ...doc.data()
        });
      });
      
      console.log(`📱 [FCM] Found ${tokens.length} active tokens`);
      
      return {
        success: true,
        tokens: tokens,
        count: tokens.length
      };
      
    } catch (error) {
      console.error('❌ [FCM] Error getting all tokens:', error.message);
      return {
        success: false,
        tokens: [],
        count: 0,
        error: error.message
      };
    }
  }

  /**
   * Handle invalid token - mark as inactive but keep for reference
   */
  async handleInvalidToken(userId, invalidToken) {
    try {
      const documentId = userId;
      const sanitizedUserId = this.sanitizePhoneNumber(userId);
      const now = new Date().toISOString();
      
      const batch = this.firestoreService.batch();
      
      // Update fcm_tokens document - mark as inactive but KEEP the token
      const fcmDoc = await this.firestoreService.getDocument(this.FCM_TOKENS, documentId);
      
      if (fcmDoc.exists) {
        const data = fcmDoc.data();
        
        // If current token matches the invalid token, mark it inactive
        if (data.token === invalidToken) {
          batch.update(this.FCM_TOKENS, documentId, {
            active: false,
            invalidAt: now,
            invalidationReason: 'fcm_token_not_registered',
            lastError: 'Token not registered with FCM',
            lastUpdated: now,
            token: data.token // Keep the token for reference
          });
          console.log(`✅ [FCM] Marked token as inactive for ${documentId} (kept for reference)`);
        }
      }
      
      // Clear tokens from legacy collections
      const legacyCollections = ['users_driver', 'users_passenger', 'users'];
      for (const collection of legacyCollections) {
        const doc = await this.firestoreService.getDocument(collection, sanitizedUserId);
        if (doc.exists) {
          batch.update(collection, sanitizedUserId, {
            fcmToken: null,
            fcmTokenInvalid: true,
            fcmTokenInvalidAt: now
          });
        }
      }
      
      await this.firestoreService.commitBatch(batch);
      console.log(`✅ [FCM] Handled invalid token for ${documentId}`);
      
    } catch (error) {
      console.error('❌ [FCM] Error handling invalid token:', error.message);
    }
  }

  // ========== FCM SENDING WITH DEDUPLICATION AND SIZE OPTIMIZATION ==========

  /**
   * Send data-only FCM notification with deduplication
   */
  async sendFCMNotification(userId, notification, options = {}) {
    const { priority = 'high', retryCount = 0, messageId = null } = options;
    let tokenResult = null;
    let token = null;
    
    try {
      if (!this.admin?.messaging) {
        console.error('❌ [FCM] Firebase Admin messaging not available');
        return false;
      }
      
      // Generate message ID if not provided
      const msgId = messageId || this.generateMessageId(userId, notification);
      
      // Check for duplicate
      if (this.isDuplicateMessage(userId, msgId)) {
        console.log(`⏭️ [FCM] Skipping duplicate message for ${userId}: ${notification.type}`);
        return true; // Return true to indicate "success" (already sent)
      }
      
      tokenResult = await this.getUserFCMToken(userId);
      if (!tokenResult.success || !tokenResult.token) {
        console.log(`📱 [FCM] No active token for ${userId}`);
        return false;
      }
      
      token = tokenResult.token;
      
      // ✅ USE THE OPTIMIZED CONVERTER
      const fcmData = this.convertToDataOnlyFCM(notification);
      
      // ✅ ENSURE ALL VALUES ARE STRINGS (critical fix)
      const validatedData = {};
      for (const [key, value] of Object.entries(fcmData.data)) {
        if (value === null || value === undefined) {
          validatedData[key] = '';
        } else if (typeof value === 'object') {
          // If it's still an object, stringify it
          validatedData[key] = JSON.stringify(value);
        } else {
          // Convert everything to string
          validatedData[key] = String(value);
        }
      }
      
      // Add deduplication info to message
      validatedData._messageId = String(msgId);
      validatedData._sentAt = String(Date.now());
      
      // FCM v1 message - NO notification block
      const message = {
        token: token,
        data: validatedData, // Use validated data with all strings
        android: {
          priority: 'high',
          ttl: 86400, // 24 hours
          direct_boot_ok: true,
        },
        apns: {
          headers: {
            'apns-priority': '10',
            'apns-push-type': 'background',
            'apns-expiration': '0'
          },
          payload: {
            aps: { 'content-available': 1 } // No alert/sound/badge
          }
        },
        webpush: {
          headers: { Urgency: 'high', TTL: '86400' }
        }
      };
      
      const messaging = this.admin.messaging();
      const response = await messaging.send(message);
      
      console.log(`✅ [FCM] Sent to ${userId}:`, response);
      
      // Mark as sent
      this.markMessageAsSent(userId, msgId);
      
      // Update last used via firestoreService
      this.firestoreService.updateDocument(this.FCM_TOKENS, userId, {
        lastUsed: new Date().toISOString(),
        lastSuccessfulSend: new Date().toISOString(),
        lastMessageType: notification.type,
        lastMessageId: msgId
      }).catch(() => {});
      
      return true;
      
    } catch (error) {
      console.error(`❌ [FCM] Error sending to ${userId}:`, error.message);
      
      // Handle token errors with retry
      if (this.isTokenError(error)) {
        await this.handleInvalidToken(userId, tokenResult?.token || token);
      } else if (this.isRetryableError(error) && retryCount < this.MAX_FCM_RETRIES) {
        console.log(`🔄 [FCM] Retry ${retryCount + 1}/${this.MAX_FCM_RETRIES} for ${userId}`);
        await new Promise(r => setTimeout(r, this.FCM_RETRY_DELAY * Math.pow(2, retryCount)));
        return this.sendFCMNotification(userId, notification, { 
          ...options, 
          retryCount: retryCount + 1,
          messageId 
        });
      }
      
      return false;
    }
  }

  /**
   * Send notification via all channels (FCM + WebSocket) with deduplication
   */
  async sendNotification(userId, notification, options = {}) {
    const { 
      important = true, 
      storeInHistory = true, 
      skipFCM = false,
      forceSend = false // Force send even if duplicate? (for critical messages)
    } = options;
    
    console.log(`📨 [NOTIFY] Sending to ${userId}, type: ${notification.type}`);
    
    // Generate message ID for tracking
    const messageId = this.generateMessageId(userId, notification);
    
    // Check for duplicate (unless forced)
    if (!forceSend && this.isDuplicateMessage(userId, messageId)) {
      console.log(`⏭️ [NOTIFY] Skipping duplicate notification for ${userId}: ${notification.type}`);
      return { 
        success: true, 
        duplicate: true,
        messageId,
        methods: { fcm: false, ws: false }
      };
    }
    
    let fcmSent = false;
    let wsSent = false;
    
    // Try FCM first (for offline delivery)
    if (important && !skipFCM && this.admin) {
      fcmSent = await this.sendFCMNotification(userId, notification, { 
        ...options, 
        messageId 
      });
      if (fcmSent) console.log(`✅ [NOTIFY] FCM sent to ${userId}`);
    }
    
    // Try WebSocket for real-time (only if user is online)
    if (this.websocketServer?.sendToUser) {
      try {
        // Add messageId to WebSocket message for client-side deduplication
        const wsNotification = {
          ...notification,
          _messageId: messageId,
          _sentAt: Date.now()
        };
        
        wsSent = await this.websocketServer.sendToUser(userId, wsNotification);
        if (wsSent) {
          console.log(`✅ [NOTIFY] WebSocket sent to ${userId}`);
          // Mark as sent for WebSocket only (FCM already marked)
          if (!fcmSent) {
            this.markMessageAsSent(userId, messageId);
          }
        }
      } catch (wsError) {
        console.error(`❌ [NOTIFY] WebSocket error:`, wsError.message);
      }
    }
    
    // Store in history (always store important notifications)
    if (storeInHistory) {
      await this.storeNotification(userId, {
        ...notification,
        _messageId: messageId,
        _deliveryMethods: { fcm: fcmSent, ws: wsSent }
      });
    }
    
    return { 
      success: fcmSent || wsSent, 
      messageId,
      duplicate: false,
      methods: { fcm: fcmSent, ws: wsSent } 
    };
  }

  /**
   * Send notification to multiple users with deduplication
   */
  async sendBulkNotification(userIds, notification, options = {}) {
    console.log(`📨 [BULK] Sending to ${userIds.length} users, type: ${notification.type}`);
    
    const results = [];
    const batchSize = 10; // Send in batches to avoid overwhelming
    
    for (let i = 0; i < userIds.length; i += batchSize) {
      const batch = userIds.slice(i, i + batchSize);
      const promises = batch.map(userId => 
        this.sendNotification(userId, notification, options)
          .then(result => ({ userId, ...result }))
          .catch(error => ({ userId, success: false, error: error.message }))
      );
      
      const batchResults = await Promise.all(promises);
      results.push(...batchResults);
      
      // Small delay between batches
      if (i + batchSize < userIds.length) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    
    const summary = {
      total: userIds.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      duplicated: results.filter(r => r.duplicate).length
    };
    
    console.log(`📊 [BULK] Results: ${summary.successful} sent, ${summary.duplicated} duplicates, ${summary.failed} failed`);
    
    return {
      success: summary.successful > 0,
      summary,
      results
    };
  }

  // ========== FIXED: CONVERT TO DATA-ONLY FCM WITH SIZE LIMITING AND STRING ENFORCEMENT ==========

  /**
   * Convert notification to data-only FCM format with size optimization
   * Prevents "Android message is too big" AND "data must only contain string values" errors
   */
  convertToDataOnlyFCM(notification) {
    const type = notification.type || 'unknown';
    const data = notification.data || notification;
    
    console.log(`📦 [FCM] Creating compact payload for type: ${type}`);
    
    // START WITH MINIMAL PAYLOAD - only essential fields
    const dataPayload = {
      type: String(type),
      timestamp: String(Date.now()),
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
      screen: String(this.getNotificationScreen(type)),
    };
    
    // ONLY add essential fields based on notification type
    if (type.includes('scheduled_match_proposed_to_driver')) {
      // For driver match proposals - only what's absolutely needed
      dataPayload.matchId = String(data.matchId || '');
      dataPayload.passengerName = String(data.passengerName || 'Passenger');
      dataPayload.passengerCount = String(data.passengerCount || 1);
      dataPayload.score = String(data.score || '');
      
      // CRITICAL: Stringify large objects instead of flattening
      if (data.passengerDetails) {
        // Only keep essential passenger fields and ensure all are strings
        const essentialPassenger = {
          name: String(data.passengerDetails.name || 'Passenger'),
          phone: String(data.passengerDetails.phone || ''),
          photoUrl: String(data.passengerDetails.profilePhoto || '')
        };
        dataPayload.passengerDetails = JSON.stringify(essentialPassenger);
      }
      
      if (data.tripDetails) {
        // Only keep essential trip fields
        const essentialTrip = {
          pickup: String(data.tripDetails.pickupName || ''),
          destination: String(data.tripDetails.destinationName || ''),
          time: String(data.tripDetails.scheduledTime || '')
        };
        dataPayload.tripDetails = JSON.stringify(essentialTrip);
      }
    }
    else if (type.includes('scheduled_match_confirmed')) {
      // For match confirmations
      dataPayload.matchId = String(data.matchId || '');
      dataPayload.confirmedBy = String(data.confirmedBy || '');
      
      if (data.driverDetails) {
        const essentialDriver = {
          name: String(data.driverDetails.name || 'Driver'),
          phone: String(data.driverDetails.phone || ''),
          photoUrl: String(data.driverDetails.photoUrl || ''),
          vehicleInfo: data.driverDetails.vehicleInfo ? {
            type: String(data.driverDetails.vehicleInfo.type || 'Car'),
            plate: String(data.driverDetails.vehicleInfo.plate || ''),
            color: String(data.driverDetails.vehicleInfo.color || '')
          } : {}
        };
        dataPayload.driverDetails = JSON.stringify(essentialDriver);
      }
      
      if (data.passengerDetails) {
        const essentialPassenger = {
          name: String(data.passengerDetails.name || 'Passenger'),
          phone: String(data.passengerDetails.phone || '')
        };
        dataPayload.passengerDetails = JSON.stringify(essentialPassenger);
      }
    }
    else if (type.includes('DRIVER_CANCELLED_ALL') || type.includes('DRIVER_CANCELLED_YOUR_RIDE') || 
             type.includes('PASSENGER_CANCELLED_RIDE') || type.includes('PASSENGER_CANCELLATION_CONFIRMED')) {
      // For cancellations - minimal data
      dataPayload.matchId = String(data.matchId || '');
      dataPayload.reason = String(data.reason || '');
      dataPayload.message = String(data.message || '');
      dataPayload.cancelledBy = String(data.cancelledBy || '');
      
      if (data.driverName) dataPayload.driverName = String(data.driverName);
      if (data.passengerName) dataPayload.passengerName = String(data.passengerName);
    }
    else {
      // For other notification types - just add essential primitive fields
      for (const [key, value] of Object.entries(data)) {
        if (value === null || value === undefined) continue;
        
        // Only include primitive values and short strings
        if (typeof value !== 'object' && String(value).length < 100) {
          dataPayload[key] = String(value);
        }
      }
    }
    
    // ✅ FINAL PASS: Ensure ALL values are strings
    for (const [key, value] of Object.entries(dataPayload)) {
      if (value === null || value === undefined) {
        dataPayload[key] = '';
      } else if (typeof value !== 'string') {
        // Convert anything that's still not a string
        dataPayload[key] = JSON.stringify(value);
      }
    }
    
    // SAFETY CHECK: Ensure total size is under 4KB
    const payloadSize = JSON.stringify(dataPayload).length;
    
    if (payloadSize > 3500) {
      console.warn(`⚠️ [FCM] Payload too large (${payloadSize} bytes), stripping non-essentials`);
      
      // Remove non-essential fields if still too large
      delete dataPayload.passengerDetails;
      delete dataPayload.tripDetails;
      delete dataPayload.driverDetails;
      delete dataPayload.vehicleInfo;
      
      // Keep only absolute essentials - all converted to strings
      const minimalPayload = {
        type: String(dataPayload.type || ''),
        matchId: String(dataPayload.matchId || ''),
        timestamp: String(dataPayload.timestamp || Date.now())
      };
      
      // Add back essential fields if they exist
      if (dataPayload.passengerName) minimalPayload.passengerName = String(dataPayload.passengerName);
      if (dataPayload.driverName) minimalPayload.driverName = String(dataPayload.driverName);
      if (dataPayload.reason) minimalPayload.reason = String(dataPayload.reason);
      
      const finalSize = JSON.stringify(minimalPayload).length;
      console.log(`✅ [FCM] Reduced to ${finalSize} bytes`);
      return { data: minimalPayload };
    }
    
    console.log(`✅ [FCM] Payload size: ${payloadSize} bytes`);
    return { data: dataPayload };
  }

  /**
   * Get screen name for notification type
   */
  getNotificationScreen(type) {
    const screens = {
      'scheduled_match_proposed_to_driver': 'match_proposal_driver',
      'scheduled_match_proposed_to_passenger': 'match_proposal_passenger',
      'scheduled_match_confirmed': 'active_ride',
      'DRIVER_CANCELLED_ALL': 'driver_schedule',
      'DRIVER_CANCELLED_YOUR_RIDE': 'passenger_schedule',
      'PASSENGER_CANCELLED_RIDE': 'driver_schedule',
      'PASSENGER_CANCELLATION_CONFIRMED': 'passenger_schedule',
    };
    return screens[type] || 'home';
  }

  // ========== NOTIFICATION STORAGE ==========

  /**
   * Store notification in Firestore
   */
  async storeNotification(userId, notification) {
    try {
      const sanitizedUserId = this.sanitizePhoneNumber(userId);
      
      const notifData = {
        userId: sanitizedUserId,
        originalUserId: userId,
        type: notification.type,
        data: notification.data || notification,
        messageId: notification._messageId,
        read: false,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      };
      
      const docId = await this.firestoreService.addDocument(this.NOTIFICATIONS, notifData);
      return { success: true, id: docId };
    } catch (error) {
      console.error('❌ [NOTIFY] Error storing:', error.message);
      return { success: false };
    }
  }

  /**
   * Get user notifications
   */
  async getUserNotifications(userId, limit = 50, unreadOnly = false) {
    try {
      const sanitizedUserId = this.sanitizePhoneNumber(userId);
      
      let constraints = [
        { field: 'userId', operator: '==', value: sanitizedUserId },
        { field: 'createdAt', operator: 'orderBy', value: 'desc' }
      ];
      
      if (unreadOnly) {
        constraints.push({ field: 'read', operator: '==', value: false });
      }
      
      const snapshot = await this.firestoreService.queryCollection(
        this.NOTIFICATIONS,
        constraints,
        limit
      );
      
      const notifications = [];
      snapshot.forEach(doc => notifications.push({ id: doc.id, ...doc.data() }));
      
      return { success: true, notifications };
    } catch (error) {
      console.error('❌ [NOTIFY] Error getting:', error.message);
      return { success: false, error: error.message, notifications: [] };
    }
  }

  /**
   * Mark notification as read
   */
  async markNotificationRead(notificationId) {
    try {
      await this.firestoreService.updateDocument(this.NOTIFICATIONS, notificationId, {
        read: true,
        readAt: new Date().toISOString()
      });
      return { success: true };
    } catch (error) {
      console.error('❌ [NOTIFY] Error marking read:', error.message);
      return { success: false };
    }
  }

  /**
   * Mark all notifications as read for a user
   */
  async markAllNotificationsRead(userId) {
    try {
      const sanitizedUserId = this.sanitizePhoneNumber(userId);
      
      const constraints = [
        { field: 'userId', operator: '==', value: sanitizedUserId },
        { field: 'read', operator: '==', value: false }
      ];
      
      const snapshot = await this.firestoreService.queryCollection(
        this.NOTIFICATIONS,
        constraints,
        100
      );
      
      if (snapshot.empty) {
        return { success: true, count: 0 };
      }
      
      const batch = this.firestoreService.batch();
      let count = 0;
      
      snapshot.forEach(doc => {
        batch.update(this.NOTIFICATIONS, doc.id, {
          read: true,
          readAt: new Date().toISOString()
        });
        count++;
      });
      
      await this.firestoreService.commitBatch(batch);
      
      return { success: true, count };
    } catch (error) {
      console.error('❌ [NOTIFY] Error marking all read:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Delete old notifications (cleanup)
   */
  async deleteOldNotifications(daysOld = 30) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);
      
      const constraints = [
        { field: 'createdAt', operator: '<', value: cutoffDate.toISOString() }
      ];
      
      const snapshot = await this.firestoreService.queryCollection(
        this.NOTIFICATIONS,
        constraints,
        500
      );
      
      if (snapshot.empty) {
        return { success: true, count: 0 };
      }
      
      const batch = this.firestoreService.batch();
      let count = 0;
      
      snapshot.forEach(doc => {
        batch.delete(this.NOTIFICATIONS, doc.id);
        count++;
      });
      
      await this.firestoreService.commitBatch(batch);
      
      console.log(`🧹 [NOTIFY] Deleted ${count} old notifications`);
      return { success: true, count };
    } catch (error) {
      console.error('❌ [NOTIFY] Error deleting old notifications:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== CANCELLATION RECORDS ==========

  /**
   * Create cancellation record
   */
  async createCancellationRecord(data) {
    try {
      const cancellationData = {
        ...data,
        createdAt: new Date().toISOString(),
        timestamp: Date.now()
      };
      
      const docId = await this.firestoreService.addDocument(this.CANCELLATIONS, cancellationData);
      
      // Broadcast via WebSocket
      if (this.websocketServer?.broadcast) {
        this.websocketServer.broadcast('trip_cancelled', {
          type: 'cancellation_created',
          data: { id: docId, ...cancellationData }
        });
      }
      
      return { success: true, id: docId, data: cancellationData };
    } catch (error) {
      console.error('❌ [NOTIFY] Error creating cancellation:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get cancellation records for user
   */
  async getUserCancellations(userPhone, role = null, limit = 50) {
    try {
      const sanitizedPhone = this.sanitizePhoneNumber(userPhone);
      
      if (role === 'driver') {
        const constraints = [
          { field: 'driverDetails.phone', operator: '==', value: userPhone },
          { field: 'createdAt', operator: 'orderBy', value: 'desc' }
        ];
        
        const snapshot = await this.firestoreService.queryCollection(
          this.CANCELLATIONS,
          constraints,
          limit
        );
        
        const cancellations = [];
        snapshot.forEach(doc => cancellations.push({ id: doc.id, ...doc.data() }));
        return { success: true, cancellations };
      } 
      else if (role === 'passenger') {
        const constraints = [
          { field: 'passengerDetails.phone', operator: '==', value: userPhone },
          { field: 'createdAt', operator: 'orderBy', value: 'desc' }
        ];
        
        const snapshot = await this.firestoreService.queryCollection(
          this.CANCELLATIONS,
          constraints,
          limit
        );
        
        const cancellations = [];
        snapshot.forEach(doc => cancellations.push({ id: doc.id, ...doc.data() }));
        return { success: true, cancellations };
      } 
      else {
        // Get both
        const driverConstraints = [
          { field: 'driverDetails.phone', operator: '==', value: userPhone },
          { field: 'createdAt', operator: 'orderBy', value: 'desc' }
        ];
        
        const passengerConstraints = [
          { field: 'passengerDetails.phone', operator: '==', value: userPhone },
          { field: 'createdAt', operator: 'orderBy', value: 'desc' }
        ];
        
        const [driverSnapshot, passengerSnapshot] = await Promise.all([
          this.firestoreService.queryCollection(this.CANCELLATIONS, driverConstraints, limit),
          this.firestoreService.queryCollection(this.CANCELLATIONS, passengerConstraints, limit)
        ]);
        
        const all = [];
        driverSnapshot.forEach(d => all.push({ id: d.id, ...d.data() }));
        passengerSnapshot.forEach(p => all.push({ id: p.id, ...p.data() }));
        
        all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        
        return { success: true, cancellations: all.slice(0, limit) };
      }
    } catch (error) {
      console.error('❌ [NOTIFY] Error getting cancellations:', error.message);
      return { success: false, error: error.message, cancellations: [] };
    }
  }

  /**
   * Get cancellation by ID
   */
  async getCancellationById(cancellationId) {
    try {
      const doc = await this.firestoreService.getDocument(this.CANCELLATIONS, cancellationId);
      
      if (!doc.exists) {
        return { success: false, error: 'Cancellation not found' };
      }
      
      return { success: true, cancellation: { id: doc.id, ...doc.data() } };
    } catch (error) {
      console.error('❌ [NOTIFY] Error getting cancellation:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== UTILITIES ==========

  isTokenError(error) {
    const codes = [
      'messaging/registration-token-not-registered',
      'messaging/invalid-registration-token',
      'messaging/not-registered'
    ];
    return codes.includes(error.code);
  }

  isRetryableError(error) {
    const codes = [
      'messaging/internal-error',
      'messaging/server-unavailable',
      'messaging/third-party-auth-error',
      'deadline-exceeded'
    ];
    return codes.includes(error.code) || error.message?.includes('timeout');
  }

  /**
   * Get notification statistics for a user
   */
  async getNotificationStats(userId) {
    try {
      const sanitizedUserId = this.sanitizePhoneNumber(userId);
      
      const unreadConstraints = [
        { field: 'userId', operator: '==', value: sanitizedUserId },
        { field: 'read', operator: '==', value: false }
      ];
      
      const allConstraints = [
        { field: 'userId', operator: '==', value: sanitizedUserId }
      ];
      
      const [unreadSnapshot, allSnapshot] = await Promise.all([
        this.firestoreService.queryCollection(this.NOTIFICATIONS, unreadConstraints, 1000),
        this.firestoreService.queryCollection(this.NOTIFICATIONS, allConstraints, 1000)
      ]);
      
      return {
        success: true,
        stats: {
          total: allSnapshot.size,
          unread: unreadSnapshot.size,
          read: allSnapshot.size - unreadSnapshot.size
        }
      };
    } catch (error) {
      console.error('❌ [NOTIFY] Error getting notification stats:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Clear deduplication cache for a user (useful for testing)
   */
  clearUserCache(userId) {
    if (this.sentMessagesCache.has(userId)) {
      this.sentMessagesCache.delete(userId);
      console.log(`🧹 [DEDUP] Cleared cache for user ${userId}`);
      return true;
    }
    return false;
  }

  /**
   * Clear all deduplication cache
   */
  clearAllCache() {
    const size = this.sentMessagesCache.size;
    this.sentMessagesCache.clear();
    console.log(`🧹 [DEDUP] Cleared all cache (${size} users)`);
    return size;
  }
}

module.exports = NotificationService;
