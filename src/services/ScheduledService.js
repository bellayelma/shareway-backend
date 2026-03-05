// services/ScheduledService.js - COMPLETE WITH PHONE NUMBERS AS DOCUMENT IDS
// FCM-FIRST + WEBSOCKET FALLBACK WITH PHONE NUMBER DOCUMENT IDS
// ONE-STEP APPROVAL: Driver acceptance immediately confirms the match
// INCLUDES DRIVER CANCELLATION HANDLERS (Cancel All + Cancel Single Passenger)
// INCLUDES PASSENGER CANCELLATION HANDLER WITH CANCELLATION RECORDS
// UPDATED WITH DRIVER SCHEDULE SCREEN INTEGRATION
// FIXED: Driver details now properly include name and photo from users collection
// FIXED: Driver photo and name are now correctly saved in passenger document
// UPDATED: FCM tokens stored in fcm_tokens collection with phone number as document ID
// FIXED: Data-only high priority FCM messages - NO notification blocks
// FIXED: Token management - properly handle inactive tokens and migration
// FIXED: getUserFCMToken now correctly handles phone numbers with plus signs

const logger = require('../utils/Logger');

class ScheduledService {
  constructor(firestoreService, websocketServer, admin) {
    console.log('🚀 [SCHEDULED] Constructor called!');
    console.log('🔍 [SCHEDULED] firestoreService:', !!firestoreService);
    console.log('🔍 [SCHEDULED] websocketServer:', !!websocketServer);
    console.log('🔍 [SCHEDULED] admin:', !!admin);
    
    this.firestoreService = firestoreService;
    this.websocketServer = websocketServer;
    this.admin = admin;
    
    // Get database instance from firestoreService
    if (firestoreService && firestoreService.db) {
      this.db = firestoreService.db;
      console.log('✅ [SCHEDULED] Got db from FirestoreService');
    } else {
      // Fallback to admin.firestore()
      this.db = admin.firestore();
      console.log('⚠️ [SCHEDULED] Using admin.firestore() directly');
    }
    
    // FCM Collections
    this.FCM_TOKENS = 'fcm_tokens';
    this.NOTIFICATIONS = 'notifications';
    this.CANCELLATIONS = 'trip_cancellations'; // New collection for cancellation records
    
    this.matchingInterval = null;
    this.cycleCount = 0;
    
    logger.info('SCHEDULED_SERVICE', '🚀 Scheduled Service initialized');
  }
  
  async start() {
    console.log('🚀 [SCHEDULED] start() called');
    logger.info('SCHEDULED_SERVICE', '🚀 Starting Scheduled Service...');
    
    // Test Firestore connection
    console.log('🔍 [SCHEDULED] Testing Firestore connection...');
    try {
      const testRef = this.db.collection('scheduled_test').doc('connection_test');
      await testRef.set({ 
        test: true, 
        timestamp: new Date().toISOString() 
      });
      console.log('✅ [SCHEDULED] Firestore write successful');
      
      const doc = await testRef.get();
      console.log('✅ [SCHEDULED] Firestore read successful, exists:', doc.exists);
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Firestore error:', error.message);
    }
    
    // Start matching interval (every 30 seconds)
    this.matchingInterval = setInterval(async () => {
      this.cycleCount++;
      console.log(`🔄 [SCHEDULED] Interval triggered, cycle: ${this.cycleCount}`);
      logger.info('SCHEDULED_SERVICE', `🔄 Matching Cycle #${this.cycleCount}`);
      
      // Perform matching logic
      await this.performMatching();
      
      // Clean up expired matches
      await this.cleanupExpiredMatches();
    }, 30000); // 30 seconds
    
    logger.info('SCHEDULED_SERVICE', '✅ Scheduled Service started');
    return true;
  }
  
  // ========== PHONE NUMBER SANITIZATION ==========
  // FIXED: Preserves plus sign at the beginning of phone numbers
  
  sanitizePhoneNumber(phoneNumber) {
    if (!phoneNumber) return 'unknown_user';
    
    // Convert to string
    let sanitized = String(phoneNumber).trim();
    
    // If it's empty after trimming
    if (sanitized.length === 0) {
      return 'unknown_user';
    }
    
    // Allow plus sign at the beginning, but sanitize other special characters
    // This regex preserves plus at start but replaces other special chars
    sanitized = sanitized.replace(/[^a-zA-Z0-9_\-.]/g, (match, index) => {
      // Keep plus sign only at the beginning
      return (index === 0 && match === '+') ? '+' : '_';
    });
    
    // Ensure it doesn't start with underscore (unless it's a plus)
    if (sanitized.startsWith('_')) {
      sanitized = 'user' + sanitized;
    }
    
    // Keep it reasonable
    if (sanitized.length > 100) {
      sanitized = sanitized.substring(0, 100);
    }
    
    // Ensure it's not empty after all processing
    if (sanitized.length === 0) {
      sanitized = 'user_' + Date.now();
    }
    
    return sanitized;
  }
  
  // ========== FCM TOKEN MANAGEMENT WITH PHONE NUMBER AS DOCUMENT ID ==========
  
  /**
   * Register FCM token for a user - stores in fcm_tokens collection with phone number as document ID
   * Also updates user document for redundancy
   */
  async registerFCMToken(userId, token, deviceInfo = {}, userType = null) {
    console.log(`📱 [FCM] Registering token for user ${userId}`);
    
    try {
      if (!userId || !token) {
        throw new Error('User ID and token are required');
      }
      
      // IMPORTANT: Use original userId with plus sign as document ID
      const documentId = userId; // Keep the plus sign!
      const sanitizedUserId = this.sanitizePhoneNumber(userId);
      const now = new Date().toISOString();
      
      // Batch write for atomic operation
      const batch = this.db.batch();
      
      // ===== Store in fcm_tokens collection with ORIGINAL phone number as document ID =====
      const fcmTokenRef = this.db.collection(this.FCM_TOKENS).doc(documentId);
      
      // Get existing token data to preserve history if needed
      const existingDoc = await fcmTokenRef.get();
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
        if (previousTokens.length > 5) {
          previousTokens.shift();
        }
      }
      
      // Set the new token data - ALWAYS set active to true when registering
      batch.set(fcmTokenRef, {
        userId: documentId, // Use original with plus sign
        sanitizedUserId: sanitizedUserId, // Keep sanitized version for queries
        originalUserId: userId, // Keep original for reference
        token: token,
        phoneNumber: userId,
        platform: deviceInfo.platform || deviceInfo.os || 'unknown',
        deviceInfo: deviceInfo || {},
        deviceModel: deviceInfo.model || deviceInfo.deviceModel || 'unknown',
        deviceOS: deviceInfo.osVersion || deviceInfo.platformVersion || 'unknown',
        appVersion: deviceInfo.appVersion || 'unknown',
        previousTokens: previousTokens,
        active: true, // Always set to true when registering
        registrationCount: existingDoc.exists ? (existingDoc.data().registrationCount || 0) + 1 : 1,
        lastUpdated: now,
        lastUsed: now,
        lastRegistration: now,
        createdAt: existingDoc.exists ? existingDoc.data().createdAt : now,
        updatedAt: now
      }, { merge: true });
      
      console.log(`✅ [FCM] Token stored/updated in fcm_tokens collection for ${documentId} (active: true)`);
      
      // ===== Also store in user document if userType is provided =====
      if (userType) {
        const userCollection = userType === 'driver' ? 'users_driver' : 'users_passenger';
        const userDocRef = this.db.collection(userCollection).doc(sanitizedUserId);
        
        batch.set(userDocRef, {
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
      
      // ===== Also store in general users collection =====
      const generalUserRef = this.db.collection('users').doc(sanitizedUserId);
      batch.set(generalUserRef, {
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
      await batch.commit();
      
      console.log(`✅ [FCM] Token registration complete for ${userId}`);
      
      // Update FirestoreService stats if available
      if (this.firestoreService && this.firestoreService.stats) {
        this.firestoreService.stats.writes += 3; // Three writes in batch
        this.firestoreService.stats.immediateWrites += 3;
      }
      
      return {
        success: true,
        userId: documentId,
        token: token,
        message: 'FCM token registered successfully',
        timestamp: now
      };
      
    } catch (error) {
      console.error('❌ [FCM] Error registering token:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Remove/invalidate FCM token for a user
   */
  async removeFCMToken(userId, token = null) {
    try {
      // Use original userId as document ID
      const documentId = userId;
      const sanitizedUserId = this.sanitizePhoneNumber(userId);
      const now = new Date().toISOString();
      
      const batch = this.db.batch();
      
      // ===== Update fcm_tokens document - mark as inactive but KEEP the token =====
      const fcmTokenRef = this.db.collection(this.FCM_TOKENS).doc(documentId);
      const fcmDoc = await fcmTokenRef.get();
      
      if (fcmDoc.exists) {
        const data = fcmDoc.data();
        
        // If specific token provided and it matches current token, deactivate
        if (token && data.token === token) {
          batch.update(fcmTokenRef, {
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
          batch.update(fcmTokenRef, {
            active: false,
            deactivatedAt: now,
            deactivationReason: 'user_logout_all',
            lastUpdated: now,
            token: data.token // Keep the token for reference
          });
          console.log(`✅ [FCM] Deactivated all tokens for ${documentId} (kept for reference)`);
        }
      }
      
      // ===== Update user documents - clear tokens from legacy collections =====
      // Update users_driver if exists
      const driverRef = this.db.collection('users_driver').doc(sanitizedUserId);
      try {
        const driverDoc = await driverRef.get();
        if (driverDoc.exists) {
          batch.update(driverRef, {
            fcmToken: null,
            fcmTokenRemovedAt: now
          });
        }
      } catch (e) {
        // Document doesn't exist, skip
      }
      
      // Update users_passenger if exists
      const passengerRef = this.db.collection('users_passenger').doc(sanitizedUserId);
      try {
        const passengerDoc = await passengerRef.get();
        if (passengerDoc.exists) {
          batch.update(passengerRef, {
            fcmToken: null,
            fcmTokenRemovedAt: now
          });
        }
      } catch (e) {
        // Document doesn't exist, skip
      }
      
      // Update general users collection
      const generalUserRef = this.db.collection('users').doc(sanitizedUserId);
      try {
        const generalUserDoc = await generalUserRef.get();
        if (generalUserDoc.exists) {
          batch.update(generalUserRef, {
            fcmToken: null,
            fcmTokenRemovedAt: now
          });
        }
      } catch (e) {
        // Document doesn't exist, skip
      }
      
      // Execute batch if there are operations
      if (batch._ops && batch._ops.length > 0) {
        await batch.commit();
      }
      
      return {
        success: true,
        message: 'FCM token deactivated successfully'
      };
      
    } catch (error) {
      console.error('❌ [FCM] Error removing token:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Get user's FCM token from Firestore - PRIORITY: fcm_tokens collection
   * FIXED: Now correctly handles phone numbers with plus signs
   */
  async getUserFCMToken(userId) {
    try {
      console.log(`🔍 [FCM] Getting token for user: ${userId}`);
      
      // ===== PRIORITY 1: Try with original userId (with plus sign) =====
      // This is the most likely location based on your Flutter app data
      const originalTokenDoc = await this.db.collection(this.FCM_TOKENS).doc(userId).get();
      
      if (originalTokenDoc.exists) {
        const tokenData = originalTokenDoc.data();
        console.log(`📄 [FCM] Found document with original ID: ${userId}`);
        console.log(`   - active: ${tokenData.active}`);
        console.log(`   - has token: ${!!tokenData.token}`);
        
        // Check if token is active AND has a token value
        if (tokenData.active !== false && tokenData.token) {
          console.log(`✅ [FCM] Found active token using original userId for ${userId}`);
          
          // Update last used timestamp (fire and forget)
          originalTokenDoc.ref.update({
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
      
      // ===== PRIORITY 2: Try with sanitized userId (without plus sign) =====
      const sanitizedUserId = this.sanitizePhoneNumber(userId);
      if (sanitizedUserId !== userId) {
        const sanitizedTokenDoc = await this.db.collection(this.FCM_TOKENS).doc(sanitizedUserId).get();
        
        if (sanitizedTokenDoc.exists) {
          const tokenData = sanitizedTokenDoc.data();
          console.log(`📄 [FCM] Found document with sanitized ID: ${sanitizedUserId}`);
          
          if (tokenData.active !== false && tokenData.token) {
            console.log(`✅ [FCM] Found active token using sanitized userId for ${sanitizedUserId}`);
            
            sanitizedTokenDoc.ref.update({
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
      
      // ===== PRIORITY 3: Check users_driver collection =====
      const driverDoc = await this.db.collection('users_driver').doc(sanitizedUserId).get();
      if (driverDoc.exists && driverDoc.data().fcmToken) {
        const token = driverDoc.data().fcmToken;
        console.log(`✅ [FCM] Found token in users_driver for ${sanitizedUserId}`);
        
        // Migrate to fcm_tokens (this will set it as active)
        await this.migrateTokenToFCMCollection(userId, token, driverDoc.data());
        
        return {
          success: true,
          token: token,
          source: 'users_driver'
        };
      }
      
      // ===== PRIORITY 4: Check users_passenger collection =====
      const passengerDoc = await this.db.collection('users_passenger').doc(sanitizedUserId).get();
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
      
      // ===== PRIORITY 5: Check general users collection =====
      const userDoc = await this.db.collection('users').doc(sanitizedUserId).get();
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
   * FIXED: Now uses original userId with plus sign as document ID
   */
  async migrateTokenToFCMCollection(userId, token, userData) {
    try {
      // Use original userId with plus sign as document ID
      const documentId = userId;
      
      const fcmTokenRef = this.db.collection(this.FCM_TOKENS).doc(documentId);
      
      // Check if already exists
      const existing = await fcmTokenRef.get();
      
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
          if (previousTokens.length > 5) {
            previousTokens.shift();
          }
          
          await fcmTokenRef.update({
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
          await fcmTokenRef.update({
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
          await fcmTokenRef.update({
            lastUsed: now,
            sanitizedUserId: sanitizedUserId
          }).catch(() => {});
        }
      } else {
        // Create token document
        await fcmTokenRef.set({
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
      const snapshot = await this.db.collection(this.FCM_TOKENS)
        .where('active', '==', true)
        .limit(limit)
        .get();
      
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
      // Use original userId as document ID
      const documentId = userId;
      const sanitizedUserId = this.sanitizePhoneNumber(userId);
      const now = new Date().toISOString();
      
      const batch = this.db.batch();
      let hasOperations = false;
      
      // Update fcm_tokens document - mark as inactive but KEEP the token
      const fcmTokenRef = this.db.collection(this.FCM_TOKENS).doc(documentId);
      const fcmDoc = await fcmTokenRef.get();
      
      if (fcmDoc.exists) {
        const data = fcmDoc.data();
        
        // If current token matches the invalid token, mark it inactive
        if (data.token === invalidToken) {
          batch.update(fcmTokenRef, {
            active: false,
            invalidAt: now,
            invalidationReason: 'fcm_token_not_registered',
            lastError: 'Token not registered with FCM',
            lastUpdated: now,
            token: data.token // Keep the token for reference
          });
          hasOperations = true;
          console.log(`✅ [FCM] Marked token as inactive for ${documentId} (kept for reference)`);
        }
      }
      
      // Clear tokens from legacy collections
      const legacyCollections = ['users_driver', 'users_passenger', 'users'];
      for (const collection of legacyCollections) {
        const ref = this.db.collection(collection).doc(sanitizedUserId);
        const doc = await ref.get();
        if (doc.exists) {
          batch.update(ref, {
            fcmToken: null,
            fcmTokenInvalid: true,
            fcmTokenInvalidAt: now
          });
          hasOperations = true;
        }
      }
      
      if (hasOperations) {
        await batch.commit();
        console.log(`✅ [FCM] Handled invalid token for ${documentId}`);
      }
      
    } catch (error) {
      console.error('❌ [FCM] Error handling invalid token:', error.message);
    }
  }
  
  // ========== ENRICH DRIVER DATA FROM USERS COLLECTION ==========
  
  async enrichDriverDataWithUserProfile(driverPhone, driverData) {
    try {
      const sanitizedPhone = this.sanitizePhoneNumber(driverPhone);
      
      // Try to get user profile from users collection
      const userDoc = await this.db.collection('users').doc(sanitizedPhone).get();
      
      if (userDoc.exists) {
        const userData = userDoc.data();
        console.log(`📋 [SCHEDULED] Found user profile for ${driverPhone}:`, {
          name: userData.name || userData.displayName,
          hasPhoto: !!(userData.photoUrl || userData.photoURL || userData.profilePhoto)
        });
        
        // Get the actual name and photo from user data
        const realName = userData.name || userData.displayName || userData.fullName;
        const realPhoto = userData.photoUrl || userData.photoURL || userData.profilePhoto;
        
        // Create enriched data
        const enrichedData = {
          ...driverData,
          driverName: realName || driverData.driverName || 'Driver',
          profilePhoto: realPhoto || driverData.profilePhoto || null,
          name: realName || driverData.name || 'Driver', // For backward compatibility
          photoUrl: realPhoto || driverData.photoUrl || null, // For backward compatibility
        };
        
        // Update vehicleInfo with real driver info
        if (enrichedData.vehicleInfo) {
          enrichedData.vehicleInfo = {
            ...enrichedData.vehicleInfo,
            driverName: realName || enrichedData.vehicleInfo.driverName || 'Driver',
            driverPhotoUrl: realPhoto || enrichedData.vehicleInfo.driverPhotoUrl || null,
          };
        } else {
          enrichedData.vehicleInfo = {
            type: enrichedData.vehicleType || 'Car',
            model: enrichedData.vehicleModel || 'Standard',
            color: enrichedData.vehicleColor || 'Not specified',
            plate: enrichedData.licensePlate || 'Not specified',
            driverName: realName || 'Driver',
            driverPhone: driverPhone,
            driverPhotoUrl: realPhoto || null,
            driverRating: enrichedData.rating || 5.0,
            driverTotalRides: enrichedData.totalRides || 0,
            driverCompletedRides: enrichedData.completedRides || 0,
            driverVerified: enrichedData.isVerified || false
          };
        }
        
        console.log(`✅ [SCHEDULED] Enriched driver data:`, {
          name: enrichedData.driverName,
          hasPhoto: !!enrichedData.profilePhoto
        });
        
        return enrichedData;
      } else {
        console.log(`⚠️ [SCHEDULED] No user profile found for ${driverPhone}`);
      }
    } catch (error) {
      console.error('❌ [SCHEDULED] Error enriching driver data:', error.message);
    }
    
    // Return original data if enrichment fails
    return driverData;
  }
  
  // ========== CREATE/UPDATE SCHEDULED SEARCH ==========
  
  async handleCreateScheduledSearch(data, userId, userType) {
    console.log('📝 [SCHEDULED] handleCreateScheduledSearch called');
    console.log('🔍 [SCHEDULED] userId:', userId, 'userType:', userType);
    
    try {
      if (!userId) {
        throw new Error('User ID (phone number) is required');
      }
      
      if (!userType || !['driver', 'passenger'].includes(userType)) {
        throw new Error('Valid user type (driver/passenger) is required');
      }
      
      const sanitizedPhone = this.sanitizePhoneNumber(userId);
      
      const collectionName = userType === 'driver' 
        ? 'scheduled_searches_driver' 
        : 'scheduled_searches_passenger';
      
      console.log('📁 [SCHEDULED] Using collection:', collectionName);
      console.log('📁 [SCHEDULED] Document ID will be:', sanitizedPhone);
      
      // Validate and prepare time data
      let scheduledTime;
      let scheduledTimestamp;
      
      if (userType === 'driver') {
        scheduledTime = data.scheduledTime || data.departureTime;
      } else {
        // Passenger format - extract from rideDetails
        scheduledTime = data.rideDetails?.scheduledTime || data.scheduledTime || data.departureTime;
      }
      
      if (!scheduledTime) {
        throw new Error('Scheduled time is required');
      }
      
      // Parse the scheduled time
      const parsedTime = new Date(scheduledTime);
      
      // Check if date is valid
      if (isNaN(parsedTime.getTime())) {
        throw new Error('Invalid scheduled time format');
      }
      
      scheduledTimestamp = parsedTime.getTime();
      const timeString = parsedTime.toISOString();
      
      // Extract passenger info if applicable
      let passengerInfo = null;
      let passengerPhotoUrl = null;
      
      if (userType === 'passenger') {
        // Check multiple possible sources for passenger data
        const passengerSource = data.passenger || data.passengerInfo || {};
        
        // Extract photo from multiple possible locations
        const extractedPhoto = passengerSource.photoUrl || 
                              data.passengerPhotoUrl || 
                              data.photoUrl ||
                              (data.passenger && data.passenger.photoUrl) ||
                              (data.passengerInfo && data.passengerInfo.photoUrl) ||
                              (data.rideDetails && data.rideDetails.passenger && data.rideDetails.passenger.photoUrl) ||
                              (data.passengerPhotoURL) ||
                              (data.profilePhoto) ||
                              null;
        
        passengerInfo = {
          name: passengerSource.name || data.passengerName || 'Passenger',
          phone: passengerSource.phone || userId,
          rating: passengerSource.rating || data.passengerRating || 5.0,
          totalRides: passengerSource.totalRides || data.totalRides || 0,
          completedRides: passengerSource.completedRides || data.completedRides || 0,
          isVerified: passengerSource.isVerified || data.isVerified || false,
          photoUrl: extractedPhoto
        };
        
        // Store at root level as well for easier access
        passengerPhotoUrl = extractedPhoto;
        
        console.log('📸 [SCHEDULED] Extracted passenger photo:', extractedPhoto ? 'Yes' : 'No');
      }
      
      // Create document data
      let scheduledSearchData = {
        type: userType === 'driver' ? 'CREATE_SCHEDULED_SEARCH' : 'SCHEDULE_SEARCH',
        userId: userId,  // Keep original phone number as field for queries
        sanitizedUserId: sanitizedPhone,
        userType: userType,
        status: 'actively_matching', // Start as actively matching
        scheduledTime: timeString,
        scheduledTimestamp: scheduledTimestamp,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastUpdated: Date.now()
      };
      
      // Add driver-specific fields
      if (userType === 'driver') {
        // First create basic driver data
        scheduledSearchData = {
          ...scheduledSearchData,
          availableSeats: data.availableSeats || data.capacity || 4,
          initialSeats: data.availableSeats || data.capacity || 4, // Store initial seats
          driverName: data.driverName || data.name || 'Driver',
          driverPhone: userId,
          pickupLocation: data.pickupLocation || null,
          destinationLocation: data.destinationLocation || null,
          pickupName: data.pickupName || 'Pickup location',
          destinationName: data.destinationName || 'Destination',
          vehicleType: data.vehicleType || 'Car',
          vehicleModel: data.vehicleModel || 'Standard',
          vehicleColor: data.vehicleColor || 'Not specified',
          licensePlate: data.licensePlate || 'Not specified',
          profilePhoto: data.profilePhoto || data.driverPhoto || null,
          rating: data.rating || data.driverRating || 5.0,
          totalRides: data.totalRides || 0,
          isVerified: data.isVerified || data.verified || false,
          acceptedPassengers: [], // Track accepted passengers with full details
          rejectedMatches: [], // Track rejected matches
          acceptedPassengersSummary: [], // Quick summary
          cancelledPassengersHistory: [], // Track cancelled passengers history
          totalAcceptedPassengers: 0, // Counter for total accepted
          lastActivityAt: new Date().toISOString(),
          lastActivityType: 'created_schedule'
        };
        
        // Vehicle info object for easier access
        scheduledSearchData.vehicleInfo = {
          type: data.vehicleType || 'Car',
          model: data.vehicleModel || 'Standard',
          color: data.vehicleColor || 'Not specified',
          plate: data.licensePlate || 'Not specified',
          capacity: data.availableSeats || data.capacity || 4,
          driverName: scheduledSearchData.driverName,
          driverPhone: userId,
          driverRating: scheduledSearchData.rating,
          driverTotalRides: scheduledSearchData.totalRides,
          driverCompletedRides: data.completedRides || 0,
          driverTotalEarnings: data.totalEarnings || 0,
          driverVerified: scheduledSearchData.isVerified,
          driverPhotoUrl: scheduledSearchData.profilePhoto
        };
        
        // ENRICH DRIVER DATA WITH USER PROFILE
        scheduledSearchData = await this.enrichDriverDataWithUserProfile(userId, scheduledSearchData);
        
        // Estimated fare if provided
        if (data.estimatedFare) {
          scheduledSearchData.estimatedFare = data.estimatedFare;
        }
        if (data.estimatedDistance) {
          scheduledSearchData.estimatedDistance = data.estimatedDistance;
        }
      }
      
      // Add passenger-specific fields
      if (userType === 'passenger') {
        scheduledSearchData.passengerInfo = passengerInfo;
        scheduledSearchData.passengerPhotoUrl = passengerPhotoUrl;
        scheduledSearchData.passengerName = passengerInfo?.name || 'Passenger';
        scheduledSearchData.passengerPhone = userId;
        scheduledSearchData.passengerCount = data.passengerCount || 1;
        scheduledSearchData.pickupLocation = data.pickupLocation || null;
        scheduledSearchData.destinationLocation = data.destinationLocation || null;
        scheduledSearchData.pickupName = data.pickupName || 'Pickup location';
        scheduledSearchData.destinationName = data.destinationName || 'Destination';
        scheduledSearchData.luggageCount = data.luggageCount || 0;
        scheduledSearchData.specialRequests = data.specialRequests || '';
        scheduledSearchData.paymentMethod = data.paymentMethod || 'cash';
        scheduledSearchData.estimatedFare = data.estimatedFare || 0;
        scheduledSearchData.estimatedDistance = data.estimatedDistance || 0;
        scheduledSearchData.matchHistory = []; // Track match history
        scheduledSearchData.rating = data.rating || 5.0;
        scheduledSearchData.profilePhoto = passengerPhotoUrl || data.profilePhoto || null;
        
        // Ride details object for easier access
        scheduledSearchData.rideDetails = {
          scheduledTime: timeString,
          scheduledTimestamp: scheduledTimestamp,
          pickupName: data.pickupName || 'Pickup location',
          destinationName: data.destinationName || 'Destination',
          pickupLocation: data.pickupLocation || null,
          destinationLocation: data.destinationLocation || null,
          passengerCount: data.passengerCount || 1,
          luggageCount: data.luggageCount || 0,
          specialRequests: data.specialRequests || '',
          paymentMethod: data.paymentMethod || 'cash',
          estimatedFare: data.estimatedFare || 0,
          estimatedDistance: data.estimatedDistance || 0,
          passenger: {
            name: passengerInfo?.name || 'Passenger',
            phone: userId,
            photoUrl: passengerPhotoUrl,
            rating: data.rating || 5.0
          }
        };
      }
      
      // Add all data fields
      for (const [key, value] of Object.entries(data)) {
        if (!['userId', 'userType', 'status', 'scheduledTime', 'createdAt', 'updatedAt', 
              'availableSeats', 'driverName', 'passengerInfo'].includes(key)) {
          scheduledSearchData[key] = value;
        }
      }
      
      // ========== USE PHONE NUMBER AS DOCUMENT ID ==========
      const docRef = this.db.collection(collectionName).doc(sanitizedPhone);
      
      // Check if document exists
      const docSnapshot = await docRef.get();
      
      if (docSnapshot.exists) {
        // Update existing document
        const existingData = docSnapshot.data();
        
        // Create version history
        const previousVersions = existingData.previousVersions || [];
        const versionEntry = {
          status: existingData.status,
          scheduledTime: existingData.scheduledTime,
          availableSeats: existingData.availableSeats,
          updatedAt: existingData.updatedAt || existingData.lastUpdated,
          archivedAt: new Date().toISOString()
        };
        
        // Keep only last 5 versions
        const updatedVersions = [versionEntry, ...previousVersions].slice(0, 5);
        
        // Preserve accepted passengers and rejected matches if they exist
        if (userType === 'driver') {
          scheduledSearchData.acceptedPassengers = existingData.acceptedPassengers || [];
          scheduledSearchData.rejectedMatches = existingData.rejectedMatches || [];
          scheduledSearchData.acceptedPassengersSummary = existingData.acceptedPassengersSummary || [];
          scheduledSearchData.cancelledPassengersHistory = existingData.cancelledPassengersHistory || [];
          scheduledSearchData.totalAcceptedPassengers = existingData.totalAcceptedPassengers || 0;
          
          // Preserve vehicleInfo if it exists
          if (existingData.vehicleInfo) {
            scheduledSearchData.vehicleInfo = {
              ...existingData.vehicleInfo,
              ...scheduledSearchData.vehicleInfo
            };
          }
        }
        
        const updateData = {
          ...scheduledSearchData,
          createdAt: existingData.createdAt, // Preserve original creation time
          previousVersions: updatedVersions,
          updatedAt: new Date().toISOString(),
          lastUpdated: Date.now()
        };
        
        await docRef.update(updateData);
        
        console.log('✅ [SCHEDULED] Updated existing document with ID:', sanitizedPhone);
        console.log('⏰ [SCHEDULED] Original createdAt:', existingData.createdAt);
      } else {
        // Create new document with phone number as ID
        await docRef.set({
          ...scheduledSearchData,
          previousVersions: []
        });
        console.log('✅ [SCHEDULED] Created new document with ID:', sanitizedPhone);
      }
      
      console.log('⏰ [SCHEDULED] Scheduled time:', timeString);
      
      // Update FirestoreService stats if available
      if (this.firestoreService && this.firestoreService.stats) {
        this.firestoreService.stats.writes++;
        this.firestoreService.stats.immediateWrites++;
      }
      
      // Notify via WebSocket if available
      if (this.websocketServer && this.websocketServer.broadcast) {
        const notification = {
          type: 'scheduled_search_created',
          userId: userId,
          userType: userType,
          searchId: sanitizedPhone,
          scheduledTime: timeString,
          timestamp: new Date().toISOString()
        };
        
        try {
          this.websocketServer.broadcast('scheduled_updates', notification);
        } catch (wsError) {
          console.log('⚠️ [SCHEDULED] WebSocket broadcast error:', wsError.message);
        }
      }
      
      return {
        success: true,
        userId: userId,
        userType: userType,
        searchId: sanitizedPhone,
        scheduledTime: timeString,
        message: 'Scheduled search created successfully',
        data: {
          id: sanitizedPhone,
          ...scheduledSearchData
        }
      };
    } catch (error) {
      console.error('❌ [SCHEDULED] Error creating scheduled search:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  // ========== GET ACTIVE SCHEDULED SEARCHES ==========
  
  async getActiveScheduledSearches(userType) {
    const collectionName = userType === 'driver' 
      ? 'scheduled_searches_driver' 
      : 'scheduled_searches_passenger';
    
    try {
      // Get all documents in the collection
      const snapshot = await this.db.collection(collectionName).get();
      
      const results = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        
        // Check status - actively_matching is the key status for active matching
        const isValidStatus = data.status === 'actively_matching' || data.status === 'scheduled';
        
        // For drivers, additional check for available seats
        if (userType === 'driver' && isValidStatus) {
          const availableSeats = this.extractCapacity(data);
          if (availableSeats <= 0) {
            console.log(`ℹ️ [SCHEDULED] Driver ${doc.id} has no seats available (${availableSeats}), excluding from matching`);
            return; // Skip this driver
          }
        }
        
        if (isValidStatus) {
          results.push({ 
            id: doc.id,
            data: {
              ...data,
              userId: data.userId || data.passengerPhone || data.driverPhone || doc.id
            }
          });
        } else {
          console.log(`ℹ️ [SCHEDULED] Skipping ${userType} ${doc.id} with status: ${data.status}`);
        }
      });
      
      console.log(`📊 [SCHEDULED] Found ${results.length} active ${userType}s for matching`);
      return results;
      
    } catch (error) {
      console.error(`❌ [SCHEDULED] Error getting ${userType} searches:`, error.message);
      return [];
    }
  }
  
  // ========== GET USER SCHEDULED SEARCH ==========
  
  async getUserScheduledSearch(userType, phoneNumber) {
    if (!phoneNumber) {
      console.log('⚠️ [SCHEDULED] No phone number provided for getUserScheduledSearch');
      return null;
    }
    
    const collectionName = userType === 'driver' 
      ? 'scheduled_searches_driver' 
      : 'scheduled_searches_passenger';
    
    const sanitizedPhone = this.sanitizePhoneNumber(phoneNumber);
    
    try {
      // Direct document access by ID (much faster!)
      const docRef = this.db.collection(collectionName).doc(sanitizedPhone);
      const docSnapshot = await docRef.get();
      
      if (!docSnapshot.exists) {
        console.log(`ℹ️ [SCHEDULED] No ${userType} document found for ${sanitizedPhone}`);
        return null;
      }
      
      return { 
        id: docSnapshot.id, 
        ...docSnapshot.data() 
      };
    } catch (error) {
      console.error(`❌ [SCHEDULED] Error getting ${userType} search:`, error.message);
      return null;
    }
  }
  
  // ========== UPDATE SEARCH STATUS ==========
  
  async updateSearchStatus(userType, phoneNumber, updates) {
    if (!phoneNumber) {
      console.log('⚠️ [SCHEDULED] No phone number provided for updateSearchStatus');
      return false;
    }
    
    const collectionName = userType === 'driver' 
      ? 'scheduled_searches_driver' 
      : 'scheduled_searches_passenger';
    
    const sanitizedPhone = this.sanitizePhoneNumber(phoneNumber);
    
    try {
      const docRef = this.db.collection(collectionName).doc(sanitizedPhone);
      const docSnapshot = await docRef.get();
      
      if (!docSnapshot.exists) {
        console.log(`⚠️ [SCHEDULED] No ${userType} document found for ${sanitizedPhone}`);
        return false;
      }
      
      const fullUpdates = {
        ...updates,
        updatedAt: new Date().toISOString(),
        lastUpdated: Date.now()
      };
      
      await docRef.update(fullUpdates);
      
      if (this.firestoreService && this.firestoreService.stats) {
        this.firestoreService.stats.writes++;
      }
      
      console.log(`✅ [SCHEDULED] Updated ${userType} document for ${sanitizedPhone}`);
      if (updates.availableSeats !== undefined) {
        console.log(`💺 [SCHEDULED] New available seats: ${updates.availableSeats}`);
      }
      
      return true;
    } catch (error) {
      console.error(`❌ [SCHEDULED] Error updating ${userType} status:`, error.message);
      return false;
    }
  }
  
  // ========== PERFORM MATCHING ==========
  
  async performMatching() {
    console.log('🤝 [SCHEDULED] Performing matching...');
    
    try {
      // Get active scheduled searches
      const [drivers, passengers] = await Promise.all([
        this.getActiveScheduledSearches('driver'),
        this.getActiveScheduledSearches('passenger')
      ]);
      
      console.log(`📊 [SCHEDULED] Found ${drivers.length} active drivers and ${passengers.length} active passengers`);
      
      if (drivers.length === 0 || passengers.length === 0) {
        console.log('ℹ️ [SCHEDULED] Not enough users for matching');
        return;
      }
      
      // Simple matching algorithm
      const matches = [];
      const processedPairs = new Set(); // Prevent duplicate matches
      
      for (const driver of drivers) {
        const driverData = driver.data;
        if (!driverData) {
          console.log('⚠️ [SCHEDULED] Skipping driver with invalid data:', driver.id);
          continue;
        }
        
        const driverLocation = this.extractLocation(driverData, 'pickupLocation');
        const driverTime = this.extractTime(driverData);
        const driverDestination = this.extractLocation(driverData, 'destinationLocation');
        const availableSeats = this.extractCapacity(driverData);
        
        if (!driverTime) {
          console.log(`⚠️ [SCHEDULED] Driver ${driver.id} has no valid time, skipping`);
          continue;
        }
        
        if (availableSeats <= 0) {
          console.log(`ℹ️ [SCHEDULED] Driver ${driver.id} has no seats available (${availableSeats}), skipping`);
          continue;
        }
        
        console.log(`👨‍✈️ [SCHEDULED] Driver ${driver.id} - Time: ${new Date(driverTime).toISOString()}, Seats: ${availableSeats}`);
        
        for (const passenger of passengers) {
          const passengerData = passenger.data;
          if (!passengerData) {
            console.log('⚠️ [SCHEDULED] Skipping passenger with invalid data:', passenger.id);
            continue;
          }
          
          // Skip if this pair was already processed
          const pairKey = `${driver.id}:${passenger.id}`;
          if (processedPairs.has(pairKey)) {
            continue;
          }
          processedPairs.add(pairKey);
          
          // Skip if passenger already has a pending match
          if (passengerData.status !== 'actively_matching' && passengerData.status !== 'scheduled') {
            console.log(`ℹ️ [SCHEDULED] Passenger ${passenger.id} has status ${passengerData.status}, skipping`);
            continue;
          }
          
          const passengerTime = this.extractTime(passengerData);
          const passengerLocation = this.extractLocation(passengerData, 'pickupLocation');
          const passengerDestination = this.extractLocation(passengerData, 'destinationLocation');
          const passengerCount = passengerData.passengerCount || 1;
          
          if (!passengerTime || !passengerLocation) {
            console.log(`⚠️ [SCHEDULED] Passenger ${passenger.id} missing required data, skipping`);
            continue;
          }
          
          // Skip if passenger count exceeds available seats
          if (passengerCount > availableSeats) {
            console.log(`  ❌ Passenger needs ${passengerCount} seats, driver only has ${availableSeats}`);
            continue;
          }
          
          // ===== TIME CHECK - ANY TIME ALLOWED =====
          const timeDiff = Math.abs(driverTime - passengerTime);
          const timeDiffHours = Math.round(timeDiff / (1000 * 60 * 60) * 10) / 10;
          console.log(`  ⏱️ Time difference: ${timeDiffHours} hours (any time allowed)`);
          
          // ===== LOCATION PROXIMITY CHECK =====
          if (!driverLocation || !passengerLocation) {
            console.log(`  ❌ Missing location data`);
            continue;
          }
          
          let distance = Infinity;
          try {
            distance = this.calculateDistance(driverLocation, passengerLocation);
            const distanceKm = Math.round(distance / 1000 * 10) / 10;
            
            // Distance threshold (20km)
            const distanceThreshold = 20000;
            
            console.log(`  📍 Distance: ${distanceKm}km, threshold: ${distanceThreshold/1000}km`);
            
            if (distance > distanceThreshold) {
              console.log(`  ❌ Distance too far: ${distanceKm}km > ${distanceThreshold/1000}km`);
              continue;
            }
          } catch (error) {
            console.error('❌ [SCHEDULED] Error calculating distance:', error);
            continue;
          }
          
          // ===== DESTINATION PROXIMITY CHECK =====
          let destinationDistance = Infinity;
          if (driverDestination && passengerDestination) {
            try {
              destinationDistance = this.calculateDistance(driverDestination, passengerDestination);
              const destDistanceKm = Math.round(destinationDistance / 1000 * 10) / 10;
              const destThreshold = 30000;
              
              console.log(`  🎯 Destination distance: ${destDistanceKm}km, threshold: ${destThreshold/1000}km`);
              
              if (destinationDistance > destThreshold) {
                console.log(`  ❌ Destinations too far: ${destDistanceKm}km > ${destThreshold/1000}km`);
                continue;
              }
            } catch (error) {
              console.log(`  ⚠️ Could not calculate destination distance`);
            }
          }
          
          // ===== CALCULATE MATCH SCORE =====
          const matchScore = this.calculateProximityScore(
            distance, 
            destinationDistance,
            availableSeats, 
            passengerCount
          );
          
          console.log(`  ✅ Match score: ${matchScore}%`);
          
          if (matchScore >= 40) {
            matches.push({
              driverId: driver.id,
              passengerId: passenger.id,
              driverPhone: driverData.userId || driverData.driverPhone || driver.id,
              passengerPhone: passengerData.userId || passengerData.passengerPhone || passenger.id,
              score: matchScore,
              timeDifference: Math.round(timeDiff / 1000),
              distance: Math.round(distance),
              destinationDistance: Math.round(destinationDistance),
              timestamp: new Date().toISOString(),
              driverData: driverData,
              passengerData: passengerData,
              passengerCount: passengerCount,
              availableSeats: availableSeats
            });
            
            console.log(`✅ [SCHEDULED] Found potential match: Driver ${driver.id} ↔ Passenger ${passenger.id}`);
            console.log(`   Score: ${matchScore}%, Distance: ${Math.round(distance/1000)}km, Time diff: ${timeDiffHours}h`);
          }
        }
      }
      
      console.log(`🎯 [SCHEDULED] Found ${matches.length} potential matches`);
      
      // Sort matches by score (highest first)
      matches.sort((a, b) => b.score - a.score);
      
      // Process top matches
      for (const match of matches.slice(0, 5)) {
        await this.processMatch(match);
      }
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Matching error:', error.message);
      console.error('❌ [SCHEDULED] Error stack:', error.stack);
    }
  }
  
  /**
   * Calculate score based on proximity
   */
  calculateProximityScore(distance, destinationDistance, availableSeats, neededSeats) {
    let score = 60; // Base score
    
    try {
      // Location proximity (max 25 points)
      const maxDistance = 20000;
      if (distance < maxDistance) {
        const locationScore = 25 * (1 - distance / maxDistance);
        score += locationScore;
      }
      
      // Destination proximity (max 15 points)
      if (destinationDistance && destinationDistance < 30000) {
        const destScore = 15 * (1 - destinationDistance / 30000);
        score += destScore;
      }
      
      // Capacity match (max 10 points)
      if (availableSeats >= neededSeats) {
        if (availableSeats === neededSeats) {
          score += 10; // Perfect fit
        } else {
          score += 5; // Extra space
        }
      }
      
      return Math.min(Math.round(score), 100);
    } catch (error) {
      return 60;
    }
  }
  
  // ========== PROCESS MATCH ==========
  
  async processMatch(match) {
    try {
      console.log(`🤝 [SCHEDULED] Processing match for driver ${match.driverPhone} and passenger ${match.passengerPhone}`);
      
      // ENRICH DRIVER DATA WITH USER PROFILE BEFORE PROCESSING
      const enrichedDriverData = await this.enrichDriverDataWithUserProfile(
        match.driverPhone, 
        match.driverData
      );
      
      // Update match data with enriched driver info
      match.driverData = enrichedDriverData;
      
      // Extract driver and passenger details with enriched data
      const driverDetails = this.extractDriverDetails(match.driverData);
      const passengerDetails = this.extractPassengerDetails(match.passengerData);
      
      // Extract pickup and destination names
      const pickupName = match.passengerData.pickupName || 
                         match.passengerData.rideDetails?.pickupName || 
                         'Pickup location';
      const destinationName = match.passengerData.destinationName || 
                              match.passengerData.rideDetails?.destinationName || 
                              'Destination';
      
      // Create match document
      const matchData = {
        driverId: match.driverId,
        passengerId: match.passengerId,
        driverPhone: match.driverPhone,
        passengerPhone: match.passengerPhone,
        driverName: driverDetails.name,
        passengerName: passengerDetails.name,
        driverDetails: driverDetails,
        passengerDetails: passengerDetails,
        score: match.score,
        timeDifference: match.timeDifference,
        distance: match.distance,
        destinationDistance: match.destinationDistance,
        status: 'awaiting_driver_approval',
        approvalStep: 1,
        proposedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        driverDecision: null,
        passengerDecision: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        
        // Location data
        pickupLocation: this.extractLocation(match.driverData, 'pickupLocation') || 
                        this.extractLocation(match.passengerData, 'pickupLocation'),
        destinationLocation: this.extractLocation(match.driverData, 'destinationLocation') || 
                             this.extractLocation(match.passengerData, 'destinationLocation'),
        pickupName: pickupName,
        destinationName: destinationName,
        scheduledTime: match.driverData.scheduledTime || match.passengerData.scheduledTime,
        scheduledTimestamp: match.driverData.scheduledTimestamp || match.passengerData.scheduledTimestamp,
        
        // Passenger data (full for driver reference)
        passengerData: match.passengerData,
        driverData: match.driverData,
        
        matchDetails: {
          driverCapacity: match.availableSeats,
          passengerCount: match.passengerCount,
          estimatedFare: match.passengerData.estimatedFare || match.driverData.estimatedFare || 0,
          estimatedDistance: match.passengerData.estimatedDistance || match.driverData.estimatedDistance || 0,
          timeDifference: match.timeDifference,
          locationDistance: match.distance
        }
      };
      
      // Create match document with auto-generated ID
      const matchRef = this.db.collection('scheduled_matches').doc();
      await matchRef.set(matchData);
      
      console.log(`✅ [SCHEDULED] Match document created: ${matchRef.id}`);
      
      // Update driver status (temporarily store match info but stay actively_matching)
      await this.updateSearchStatus('driver', match.driverPhone, {
        status: 'actively_matching', // Keep matching!
        pendingMatchId: matchRef.id,
        pendingMatchWith: match.passengerPhone,
        pendingMatchStatus: 'awaiting_driver_approval',
        matchScore: match.score
      });
      
      // Update passenger status
      await this.updateSearchStatus('passenger', match.passengerPhone, {
        status: 'pending_driver_approval',
        matchId: matchRef.id,
        matchedWith: match.driverPhone,
        matchStatus: 'awaiting_driver_approval',
        matchScore: match.score,
        lastActivityAt: new Date().toISOString(),
        lastActivityType: 'match_proposed'
      });
      
      // Notify driver with enriched data
      await this.notifyDriverMatch(match, matchRef.id, driverDetails, passengerDetails);
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error processing match:', error.message);
    }
  }
  
  // ========== NOTIFICATION METHODS ==========
  
  async notifyDriverMatch(match, matchId, driverDetails, passengerDetails) {
    try {
      console.log('📸 [SCHEDULED] Sending passenger photo to driver:', 
        passengerDetails.profilePhoto ? 'Yes' : 'No');
      
      const pickupName = match.passengerData.pickupName || 
                         match.passengerData.rideDetails?.pickupName || 
                         'Pickup location';
      const destinationName = match.passengerData.destinationName || 
                              match.passengerData.rideDetails?.destinationName || 
                              'Destination';
      
      const driverNotification = {
        type: 'scheduled_match_proposed_to_driver',
        data: {
          matchId: matchId,
          matchType: 'driver_approval_needed',
          passengerPhone: match.passengerPhone,
          passengerName: passengerDetails.name,
          passengerDetails: passengerDetails,
          score: match.score,
          timeDifference: match.timeDifference,
          distance: match.distance,
          tripDetails: {
            pickupLocation: this.extractLocation(match.passengerData, 'pickupLocation'),
            destinationLocation: this.extractLocation(match.passengerData, 'destinationLocation'),
            pickupName: pickupName,
            destinationName: destinationName,
            scheduledTime: match.passengerData.scheduledTime || match.passengerData.rideDetails?.scheduledTime,
            scheduledTimestamp: match.passengerData.scheduledTimestamp,
            passengerCount: match.passengerCount,
            luggageCount: match.passengerData.luggageCount || 0,
            specialRequests: match.passengerData.specialRequests || '',
            preferredVehicleType: match.passengerData.preferredVehicleType || 'Any',
            estimatedFare: match.passengerData.estimatedFare,
            paymentMethod: match.passengerData.paymentMethod || 'cash'
          },
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          approvalDeadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          timestamp: new Date().toISOString(),
          driverCurrentStatus: {
            availableSeats: match.availableSeats,
            vehicleType: match.driverData.vehicleType || 'Car',
            vehicleModel: match.driverData.vehicleModel || 'Standard'
          },
          compatibilitySummary: {
            timeCompatibility: 'flexible',
            locationCompatibility: this.getLocationCompatibilityLevel(match.distance),
            capacityCompatibility: this.getCapacityCompatibility(
              match.availableSeats,
              match.passengerCount
            )
          }
        }
      };
      
      // Send notification
      await this.sendNotification(match.driverPhone, driverNotification, {
        important: true,
        storeInHistory: true
      });
      
      console.log(`📨 [SCHEDULED] Notification sent to driver: ${match.driverPhone}`);
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error sending driver notification:', error.message);
    }
  }
  
  async notifyPassengerMatch(matchData, matchId) {
    try {
      const passengerDetails = matchData.passengerDetails || {};
      
      const pickupName = matchData.pickupName || 
                         matchData.passengerData?.pickupName || 
                         'Pickup location';
      const destinationName = matchData.destinationName || 
                              matchData.passengerData?.destinationName || 
                              'Destination';
      
      const passengerNotification = {
        type: 'scheduled_match_proposed_to_passenger',
        data: {
          matchId: matchId,
          matchType: 'passenger_approval_needed',
          driverPhone: matchData.driverPhone,
          driverName: matchData.driverName,
          driverDetails: matchData.driverDetails,
          score: matchData.score,
          timeDifference: matchData.timeDifference,
          distance: matchData.distance,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          timestamp: new Date().toISOString(),
          tripDetails: {
            pickupLocation: matchData.pickupLocation,
            destinationLocation: matchData.destinationLocation,
            pickupName: pickupName,
            destinationName: destinationName,
            scheduledTime: matchData.scheduledTime,
            scheduledTimestamp: matchData.scheduledTimestamp,
            passengerCount: matchData.matchDetails?.passengerCount || 1,
            estimatedFare: matchData.matchDetails?.estimatedFare,
            paymentMethod: passengerDetails.paymentMethod || 'cash'
          },
          matchDetails: {
            pickupLocation: matchData.pickupLocation,
            destinationLocation: matchData.destinationLocation,
            scheduledTime: matchData.scheduledTime,
            estimatedFare: matchData.matchDetails?.estimatedFare,
            driverCapacity: matchData.matchDetails?.driverCapacity,
            passengerCount: matchData.matchDetails?.passengerCount || 1,
            timeDifference: matchData.timeDifference,
            locationDistance: matchData.distance
          },
          driverCurrentStatus: {
            availableSeats: matchData.driverDetails?.availableSeats || 4,
            vehicleType: matchData.driverDetails?.vehicleType || 'Car',
            vehicleModel: matchData.driverDetails?.vehicleModel || 'Standard'
          },
          compatibilitySummary: {
            timeCompatibility: 'flexible',
            locationCompatibility: this.getLocationCompatibilityLevel(matchData.distance),
            capacityCompatibility: this.getCapacityCompatibility(
              matchData.matchDetails?.driverCapacity || 4,
              matchData.matchDetails?.passengerCount || 1
            )
          }
        }
      };
      
      await this.sendNotification(matchData.passengerPhone, passengerNotification, {
        important: true,
        storeInHistory: true
      });
      
      console.log(`📨 [SCHEDULED] Notification sent to passenger: ${matchData.passengerPhone}`);
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error sending passenger notification:', error.message);
    }
  }
  
  async notifyMatchConfirmed(matchData, matchId, confirmingUserId, decision) {
    try {
      const confirmingUserType = confirmingUserId === matchData.passengerPhone ? 'passenger' : 'driver';
      
      // Build driver notification with proper vehicleInfo structure
      const driverNotification = {
        type: 'scheduled_match_confirmed',
        data: {
          matchId: matchId,
          confirmedBy: confirmingUserId,
          confirmedByType: confirmingUserType,
          passengerPhone: matchData.passengerPhone,
          passengerName: matchData.passengerName,
          passengerDetails: matchData.passengerDetails,
          confirmedAt: new Date().toISOString(),
          timestamp: new Date().toISOString(),
          contactInfo: {
            passengerPhone: matchData.passengerPhone,
            passengerName: matchData.passengerName,
            passengerPhoto: matchData.passengerDetails?.profilePhoto
          },
          matchDetails: matchData.matchDetails,
          pickupName: matchData.pickupName || 'Pickup location',
          destinationName: matchData.destinationName || 'Destination'
        }
      };
      
      // Build passenger notification with PROPER vehicleInfo structure
      const passengerNotification = {
        type: 'scheduled_match_confirmed',
        data: {
          matchId: matchId,
          confirmedBy: confirmingUserId,
          confirmedByType: confirmingUserType,
          driverPhone: matchData.driverPhone,
          driverName: matchData.driverName,
          driverDetails: {
            name: matchData.driverName,
            phone: matchData.driverPhone,
            photoUrl: matchData.driverDetails?.profilePhoto || matchData.driverData?.profilePhoto,
            rating: matchData.driverDetails?.rating || 5.0,
            availableSeats: matchData.matchDetails?.driverCapacity || 0,
            // Include the ENTIRE vehicleInfo object
            vehicleInfo: matchData.driverData?.vehicleInfo || {
              type: matchData.driverData?.vehicleType || 'Car',
              model: matchData.driverData?.vehicleModel || 'Standard',
              color: matchData.driverData?.vehicleColor || 'Not specified',
              plate: matchData.driverData?.licensePlate || 'Not specified',
              driverName: matchData.driverName,
              driverPhone: matchData.driverPhone,
              driverPhotoUrl: matchData.driverDetails?.profilePhoto || matchData.driverData?.profilePhoto,
              driverRating: matchData.driverDetails?.rating || 5.0,
              driverTotalRides: matchData.driverDetails?.totalRides || 0,
              driverCompletedRides: matchData.driverDetails?.completedRides || 0,
              driverVerified: matchData.driverDetails?.isVerified || false
            }
          },
          confirmedAt: new Date().toISOString(),
          timestamp: new Date().toISOString(),
          contactInfo: {
            driverPhone: matchData.driverPhone,
            driverName: matchData.driverName,
            vehicleInfo: matchData.driverData?.vehicleInfo || {
              type: matchData.driverData?.vehicleType || 'Car',
              model: matchData.driverData?.vehicleModel || 'Standard',
              color: matchData.driverData?.vehicleColor || 'Not specified',
              plate: matchData.driverData?.licensePlate || 'Not specified'
            },
            driverPhoto: matchData.driverDetails?.profilePhoto || matchData.driverData?.profilePhoto
          },
          matchDetails: matchData.matchDetails,
          pickupName: matchData.pickupName || 'Pickup location',
          destinationName: matchData.destinationName || 'Destination',
          scheduledTime: matchData.scheduledTime
        }
      };
      
      // Send notifications
      await Promise.all([
        this.sendNotification(matchData.driverPhone, driverNotification, { important: true }),
        this.sendNotification(matchData.passengerPhone, passengerNotification, { important: true })
      ]);
      
      console.log(`🎉 [SCHEDULED] Match ${matchId} confirmed!`);
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error sending confirmation notifications:', error.message);
    }
  }
  
  // ========== FCM-FIRST NOTIFICATION SENDING WITH DATA-ONLY HIGH PRIORITY ==========
  
  async sendNotification(userId, notification, options = {}) {
    try {
      console.log(`📨 [SCHEDULED] Sending notification to ${userId}, type: ${notification.type}`);
      
      const { 
        important = true, 
        storeInHistory = true,
        fcmPriority = 'high'
      } = options;
      
      let fcmSent = false;
      let wsSent = false;
      
      // STEP 1: Try FCM first (for offline delivery) - ALWAYS try for important notifications
      if (important && this.admin) {
        console.log(`📱 [SCHEDULED] Sending data-only high priority FCM first to ${userId}`);
        try {
          fcmSent = await this.sendFCMNotification(userId, notification);
          
          if (fcmSent) {
            console.log(`✅ [SCHEDULED] Data-only FCM notification sent to ${userId}`);
          } else {
            console.log(`⚠️ [SCHEDULED] Data-only FCM send failed for ${userId}`);
          }
        } catch (fcmError) {
          console.error(`❌ [SCHEDULED] FCM error for ${userId}:`, fcmError.message);
          fcmSent = false;
        }
      } else {
        console.log(`ℹ️ [SCHEDULED] Skipping FCM - important: ${important}, admin: ${!!this.admin}`);
      }
      
      // STEP 2: Try WebSocket for real-time delivery (if user is online)
      if (this.websocketServer && this.websocketServer.sendToUser) {
        try {
          wsSent = await this.websocketServer.sendToUser(userId, notification);
          if (wsSent) {
            console.log(`✅ [SCHEDULED] WebSocket notification sent to ${userId}`);
          }
        } catch (wsError) {
          console.error(`❌ [SCHEDULED] WebSocket error for ${userId}:`, wsError.message);
          wsSent = false;
        }
      }
      
      // STEP 3: Store in Firestore for history (always store important notifications)
      if (storeInHistory) {
        try {
          await this.storeNotification(userId, notification);
        } catch (storeError) {
          console.error(`❌ [SCHEDULED] Error storing notification:`, storeError.message);
        }
      }
      
      return { 
        success: fcmSent || wsSent, 
        method: fcmSent ? 'fcm' : (wsSent ? 'websocket' : 'none'),
        details: { fcmSent, wsSent }
      };
      
    } catch (error) {
      console.error(`❌ [SCHEDULED] Error in sendNotification for ${userId}:`, error.message);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Send FCM notification using token from fcm_tokens collection
   * FIXED: Data-only high priority messages - NO notification block
   * FIXED: Now correctly uses userId with plus sign to look up token
   */
  async sendFCMNotification(userId, notification) {
    let tokenResult = null;
    let token = null;
    
    try {
      if (!this.admin || !this.admin.messaging) {
        console.error('❌ [FCM] Firebase Admin messaging not available');
        return false;
      }
      
      // Get user's FCM token from fcm_tokens collection
      // The getUserFCMToken method now correctly handles both original and sanitized IDs
      tokenResult = await this.getUserFCMToken(userId);
      
      if (!tokenResult.success || !tokenResult.token) {
        console.log(`📱 [FCM] No active FCM token for user ${userId}`);
        return false;
      }
      
      token = tokenResult.token;
      console.log(`📱 [FCM] Found token for user ${userId} from ${tokenResult.source || 'unknown'}`);
      
      // Convert notification to data-only format
      const fcmData = this.convertToDataOnlyFCM(notification);
      
      // FIXED: Data-only message structure for FCM v1 API - NO notification block
      const message = {
        token: token,
        
        // ✅ ONLY data payload - no notification block
        data: fcmData.data,
        
        // Platform-specific high-priority settings
        android: {
          priority: 'high',  // High priority for immediate delivery
          ttl: 86400,        // Time to live in seconds (24 hours)
          // ✅ No notification config here either
          direct_boot_ok: true, // Allow delivery even in direct boot mode
        },
        
        apns: {
          headers: {
            'apns-priority': '10',  // 10 = high priority
            'apns-push-type': 'background',  // Background push for data-only
            'apns-expiration': '0'
          },
          payload: {
            aps: {
              'content-available': 1  // Important for background wake
              // ✅ No alert, sound, badge - just content-available
            }
          }
        },
        
        webpush: {
          headers: {
            Urgency: 'high',
            TTL: '86400'
          }
        }
      };
      
      // Send message
      const messaging = this.admin.messaging();
      const response = await messaging.send(message);
      
      console.log(`✅ [FCM] Data-only high priority sent to ${userId}:`, response);
      
      // Update last used timestamp - use original userId with plus sign
      this.db.collection(this.FCM_TOKENS).doc(userId).update({
        lastUsed: new Date().toISOString(),
        lastSuccessfulSend: new Date().toISOString()
      }).catch(() => {});
      
      return true;
      
    } catch (error) {
      console.error(`❌ [FCM] Error sending data-only FCM to ${userId}:`, error.message);
      
      // Check if token is invalid and handle appropriately
      if (error.code === 'messaging/registration-token-not-registered' ||
          error.code === 'messaging/invalid-registration-token' ||
          error.code === 'messaging/not-registered') {
        
        console.log(`⚠️ [FCM] Token invalid for ${userId}, marking as inactive...`);
        
        // Don't delete - just mark as inactive and keep for reference
        if (tokenResult && tokenResult.token) {
          await this.handleInvalidToken(userId, tokenResult.token);
        } else if (token) {
          await this.handleInvalidToken(userId, token);
        }
      }
      
      return false;
    }
  }
  
  /**
   * Convert notification to data-only FCM format
   * FIXED: Removes ALL notification blocks, only returns data payload
   */
  convertToDataOnlyFCM(notification) {
    const type = notification.type || 'unknown';
    const data = notification.data || notification;
    
    // Prepare the data payload - all strings as required by FCM
    const dataPayload = {
      // Required fields
      type: type,
      priority: 'high',
      timestamp: Date.now().toString(),
      
      // For Flutter to handle routing
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
      screen: this.getNotificationScreen(type),
      
      // The data payload should match exactly what your Flutter app expects
    };
    
    // Add all relevant data fields flattened (FCM data must be strings)
    const flattenData = this.flattenDataForFCM(data);
    
    // Merge flattened data with base payload
    Object.assign(dataPayload, flattenData);
    
    // For RIDE_REQUEST type, structure exactly as specified
    if (type === 'RIDE_REQUEST' || type.includes('RIDE') || type.includes('MATCH')) {
      if (data.matchId) dataPayload.matchId = data.matchId || '';
      
      // Ensure passenger details are properly stringified if needed
      if (data.passengerDetails) {
        dataPayload.passengerDetails = typeof data.passengerDetails === 'string' 
          ? data.passengerDetails 
          : JSON.stringify(data.passengerDetails);
      }
      
      if (data.tripDetails) {
        dataPayload.tripDetails = typeof data.tripDetails === 'string'
          ? data.tripDetails
          : JSON.stringify(data.tripDetails);
      }
      
      if (data.driverDetails) {
        dataPayload.driverDetails = typeof data.driverDetails === 'string'
          ? data.driverDetails
          : JSON.stringify(data.driverDetails);
      }
    }
    
    // Return ONLY data (no notification object)
    return {
      data: dataPayload
    };
  }
  
  /**
   * Flatten nested objects for FCM data payload
   * FCM data values must be strings
   */
  flattenDataForFCM(obj, prefix = '') {
    const result = {};
    
    for (const key in obj) {
      if (!obj.hasOwnProperty(key)) continue;
      
      const value = obj[key];
      const newKey = prefix ? `${prefix}_${key}` : key; // Use underscore for flattening
      
      if (value === null || value === undefined) {
        result[newKey] = '';
      } else if (typeof value === 'object') {
        if (value instanceof Date) {
          result[newKey] = value.toISOString();
        } else if (Array.isArray(value)) {
          result[newKey] = JSON.stringify(value);
        } else {
          // Recursively flatten nested objects
          const flattened = this.flattenDataForFCM(value, newKey);
          Object.assign(result, flattened);
        }
      } else {
        result[newKey] = String(value);
      }
    }
    
    return result;
  }
  
  // ========== NOTIFICATION STORAGE ==========
  
  async storeNotification(userId, notification) {
    try {
      const sanitizedUserId = this.sanitizePhoneNumber(userId);
      
      const notifData = {
        userId: sanitizedUserId,
        originalUserId: userId,
        type: notification.type,
        data: notification.data || notification,
        read: false,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      };
      
      const docRef = await this.db.collection(this.NOTIFICATIONS).add(notifData);
      return { success: true, id: docRef.id };
    } catch (error) {
      console.error('❌ [SCHEDULED] Error storing notification:', error.message);
      return { success: false };
    }
  }
  
  async getUserNotifications(userId, limit = 50, unreadOnly = false) {
    try {
      const sanitizedUserId = this.sanitizePhoneNumber(userId);
      
      let query = this.db.collection(this.NOTIFICATIONS)
        .where('userId', '==', sanitizedUserId)
        .orderBy('createdAt', 'desc')
        .limit(limit);
      
      if (unreadOnly) {
        query = query.where('read', '==', false);
      }
      
      const snapshot = await query.get();
      
      const notifications = [];
      snapshot.forEach(doc => {
        notifications.push({
          id: doc.id,
          ...doc.data()
        });
      });
      
      return { success: true, notifications };
    } catch (error) {
      console.error('❌ [SCHEDULED] Error getting notifications:', error.message);
      return { success: false, error: error.message };
    }
  }
  
  async markNotificationRead(notificationId) {
    try {
      await this.db.collection(this.NOTIFICATIONS).doc(notificationId).update({
        read: true,
        readAt: new Date().toISOString()
      });
      return { success: true };
    } catch (error) {
      console.error('❌ [SCHEDULED] Error marking notification read:', error.message);
      return { success: false };
    }
  }
  
  // ========== FCM CONVERSION - LEGACY METHOD (KEPT FOR BACKWARD COMPATIBILITY) ==========
  
  /**
   * Convert notification to FCM format - LEGACY
   * Kept for backward compatibility but not used in new data-only flow
   */
  convertToFCMNotification(notification) {
    const type = notification.type || 'unknown';
    const data = notification.data || notification;
    
    let title = 'ShareWay Notification';
    let body = 'You have a new notification';
    
    switch(type) {
      case 'scheduled_match_proposed_to_driver':
        title = 'New Passenger Match Found! 🚗';
        body = `${data.passengerName || 'A passenger'} needs a ride at ${data.tripDetails?.scheduledTime ? new Date(data.tripDetails.scheduledTime).toLocaleTimeString() : 'scheduled time'}`;
        break;
      case 'scheduled_match_proposed_to_passenger':
        title = 'Driver Found for Your Ride! ✅';
        body = `${data.driverName || 'A driver'} is available for your scheduled ride to ${data.destinationName || 'destination'}`;
        break;
      case 'scheduled_match_confirmed':
        title = 'Ride Match Confirmed! 🎉';
        body = `Your ride has been confirmed with ${data.driverName || data.passengerName || 'your match'}`;
        break;
      case 'DRIVER_CANCELLED_ALL':
        title = 'Trip Cancelled by Driver ⚠️';
        body = `Your driver ${data.driverName || ''} has cancelled the trip. Please find another ride.`;
        break;
      case 'DRIVER_CANCELLED_YOUR_RIDE':
        title = 'Ride Cancelled by Driver ⚠️';
        body = `Your driver ${data.driverName || ''} has cancelled your ride to ${data.yourBooking?.destinationName || 'destination'}. You can reschedule.`;
        break;
      case 'PASSENGER_CANCELLED_RIDE':
        title = 'Passenger Cancelled Ride ⚠️';
        body = `${data.passengerName || 'A passenger'} has cancelled their ride. Seats are now available again.`;
        break;
      case 'PASSENGER_CANCELLATION_CONFIRMED':
        title = 'Ride Cancelled Successfully ✅';
        body = `Your ride has been cancelled. You can schedule a new ride anytime.`;
        break;
      case 'scheduled_match_created':
        title = 'Schedule Created 📅';
        body = `Your trip to ${data.destinationName || 'destination'} on ${data.scheduledTime ? new Date(data.scheduledTime).toLocaleDateString() : 'scheduled date'} is set`;
        break;
    }
    
    // LEGACY: Contains notification block - not used in data-only flow
    return {
      notification: {
        title: title,
        body: body
      },
      data: {
        type: type,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
        screen: this.getNotificationScreen(type),
        timestamp: Date.now().toString(),
        ...this.flattenData(data)
      }
    };
  }
  
  getNotificationScreen(type) {
    const screens = {
      'scheduled_match_proposed_to_driver': 'match_proposal_driver',
      'scheduled_match_proposed_to_passenger': 'match_proposal_passenger',
      'scheduled_match_confirmed': 'active_ride',
      'DRIVER_CANCELLED_ALL': 'driver_schedule',
      'DRIVER_CANCELLED_YOUR_RIDE': 'passenger_schedule',
      'PASSENGER_CANCELLED_RIDE': 'driver_schedule',
      'PASSENGER_CANCELLATION_CONFIRMED': 'passenger_schedule',
      'scheduled_match_created': 'driver_schedule'
    };
    return screens[type] || 'home';
  }
  
  flattenData(obj, prefix = '') {
    const result = {};
    
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        const value = obj[key];
        const newKey = prefix ? `${prefix}.${key}` : key;
        
        if (value === null || value === undefined) {
          result[newKey] = '';
        } else if (typeof value === 'object') {
          if (value instanceof Date) {
            result[newKey] = value.toISOString();
          } else {
            const flattened = this.flattenData(value, newKey);
            Object.assign(result, flattened);
          }
        } else {
          result[newKey] = String(value);
        }
      }
    }
    
    return result;
  }
  
  // ========== MATCH DECISION HANDLERS ==========
  
  async handleMatchDecision(matchId, userPhone, userType, decision, reason = '') {
    console.log(`🎯 [SCHEDULED] handleMatchDecision called:`, {
      matchId,
      userPhone,
      userType,
      decision
    });
    
    if (!matchId || !userPhone || !userType || !decision) {
      return { success: false, error: 'Missing required parameters' };
    }
    
    if (userType === 'driver') {
      return await this.handleDriverMatchDecision(matchId, userPhone, decision);
    } else if (userType === 'passenger') {
      return await this.handlePassengerMatchDecision(matchId, userPhone, decision);
    } else {
      return { success: false, error: 'Invalid user type' };
    }
  }
  
  // ========== ONE-STEP APPROVAL: DRIVER ACCEPTANCE IMMEDIATELY CONFIRMS MATCH ==========
  
  async handleDriverMatchDecision(matchId, driverPhone, decision) {
    try {
      console.log(`🤔 [SCHEDULED] Driver ${driverPhone} decision for match ${matchId}: ${decision}`);
      
      const matchRef = this.db.collection('scheduled_matches').doc(matchId);
      const matchDoc = await matchRef.get();
      
      if (!matchDoc.exists) {
        throw new Error('Match not found');
      }
      
      const matchData = matchDoc.data();
      
      if (matchData.driverPhone !== driverPhone) {
        throw new Error('Unauthorized driver decision');
      }
      
      // Check if match is already expired
      if (matchData.status === 'expired') {
        return { 
          success: false, 
          error: 'Match has expired',
          matchId,
          decision
        };
      }
      
      const updateData = {
        driverDecision: decision,
        driverDecisionAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      if (decision === 'accept') {
        // ===== SEAT-FILLING LOGIC =====
        // Get current driver document to check available seats
        let driverDoc = await this.getUserScheduledSearch('driver', driverPhone);
        
        if (!driverDoc) {
          throw new Error('Driver scheduled search not found');
        }
        
        // ENRICH DRIVER DATA WITH USER PROFILE BEFORE USING
        driverDoc = await this.enrichDriverDataWithUserProfile(driverPhone, driverDoc);
        
        // Get current available seats (from driver document)
        let currentAvailableSeats = this.extractCapacity(driverDoc);
        
        // Get passenger count for this match
        const passengerCount = matchData.passengerData?.passengerCount || 
                               matchData.matchDetails?.passengerCount || 
                               1;
        
        console.log(`💺 [SCHEDULED] Current seats: ${currentAvailableSeats}, Needed: ${passengerCount}`);
        
        // Calculate new available seats
        const newAvailableSeats = currentAvailableSeats - passengerCount;
        
        // ===== ONE-STEP APPROVAL - IMMEDIATELY CONFIRMED =====
        updateData.status = 'confirmed';
        updateData.finalStatus = 'accepted';
        updateData.confirmedAt = new Date().toISOString();
        updateData.passengerDecision = 'accept'; // Auto-accept for passenger
        updateData.passengerDecisionAt = new Date().toISOString();
        updateData.passengerCount = passengerCount;
        updateData.remainingSeatsAfterThisMatch = Math.max(0, newAvailableSeats);
        
        await matchRef.update(updateData);
        
        // ===== Track accepted passenger with FULL details =====
        const passengerFullDetails = {
          // Basic info
          passengerPhone: matchData.passengerPhone,
          passengerName: matchData.passengerName,
          passengerCount: passengerCount,
          
          // Profile details from passengerData
          profilePhoto: matchData.passengerDetails?.profilePhoto || 
                        matchData.passengerData?.passengerPhotoUrl ||
                        matchData.passengerData?.passengerInfo?.photoUrl ||
                        null,
          
          photoUrl: matchData.passengerDetails?.profilePhoto || 
                    matchData.passengerData?.passengerPhotoUrl ||
                    matchData.passengerData?.passengerInfo?.photoUrl ||
                    null,
          
          rating: matchData.passengerDetails?.rating || 
                  matchData.passengerData?.passengerInfo?.rating || 
                  5.0,
          
          totalRides: matchData.passengerDetails?.totalRides || 
                      matchData.passengerData?.passengerInfo?.totalRides || 
                      0,
          
          completedRides: matchData.passengerDetails?.completedRides || 
                          matchData.passengerData?.passengerInfo?.completedRides || 
                          0,
          
          isVerified: matchData.passengerDetails?.isVerified || 
                      matchData.passengerData?.passengerInfo?.isVerified || 
                      false,
          
          // Trip details
          pickupLocation: matchData.pickupLocation || 
                          matchData.passengerData?.pickupLocation || 
                          null,
          
          destinationLocation: matchData.destinationLocation || 
                               matchData.passengerData?.destinationLocation || 
                               null,
          
          pickupName: matchData.pickupName || 
                      matchData.passengerData?.pickupName || 
                      'Pickup location',
          
          destinationName: matchData.destinationName || 
                           matchData.passengerData?.destinationName || 
                           'Destination',
          
          scheduledTime: matchData.scheduledTime || 
                         matchData.passengerData?.scheduledTime || 
                         null,
          
          scheduledTimestamp: matchData.passengerData?.scheduledTimestamp || 
                              this.extractTime(matchData.passengerData) || 
                              null,
          
          // Payment and special requests
          paymentMethod: matchData.passengerDetails?.paymentMethod || 
                         matchData.passengerData?.paymentMethod || 
                         'cash',
          
          luggageCount: matchData.passengerData?.luggageCount || 0,
          
          specialRequests: matchData.passengerData?.specialRequests || '',
          
          // Match metadata
          matchId: matchId,
          acceptedAt: new Date().toISOString(),
          confirmedAt: new Date().toISOString(),
          status: 'confirmed',
          
          // Additional passenger info if available
          passengerInfo: matchData.passengerData?.passengerInfo || 
                         matchData.passengerDetails || 
                         null,
          
          // Contact info (for quick access)
          contactInfo: {
            phone: matchData.passengerPhone,
            name: matchData.passengerName,
            photoUrl: matchData.passengerDetails?.profilePhoto || 
                      matchData.passengerData?.passengerPhotoUrl ||
                      null
          },
          
          // Location coordinates for mapping
          locationCoordinates: {
            pickup: matchData.pickupLocation || matchData.passengerData?.pickupLocation,
            destination: matchData.destinationLocation || matchData.passengerData?.destinationLocation
          },
          
          // Fare information
          estimatedFare: matchData.matchDetails?.estimatedFare || 
                         matchData.passengerData?.estimatedFare || 
                         0,
          
          // Driver's vehicle info at time of acceptance (for reference)
          driverVehicleAtAcceptance: {
            type: driverDoc.vehicleType || 'Car',
            model: driverDoc.vehicleModel || 'Standard',
            color: driverDoc.vehicleColor || 'Not specified',
            plate: driverDoc.licensePlate || 'Not specified'
          }
        };
        
        // Update accepted passengers list with FULL details
        const currentAccepted = driverDoc.acceptedPassengers || [];
        const updatedAccepted = [...currentAccepted, passengerFullDetails];
        
        // Create summary for quick access
        const acceptedSummary = updatedAccepted.map(p => ({
          phone: p.passengerPhone,
          name: p.passengerName,
          count: p.passengerCount,
          status: p.status,
          photoUrl: p.profilePhoto,
          matchId: p.matchId,
          acceptedAt: p.acceptedAt,
          confirmedAt: p.confirmedAt,
          pickupName: p.pickupName,
          destinationName: p.destinationName,
          estimatedFare: p.estimatedFare
        }));
        
        // Determine driver's new status based on remaining seats
        let driverNewStatus;
        if (newAvailableSeats <= 0) {
          driverNewStatus = 'fully_booked';
          console.log(`✅ [SCHEDULED] Driver fully booked after accepting ${passengerCount} passengers`);
        } else {
          driverNewStatus = 'actively_matching'; // KEEP MATCHING!
          console.log(`✅ [SCHEDULED] Driver still has ${newAvailableSeats} seats available, continuing to match`);
        }
        
        // Update driver document with new seat count, status, and FULL passenger details
        const driverUpdateData = {
          status: driverNewStatus,
          availableSeats: Math.max(0, newAvailableSeats),
          acceptedPassengers: updatedAccepted,
          acceptedPassengersSummary: acceptedSummary,
          lastAcceptedAt: new Date().toISOString(),
          lastConfirmedAt: new Date().toISOString(),
          // Clear pending match since it's now accepted
          pendingMatchId: null,
          pendingMatchWith: null,
          pendingMatchStatus: null,
          // Update total accepted passengers count
          totalAcceptedPassengers: (driverDoc.totalAcceptedPassengers || 0) + passengerCount,
          // Update last activity
          lastActivityAt: new Date().toISOString(),
          lastActivityType: 'confirmed_match'
        };
        
        await this.updateSearchStatus('driver', driverPhone, driverUpdateData);
        
        // Build driver details for passenger with REAL name and photo
        const driverDetailsForPassenger = {
          name: driverDoc.driverName || 'Driver',
          phone: driverPhone,
          photoUrl: driverDoc.profilePhoto || null,
          rating: driverDoc.rating || 5.0,
          availableSeats: newAvailableSeats,
          
          // NEST THE ENTIRE vehicleInfo OBJECT with REAL driver info
          vehicleInfo: driverDoc.vehicleInfo || {
            type: driverDoc.vehicleType || 'Car',
            model: driverDoc.vehicleModel || 'Standard',
            color: driverDoc.vehicleColor || 'Not specified',
            plate: driverDoc.licensePlate || 'Not specified',
            driverName: driverDoc.driverName || 'Driver',
            driverPhone: driverPhone,
            driverPhotoUrl: driverDoc.profilePhoto || null,
            driverRating: driverDoc.rating || 5.0,
            driverTotalRides: driverDoc.totalRides || 0,
            driverCompletedRides: driverDoc.completedRides || 0,
            driverVerified: driverDoc.isVerified || false
          }
        };
        
        console.log(`✅ [SCHEDULED] Driver details for passenger:`, {
          name: driverDetailsForPassenger.name,
          hasPhoto: !!driverDetailsForPassenger.photoUrl,
          vehicleDriverName: driverDetailsForPassenger.vehicleInfo?.driverName
        });
        
        // Update passenger status - NOW CONFIRMED IMMEDIATELY with PROPER driver details
        await this.updateSearchStatus('passenger', matchData.passengerPhone, {
          status: 'matched_confirmed',
          matchId: matchId,
          matchedWith: driverPhone,
          matchStatus: 'confirmed',
          confirmedAt: new Date().toISOString(),
          driverAccepted: true,
          driverAcceptedAt: new Date().toISOString(),
          
          // Use the properly structured driverDetails object with REAL data
          driverDetails: driverDetailsForPassenger,
          
          // Keep for backward compatibility
          driverDetailsAtConfirmation: driverDetailsForPassenger
        });
        
        // Send immediate confirmation to BOTH parties
        await this.notifyMatchConfirmed(matchData, matchId, driverPhone, decision);
        
        console.log(`✅ [SCHEDULED] Match ${matchId} confirmed immediately by driver!`);
        console.log(`💺 [SCHEDULED] Seats left: ${newAvailableSeats}`);
        console.log(`📸 [SCHEDULED] Passenger photo stored: ${passengerFullDetails.profilePhoto ? 'Yes' : 'No'}`);
        console.log(`📸 [SCHEDULED] Driver photo stored: ${driverDetailsForPassenger.photoUrl ? 'Yes' : 'No'}`);
        console.log(`📊 [SCHEDULED] Total accepted passengers: ${updatedAccepted.length}`);
        console.log(`🚗 [SCHEDULED] Driver vehicleInfo saved to passenger document:`, 
          driverDetailsForPassenger.vehicleInfo ? 'Yes' : 'No');
        
        // Send confirmation response to driver
        await this.sendMatchDecisionResponse(driverPhone, {
          type: 'SCHEDULED_MATCH_CONFIRMED',
          data: {
            success: true,
            matchId,
            confirmedBy: driverPhone,
            userType: 'driver',
            status: 'confirmed',
            seatsLeft: Math.max(0, newAvailableSeats),
            isFullyBooked: newAvailableSeats <= 0,
            confirmedPassenger: passengerFullDetails,
            confirmedPassengersCount: updatedAccepted.length,
            message: newAvailableSeats <= 0 ? 
              'Match confirmed - You are now fully booked!' : 
              `Match confirmed - ${newAvailableSeats} seats remaining`,
            timestamp: new Date().toISOString()
          }
        });
        
        // Send immediate confirmation to passenger with PROPER driver details
        await this.sendNotification(matchData.passengerPhone, {
          type: 'SCHEDULED_MATCH_CONFIRMED',
          data: {
            success: true,
            matchId,
            confirmedBy: driverPhone,
            userType: 'driver',
            status: 'confirmed',
            
            // Include properly structured driver details with REAL data
            driverDetails: driverDetailsForPassenger,
            
            tripDetails: {
              pickupName: matchData.pickupName || 'Pickup location',
              destinationName: matchData.destinationName || 'Destination',
              scheduledTime: matchData.scheduledTime,
              passengerCount: passengerCount
            },
            message: 'Your ride has been confirmed! The driver will contact you soon.',
            timestamp: new Date().toISOString()
          }
        }, { important: true });
        
      } else if (decision === 'reject') {
        updateData.status = 'driver_rejected';
        updateData.finalStatus = 'rejected';
        
        await matchRef.update(updateData);
        
        // Get driver document to track rejected matches
        const driverDoc = await this.getUserScheduledSearch('driver', driverPhone);
        
        // Track rejected match with details
        const rejectedMatch = {
          matchId: matchId,
          passengerPhone: matchData.passengerPhone,
          passengerName: matchData.passengerName,
          passengerCount: matchData.passengerCount || 1,
          rejectedAt: new Date().toISOString(),
          reason: 'driver_rejected',
          passengerPhoto: matchData.passengerDetails?.profilePhoto || 
                         matchData.passengerData?.passengerPhotoUrl ||
                         null
        };
        
        const currentRejected = driverDoc?.rejectedMatches || [];
        const updatedRejected = [...currentRejected, rejectedMatch];
        
        // Driver stays in matching pool when rejecting
        await this.updateSearchStatus('driver', driverPhone, {
          status: 'actively_matching', // Keep matching!
          pendingMatchId: null,
          pendingMatchWith: null,
          pendingMatchStatus: null,
          rejectedMatches: updatedRejected,
          lastRejectedAt: new Date().toISOString()
        });
        
        // Passenger goes back to matching pool
        await this.updateSearchStatus('passenger', matchData.passengerPhone, {
          status: 'actively_matching', // Back to available
          matchId: null,
          matchedWith: null,
          matchStatus: null,
          lastDriverRejection: {
            driverPhone: driverPhone,
            driverName: driverDoc?.driverName || 'Driver',
            rejectedAt: new Date().toISOString()
          }
        });
        
        console.log(`❌ [SCHEDULED] Driver ${driverPhone} rejected match ${matchId}`);
        
        // Send rejection confirmation to driver
        await this.sendMatchDecisionResponse(driverPhone, {
          type: 'SCHEDULED_MATCH_DECLINED_RESPONSE',
          data: {
            success: true,
            matchId,
            declinedBy: driverPhone,
            userType: 'driver',
            message: 'Match declined successfully',
            timestamp: new Date().toISOString()
          }
        });
        
        // Notify passenger that driver declined
        await this.sendNotification(matchData.passengerPhone, {
          type: 'SCHEDULED_MATCH_DRIVER_DECLINED',
          data: {
            matchId,
            message: 'Driver declined the match',
            timestamp: new Date().toISOString()
          }
        }, { important: true });
      }
      
      return { success: true, matchId, decision };
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error handling driver decision:', error.message);
      
      await this.sendMatchDecisionResponse(driverPhone, {
        type: 'ERROR',
        data: {
          message: 'Failed to process match decision',
          error: error.message,
          timestamp: new Date().toISOString()
        }
      });
      
      return { success: false, error: error.message };
    }
  }
  
  async handlePassengerMatchDecision(matchId, passengerPhone, decision) {
    try {
      console.log(`🤔 [SCHEDULED] Passenger ${passengerPhone} decision for match ${matchId}: ${decision}`);
      
      const matchRef = this.db.collection('scheduled_matches').doc(matchId);
      const matchDoc = await matchRef.get();
      
      if (!matchDoc.exists) {
        throw new Error('Match not found');
      }
      
      const matchData = matchDoc.data();
      
      if (matchData.passengerPhone !== passengerPhone) {
        throw new Error('Unauthorized passenger decision');
      }
      
      if (matchData.status === 'expired') {
        return { 
          success: false, 
          error: 'Match has expired',
          matchId,
          decision
        };
      }
      
      // In one-step approval, passenger shouldn't need to make decisions
      // But keep this for backward compatibility or special cases
      return { 
        success: false, 
        error: 'Passenger decisions are not required in one-step approval mode',
        matchId
      };
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error handling passenger decision:', error.message);
      
      await this.sendMatchDecisionResponse(passengerPhone, {
        type: 'ERROR',
        data: {
          message: 'Failed to process match decision',
          error: error.message,
          timestamp: new Date().toISOString()
        }
      });
      
      return { success: false, error: error.message };
    }
  }
  
  async sendMatchDecisionResponse(userId, response) {
    await this.sendNotification(userId, {
      type: response.type,
      data: response.data
    }, {
      important: true,
      storeInHistory: true
    });
  }
  
  // ========== DRIVER CANCELLATION HANDLERS ==========
  
  /**
   * Cancel entire driver schedule and notify all passengers
   */
  async handleDriverCancelAll(driverPhone, reason = 'driver_cancelled_trip') {
    console.log(`🚫 [SCHEDULED] Driver ${driverPhone} cancelling ALL passengers`);
    
    try {
      // Get driver's current schedule
      const driverDoc = await this.getUserScheduledSearch('driver', driverPhone);
      
      if (!driverDoc) {
        return { success: false, error: 'Driver schedule not found' };
      }
      
      // Get all accepted passengers before clearing
      const acceptedPassengers = driverDoc.acceptedPassengers || [];
      
      if (acceptedPassengers.length === 0) {
        // Just cancel the driver schedule if no passengers
        return await this.cancelScheduledSearch(driverPhone, 'driver', reason);
      }
      
      console.log(`👥 Notifying ${acceptedPassengers.length} passengers about cancellation`);
      
      // Batch operation for atomic updates
      const batch = this.db.batch();
      
      // 1. Update each passenger's document
      for (const passenger of acceptedPassengers) {
        const passengerPhone = passenger.passengerPhone;
        const passengerDocRef = this.db
          .collection('scheduled_searches_passenger')
          .doc(this.sanitizePhoneNumber(passengerPhone));
        
        batch.update(passengerDocRef, {
          status: 'cancelled_by_driver',
          cancellationReason: reason,
          cancelledAt: new Date().toISOString(),
          cancelledByDriver: {
            driverPhone: driverPhone,
            driverName: driverDoc.driverName,
            cancelledAt: new Date().toISOString(),
            reason: reason
          },
          updatedAt: new Date().toISOString(),
          lastUpdated: Date.now()
        });
        
        // 2. Update any active matches for these passengers
        if (passenger.matchId) {
          const matchRef = this.db.collection('scheduled_matches').doc(passenger.matchId);
          batch.update(matchRef, {
            status: 'cancelled_by_driver',
            finalStatus: 'cancelled',
            cancellationReason: reason,
            cancelledAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }
        
        // 3. Send WebSocket notification to passenger
        await this.sendNotification(passengerPhone, {
          type: 'DRIVER_CANCELLED_ALL',
          data: {
            message: 'Your driver has cancelled the trip',
            driverName: driverDoc.driverName,
            driverPhone: driverPhone,
            reason: reason,
            cancelledAt: new Date().toISOString(),
            passengerCount: acceptedPassengers.length,
            yourBooking: {
              passengerName: passenger.passengerName,
              pickupName: passenger.pickupName,
              destinationName: passenger.destinationName,
              scheduledTime: passenger.scheduledTime
            },
            canReschedule: true,
            rescheduleLink: `/passenger/schedule?reschedule=${passenger.matchId || ''}`
          }
        }, { important: true });
      }
      
      // 4. Update driver document - clear everything
      const driverDocRef = this.db
        .collection('scheduled_searches_driver')
        .doc(this.sanitizePhoneNumber(driverPhone));
      
      batch.update(driverDocRef, {
        status: 'cancelled',
        cancellationReason: reason,
        cancelledAt: new Date().toISOString(),
        availableSeats: driverDoc.initialSeats || 4, // Reset to initial seats
        acceptedPassengers: [], // Clear all passengers
        acceptedPassengersSummary: [],
        // Archive the accepted passengers for history
        cancelledPassengersHistory: [
          ...(driverDoc.cancelledPassengersHistory || []),
          {
            passengers: acceptedPassengers,
            cancelledAt: new Date().toISOString(),
            reason: reason,
            totalPassengers: acceptedPassengers.length
          }
        ],
        updatedAt: new Date().toISOString(),
        lastUpdated: Date.now()
      });
      
      // Execute all updates atomically
      await batch.commit();
      
      console.log(`✅ [SCHEDULED] Driver ${driverPhone} cancelled all ${acceptedPassengers.length} passengers`);
      
      // Broadcast to all connected clients about the cancellation
      if (this.websocketServer && this.websocketServer.broadcast) {
        this.websocketServer.broadcast('driver_cancelled_all', {
          driverPhone: driverPhone,
          driverName: driverDoc.driverName,
          passengerCount: acceptedPassengers.length,
          timestamp: new Date().toISOString()
        });
      }
      
      return {
        success: true,
        cancelledPassengers: acceptedPassengers.length,
        message: `Cancelled trip and notified ${acceptedPassengers.length} passengers`
      };
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error in handleDriverCancelAll:', error.message);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Cancel a single passenger and notify them
   */
  async handleDriverCancelPassenger(driverPhone, passengerPhone, reason = 'driver_cancelled_passenger') {
    console.log(`🚫 [SCHEDULED] Driver ${driverPhone} cancelling passenger ${passengerPhone}`);
    
    try {
      // Get driver's current schedule
      const driverDoc = await this.getUserScheduledSearch('driver', driverPhone);
      
      if (!driverDoc) {
        return { success: false, error: 'Driver schedule not found' };
      }
      
      // Find the specific passenger in accepted list
      const acceptedPassengers = driverDoc.acceptedPassengers || [];
      const passengerIndex = acceptedPassengers.findIndex(
        p => p.passengerPhone === passengerPhone
      );
      
      if (passengerIndex === -1) {
        return { success: false, error: 'Passenger not found in driver\'s accepted list' };
      }
      
      const cancelledPassenger = acceptedPassengers[passengerIndex];
      
      // Get passenger count to restore seats
      const passengerCount = cancelledPassenger.passengerCount || 1;
      const currentAvailableSeats = driverDoc.availableSeats || 0;
      const restoredSeats = currentAvailableSeats + passengerCount;
      
      // Batch operation for atomic updates
      const batch = this.db.batch();
      
      // 1. Remove passenger from driver's accepted list
      const updatedAccepted = acceptedPassengers.filter((_, index) => index !== passengerIndex);
      const updatedSummary = (driverDoc.acceptedPassengersSummary || [])
        .filter(p => p.phone !== passengerPhone);
      
      const driverDocRef = this.db
        .collection('scheduled_searches_driver')
        .doc(this.sanitizePhoneNumber(driverPhone));
      
      batch.update(driverDocRef, {
        acceptedPassengers: updatedAccepted,
        acceptedPassengersSummary: updatedSummary,
        availableSeats: restoredSeats,
        status: restoredSeats > 0 ? 'actively_matching' : 'fully_booked',
        // Track cancelled passenger in history
        cancelledPassengersHistory: [
          ...(driverDoc.cancelledPassengersHistory || []),
          {
            passenger: cancelledPassenger,
            cancelledAt: new Date().toISOString(),
            reason: reason
          }
        ],
        updatedAt: new Date().toISOString(),
        lastUpdated: Date.now()
      });
      
      // 2. Update passenger's document
      const passengerDocRef = this.db
        .collection('scheduled_searches_passenger')
        .doc(this.sanitizePhoneNumber(passengerPhone));
      
      batch.update(passengerDocRef, {
        status: 'cancelled_by_driver',
        cancellationReason: reason,
        cancelledAt: new Date().toISOString(),
        cancelledByDriver: {
          driverPhone: driverPhone,
          driverName: driverDoc.driverName,
          cancelledAt: new Date().toISOString(),
          reason: reason,
          previousMatchId: cancelledPassenger.matchId
        },
        matchId: null, // Clear match
        matchedWith: null,
        matchStatus: null,
        updatedAt: new Date().toISOString(),
        lastUpdated: Date.now()
      });
      
      // 3. Update match document if exists
      if (cancelledPassenger.matchId) {
        const matchRef = this.db.collection('scheduled_matches').doc(cancelledPassenger.matchId);
        batch.update(matchRef, {
          status: 'cancelled_by_driver',
          finalStatus: 'cancelled',
          cancellationReason: reason,
          cancelledAt: new Date().toISOString(),
          cancelledByDriver: {
            driverPhone: driverPhone,
            driverName: driverDoc.driverName,
            cancelledAt: new Date().toISOString()
          },
          updatedAt: new Date().toISOString()
        });
      }
      
      // Execute all updates
      await batch.commit();
      
      console.log(`✅ [SCHEDULED] Removed passenger ${passengerPhone} from driver ${driverPhone}`);
      console.log(`💺 [SCHEDULED] Seats restored: ${restoredSeats} (was ${currentAvailableSeats})`);
      
      // 4. Send WebSocket notification to the cancelled passenger
      await this.sendNotification(passengerPhone, {
        type: 'DRIVER_CANCELLED_YOUR_RIDE',
        data: {
          message: 'Driver has cancelled your ride',
          driverName: driverDoc.driverName,
          driverPhone: driverPhone,
          reason: reason,
          cancelledAt: new Date().toISOString(),
          yourBooking: {
            passengerName: cancelledPassenger.passengerName,
            pickupName: cancelledPassenger.pickupName,
            destinationName: cancelledPassenger.destinationName,
            scheduledTime: cancelledPassenger.scheduledTime,
            passengerCount: cancelledPassenger.passengerCount
          },
          // Option to reschedule or find new driver
          canReschedule: true,
          rescheduleLink: `/passenger/schedule?reschedule=${cancelledPassenger.matchId || ''}`
        }
      }, { important: true });
      
      // 5. If driver still has seats, broadcast that they're available again
      if (restoredSeats > 0) {
        if (this.websocketServer && this.websocketServer.broadcast) {
          this.websocketServer.broadcast('driver_seats_updated', {
            driverPhone: driverPhone,
            driverName: driverDoc.driverName,
            availableSeats: restoredSeats,
            timestamp: new Date().toISOString()
          });
        }
      }
      
      return {
        success: true,
        cancelledPassenger: {
          name: cancelledPassenger.passengerName,
          phone: cancelledPassenger.passengerPhone
        },
        remainingPassengers: updatedAccepted.length,
        availableSeats: restoredSeats,
        message: `Cancelled ride for ${cancelledPassenger.passengerName}`
      };
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error in handleDriverCancelPassenger:', error.message);
      return { success: false, error: error.message };
    }
  }
  
  // ========== PASSENGER CANCELLATION HANDLER WITH CANCELLATION RECORDS ==========
  
  /**
   * Passenger cancels their confirmed ride
   * Notifies driver, updates both documents, and creates cancellation record
   */
  async handlePassengerCancelRide(passengerPhone, driverPhone, reason = 'passenger_cancelled_ride') {
    console.log(`🚫 [SCHEDULED] Passenger ${passengerPhone} cancelling ride with driver ${driverPhone}`);
    
    try {
      // Get current documents
      const [passengerDoc, driverDoc] = await Promise.all([
        this.getUserScheduledSearch('passenger', passengerPhone),
        this.getUserScheduledSearch('driver', driverPhone)
      ]);
      
      if (!passengerDoc || !driverDoc) {
        return { success: false, error: 'Schedule not found' };
      }
      
      // Find passenger in driver's list
      const acceptedPassengers = driverDoc.acceptedPassengers || [];
      const passengerIndex = acceptedPassengers.findIndex(p => p.passengerPhone === passengerPhone);
      
      if (passengerIndex === -1) {
        return { success: false, error: 'Passenger not found in driver\'s list' };
      }
      
      const cancelledPassenger = acceptedPassengers[passengerIndex];
      const passengerCount = cancelledPassenger.passengerCount || 1;
      
      // Batch operation
      const batch = this.db.batch();
      
      // 1. Update passenger document
      const passengerRef = this.db.collection('scheduled_searches_passenger')
        .doc(this.sanitizePhoneNumber(passengerPhone));
      
      batch.update(passengerRef, {
        status: 'cancelled_by_passenger',
        cancellationReason: reason,
        cancelledAt: new Date().toISOString(),
        matchId: null,
        matchedWith: null,
        matchStatus: null,
        updatedAt: new Date().toISOString()
      });
      
      // 2. Update driver document
      const driverRef = this.db.collection('scheduled_searches_driver')
        .doc(this.sanitizePhoneNumber(driverPhone));
      
      const updatedAccepted = acceptedPassengers.filter((_, i) => i !== passengerIndex);
      const newAvailableSeats = (driverDoc.availableSeats || 0) + passengerCount;
      
      batch.update(driverRef, {
        acceptedPassengers: updatedAccepted,
        availableSeats: newAvailableSeats,
        status: newAvailableSeats > 0 ? 'actively_matching' : 'fully_booked',
        // Track cancelled passenger in history
        cancelledPassengersHistory: [
          ...(driverDoc.cancelledPassengersHistory || []),
          {
            passenger: cancelledPassenger,
            cancelledAt: new Date().toISOString(),
            cancelledBy: 'passenger',
            reason: reason,
            passengerPhone: passengerPhone,
            passengerName: cancelledPassenger.passengerName
          }
        ],
        updatedAt: new Date().toISOString()
      });
      
      // 3. Update match document if exists
      if (cancelledPassenger.matchId) {
        const matchRef = this.db.collection('scheduled_matches').doc(cancelledPassenger.matchId);
        batch.update(matchRef, {
          status: 'cancelled_by_passenger',
          cancellationReason: reason,
          cancelledAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
      
      await batch.commit();
      
      // ===== CREATE CANCELLATION RECORD =====
      const cancellationData = {
        cancellationType: 'passenger_cancelled',
        cancelledBy: passengerPhone,
        cancelledByRole: 'passenger',
        cancellationReason: reason,
        
        originalTrip: {
          matchId: cancelledPassenger.matchId,
          scheduleId: driverDoc.id,
          bookingId: passengerDoc.id,
          scheduledTime: cancelledPassenger.scheduledTime || passengerDoc.scheduledTime,
          pickupName: cancelledPassenger.pickupName || passengerDoc.pickupName,
          destinationName: cancelledPassenger.destinationName || passengerDoc.destinationName,
          pickupLocation: passengerDoc.pickupLocation,
          destinationLocation: passengerDoc.destinationLocation
        },
        
        driverDetails: {
          phone: driverPhone,
          name: driverDoc.driverName,
          photoUrl: driverDoc.profilePhoto,
          vehicleInfo: driverDoc.vehicleInfo || {
            type: driverDoc.vehicleType,
            model: driverDoc.vehicleModel,
            color: driverDoc.vehicleColor,
            plate: driverDoc.licensePlate
          },
          availableSeats: newAvailableSeats,
          totalPassengers: updatedAccepted.length
        },
        
        passengerDetails: {
          phone: passengerPhone,
          name: passengerDoc.passengerName,
          photoUrl: passengerDoc.passengerPhotoUrl,
          passengerCount: passengerCount,
          pickupName: cancelledPassenger.pickupName || passengerDoc.pickupName,
          destinationName: cancelledPassenger.destinationName || passengerDoc.destinationName
        },
        
        afterCancellation: {
          driverAvailableSeats: newAvailableSeats,
          driverRemainingPassengers: updatedAccepted.length,
          passengerStatus: 'cancelled',
          canDriverAcceptNew: newAvailableSeats > 0
        },
        
        createdAt: new Date().toISOString(),
        timestamp: Date.now()
      };
      
      // Store cancellation record in Firestore
      const cancellationRef = this.db.collection(this.CANCELLATIONS).doc();
      await cancellationRef.set({
        ...cancellationData,
        id: cancellationRef.id,
        createdAt: new Date().toISOString()
      });
      
      // Broadcast cancellation via WebSocket if available
      if (this.websocketServer && this.websocketServer.broadcast) {
        this.websocketServer.broadcast('trip_cancelled', {
          type: 'passenger_cancelled',
          data: cancellationData,
          timestamp: new Date().toISOString()
        });
      }
      
      console.log(`✅ [SCHEDULED] Passenger ${passengerPhone} cancelled ride with driver ${driverPhone}`);
      console.log(`💺 [SCHEDULED] Driver seats restored: ${newAvailableSeats} (was ${driverDoc.availableSeats || 0})`);
      console.log(`📝 [SCHEDULED] Cancellation record created: ${cancellationRef.id}`);
      
      // Send WebSocket notification to DRIVER
      await this.sendNotification(driverPhone, {
        type: 'PASSENGER_CANCELLED_RIDE',
        data: {
          message: `${passengerDoc.passengerName || 'A passenger'} has cancelled their ride`,
          passengerName: passengerDoc.passengerName || 'Passenger',
          passengerPhone: passengerPhone,
          passengerPhoto: passengerDoc.passengerPhotoUrl || passengerDoc.profilePhoto || null,
          reason: reason,
          cancelledAt: new Date().toISOString(),
          matchId: cancelledPassenger.matchId,
          cancellationId: cancellationRef.id,
          cancelledRide: {
            passengerName: cancelledPassenger.passengerName,
            pickupName: cancelledPassenger.pickupName || passengerDoc.pickupName,
            destinationName: cancelledPassenger.destinationName || passengerDoc.destinationName,
            scheduledTime: cancelledPassenger.scheduledTime || passengerDoc.scheduledTime,
            passengerCount: passengerCount
          },
          // Update driver about available seats
          availableSeats: newAvailableSeats,
          remainingPassengers: updatedAccepted.length,
          canAcceptNewPassengers: newAvailableSeats > 0
        }
      }, { important: true });
      
      // Send confirmation to PASSENGER
      await this.sendNotification(passengerPhone, {
        type: 'PASSENGER_CANCELLATION_CONFIRMED',
        data: {
          success: true,
          message: 'Your ride has been cancelled successfully',
          cancelledAt: new Date().toISOString(),
          matchId: cancelledPassenger.matchId,
          cancellationId: cancellationRef.id,
          driverName: driverDoc.driverName,
          driverPhone: driverPhone,
          cancelledRide: {
            pickupName: passengerDoc.pickupName,
            destinationName: passengerDoc.destinationName,
            scheduledTime: passengerDoc.scheduledTime
          },
          canScheduleNewRide: true
        }
      }, { important: true });
      
      // If driver still has seats, broadcast availability
      if (newAvailableSeats > 0 && this.websocketServer && this.websocketServer.broadcast) {
        this.websocketServer.broadcast('driver_seats_updated', {
          driverPhone: driverPhone,
          driverName: driverDoc.driverName,
          availableSeats: newAvailableSeats,
          passengerJustCancelled: passengerPhone,
          timestamp: new Date().toISOString()
        });
      }
      
      return {
        success: true,
        cancellationId: cancellationRef.id,
        matchId: cancelledPassenger.matchId,
        cancelledPassenger: {
          phone: passengerPhone,
          name: passengerDoc.passengerName || 'Passenger'
        },
        driverUpdate: {
          phone: driverPhone,
          name: driverDoc.driverName,
          remainingPassengers: updatedAccepted.length,
          availableSeats: newAvailableSeats
        },
        cancellationData,
        message: `Ride cancelled successfully. Driver ${driverDoc.driverName} has been notified.`
      };
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error in handlePassengerCancelRide:', error.message);
      
      // Notify passenger of error
      await this.sendNotification(passengerPhone, {
        type: 'ERROR',
        data: {
          message: 'Failed to cancel ride',
          error: error.message,
          timestamp: new Date().toISOString()
        }
      });
      
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Get cancellation records for a user (driver or passenger)
   */
  async getUserCancellations(userPhone, role = null, limit = 50) {
    try {
      const sanitizedPhone = this.sanitizePhoneNumber(userPhone);
      
      let query = this.db.collection(this.CANCELLATIONS)
        .orderBy('createdAt', 'desc')
        .limit(limit);
      
      if (role === 'driver') {
        query = query.where('driverDetails.phone', '==', userPhone);
      } else if (role === 'passenger') {
        query = query.where('passengerDetails.phone', '==', userPhone);
      } else {
        // Get both - use array-contains or compound query
        const driverCancellations = await this.db.collection(this.CANCELLATIONS)
          .where('driverDetails.phone', '==', userPhone)
          .orderBy('createdAt', 'desc')
          .limit(limit)
          .get();
        
        const passengerCancellations = await this.db.collection(this.CANCELLATIONS)
          .where('passengerDetails.phone', '==', userPhone)
          .orderBy('createdAt', 'desc')
          .limit(limit)
          .get();
        
        const allCancellations = [];
        driverCancellations.forEach(doc => allCancellations.push({ id: doc.id, ...doc.data() }));
        passengerCancellations.forEach(doc => allCancellations.push({ id: doc.id, ...doc.data() }));
        
        // Sort by createdAt desc
        allCancellations.sort((a, b) => 
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        
        return {
          success: true,
          cancellations: allCancellations.slice(0, limit)
        };
      }
      
      const snapshot = await query.get();
      const cancellations = [];
      snapshot.forEach(doc => {
        cancellations.push({
          id: doc.id,
          ...doc.data()
        });
      });
      
      return { success: true, cancellations };
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error getting user cancellations:', error.message);
      return { success: false, error: error.message, cancellations: [] };
    }
  }
  
  // ========== GET ACCEPTED PASSENGERS ==========
  
  /**
   * Get all accepted passengers for a driver
   */
  async getDriverAcceptedPassengers(driverPhone) {
    try {
      const driverDoc = await this.getUserScheduledSearch('driver', driverPhone);
      
      if (!driverDoc) {
        return { success: false, error: 'Driver not found', passengers: [] };
      }
      
      const acceptedPassengers = driverDoc.acceptedPassengers || [];
      const summary = driverDoc.acceptedPassengersSummary || [];
      
      // Enhance passenger data with any additional info
      const enhancedPassengers = acceptedPassengers.map(passenger => ({
        ...passenger,
        // Ensure we have all needed fields
        displayName: passenger.passengerName || passenger.name || 'Passenger',
        photoUrl: passenger.profilePhoto || passenger.photoUrl || passenger.passengerInfo?.photoUrl,
        timeUntilPickup: this.calculateTimeUntilPickup(passenger.scheduledTime),
        // Format for Flutter display
        passengerName: passenger.passengerName,
        passengerPhone: passenger.passengerPhone,
        passengerCount: passenger.passengerCount,
        pickupName: passenger.pickupName,
        destinationName: passenger.destinationName,
        scheduledTime: passenger.scheduledTime,
        estimatedFare: passenger.estimatedFare,
        status: passenger.status || 'confirmed'
      }));
      
      return {
        success: true,
        passengers: enhancedPassengers,
        summary: summary,
        totalPassengers: enhancedPassengers.length,
        availableSeats: driverDoc.availableSeats || 0,
        driverStatus: driverDoc.status,
        driverName: driverDoc.driverName,
        driverPhone: driverPhone,
        // Include full driver document for Flutter screen
        driverDoc: {
          id: driverDoc.id,
          driverName: driverDoc.driverName,
          availableSeats: driverDoc.availableSeats,
          initialSeats: driverDoc.initialSeats || 4,
          status: driverDoc.status,
          scheduledTime: driverDoc.scheduledTime,
          pickupName: driverDoc.pickupName,
          destinationName: driverDoc.destinationName,
          pickupLocation: driverDoc.pickupLocation,
          destinationLocation: driverDoc.destinationLocation,
          vehicleType: driverDoc.vehicleType,
          vehicleModel: driverDoc.vehicleModel,
          vehicleColor: driverDoc.vehicleColor,
          licensePlate: driverDoc.licensePlate,
          profilePhoto: driverDoc.profilePhoto,
          rating: driverDoc.rating,
          totalRides: driverDoc.totalRides,
          isVerified: driverDoc.isVerified,
          vehicleInfo: driverDoc.vehicleInfo
        }
      };
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error getting driver passengers:', error.message);
      return { success: false, error: error.message, passengers: [] };
    }
  }
  
  /**
   * Calculate time until pickup for display
   */
  calculateTimeUntilPickup(scheduledTime) {
    try {
      if (!scheduledTime) return null;
      
      const pickupTime = new Date(scheduledTime).getTime();
      const now = Date.now();
      const diffMs = pickupTime - now;
      
      if (diffMs < 0) return 'Past due';
      
      const diffMins = Math.round(diffMs / 60000);
      const diffHours = Math.floor(diffMins / 60);
      const remainingMins = diffMins % 60;
      
      if (diffHours > 24) {
        const days = Math.floor(diffHours / 24);
        return `${days} day${days > 1 ? 's' : ''}`;
      } else if (diffHours > 0) {
        return `${diffHours}h ${remainingMins}m`;
      } else {
        return `${diffMins} min`;
      }
    } catch (error) {
      return 'Unknown';
    }
  }
  
  // ========== HELPER METHODS ==========
  
  extractLocation(data, fieldName) {
    try {
      const location = data[fieldName];
      
      if (!location) {
        return null;
      }
      
      if (typeof location === 'object' && location !== null) {
        if (location.lat !== undefined && location.lng !== undefined) {
          return { 
            latitude: location.lat, 
            longitude: location.lng 
          };
        }
        if (location.latitude !== undefined && location.longitude !== undefined) {
          return { 
            latitude: location.latitude, 
            longitude: location.longitude 
          };
        }
        if (location._lat !== undefined && location._long !== undefined) {
          return { 
            latitude: location._lat, 
            longitude: location._long 
          };
        }
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }
  
  extractTime(data) {
    try {
      const timeSources = [
        data.scheduledTimestamp,
        data.scheduledTime,
        data.departureTime,
        data.pickupTime,
        data.rideDetails?.scheduledTime,
        data.createdAt
      ];
      
      for (const timeSource of timeSources) {
        if (!timeSource) continue;
        
        if (typeof timeSource === 'number') {
          return timeSource;
        } else if (typeof timeSource === 'string') {
          const timestamp = new Date(timeSource).getTime();
          if (!isNaN(timestamp)) {
            return timestamp;
          }
        } else if (timeSource && typeof timeSource.toDate === 'function') {
          return timeSource.toDate().getTime();
        }
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }
  
  extractCapacity(data) {
    try {
      return data.availableSeats || 
             data.capacity || 
             data.seatsAvailable || 
             data.vehicleInfo?.capacity ||
             4;
    } catch (error) {
      return 4;
    }
  }
  
  extractPassengerDetails(data) {
    try {
      let profilePhoto = null;
      let passengerName = 'Passenger';
      let passengerPhone = 'Unknown';
      
      if (data.passengerInfo && data.passengerInfo.photoUrl) {
        profilePhoto = data.passengerInfo.photoUrl;
      } else if (data.passengerPhotoUrl) {
        profilePhoto = data.passengerPhotoUrl;
      } else if (data.passenger && data.passenger.photoUrl) {
        profilePhoto = data.passenger.photoUrl;
      } else if (data.rideDetails?.passenger?.photoUrl) {
        profilePhoto = data.rideDetails.passenger.photoUrl;
      }
      
      if (data.passengerInfo && data.passengerInfo.name) {
        passengerName = data.passengerInfo.name;
      } else if (data.passengerName) {
        passengerName = data.passengerName;
      } else if (data.passenger && data.passenger.name) {
        passengerName = data.passenger.name;
      } else if (data.name) {
        passengerName = data.name;
      }
      
      if (data.passengerInfo && data.passengerInfo.phone) {
        passengerPhone = data.passengerInfo.phone;
      } else if (data.userId) {
        passengerPhone = data.userId;
      } else if (data.passengerPhone) {
        passengerPhone = data.passengerPhone;
      } else if (data.passenger && data.passenger.phone) {
        passengerPhone = data.passenger.phone;
      }
      
      return {
        name: passengerName,
        phone: passengerPhone,
        passengerCount: this.extractPassengerCount(data),
        luggageCount: data.luggageCount || 0,
        profilePhoto: profilePhoto,
        rating: data.passengerInfo?.rating || data.passengerRating || 5.0,
        totalRides: data.passengerInfo?.totalRides || data.totalRides || 0,
        completedRides: data.passengerInfo?.completedRides || data.completedRides || 0,
        isVerified: data.passengerInfo?.isVerified || data.isVerified || false,
        paymentMethod: data.paymentMethod || 'cash'
      };
    } catch (error) {
      return {
        name: 'Passenger',
        phone: data?.userId || 'Unknown',
        passengerCount: 1,
        profilePhoto: null
      };
    }
  }
  
  extractDriverDetails(data) {
    try {
      return {
        name: data.driverName || 
              data.vehicleInfo?.driverName || 
              data.userInfo?.name || 
              'Driver',
        phone: data.userId || data.driverPhone,
        vehicleInfo: data.vehicleInfo || {},
        vehicleType: data.vehicleType || 
                    data.vehicleInfo?.type || 
                    'Car',
        vehicleModel: data.vehicleModel || 
                     data.vehicleInfo?.model || 
                     'Standard',
        vehicleColor: data.vehicleColor || 
                     data.vehicleInfo?.color || 
                     'Not specified',
        licensePlate: data.licensePlate || 
                     data.vehicleInfo?.plate || 
                     'Not specified',
        rating: data.rating || 
                data.driverRating || 
                data.vehicleInfo?.driverRating || 
                5.0,
        totalRides: data.totalRides || 0,
        profilePhoto: data.profilePhoto || 
                     data.driverPhoto || 
                     data.photoUrl || 
                     null,
        isVerified: data.isVerified || data.verified || false,
        availableSeats: this.extractCapacity(data)
      };
    } catch (error) {
      return {
        name: 'Driver',
        phone: data?.userId || 'Unknown',
        vehicleInfo: {},
        vehicleType: 'Car',
        availableSeats: 4
      };
    }
  }
  
  extractPassengerCount(data) {
    try {
      return data.passengerCount || 
             data.numberOfPassengers || 
             data.rideDetails?.passengerCount || 
             1;
    } catch (error) {
      return 1;
    }
  }
  
  getTimeCompatibilityLevel(timeDifferenceSeconds) {
    const hours = timeDifferenceSeconds / 3600;
    if (hours <= 0.5) return 'excellent';
    if (hours <= 1) return 'good';
    if (hours <= 2) return 'fair';
    return 'flexible';
  }
  
  getLocationCompatibilityLevel(distanceMeters) {
    const km = distanceMeters / 1000;
    if (km <= 2) return 'excellent';
    if (km <= 5) return 'good';
    if (km <= 10) return 'fair';
    return 'acceptable';
  }
  
  getCapacityCompatibility(availableSeats, requiredSeats) {
    if (availableSeats >= requiredSeats) {
      if (availableSeats === requiredSeats) return 'perfect';
      return 'good';
    }
    return 'insufficient';
  }
  
  calculateDistance(loc1, loc2) {
    if (!loc1 || !loc2) return Infinity;
    
    const toRad = (value) => value * Math.PI / 180;
    
    const lat1 = loc1.latitude;
    const lon1 = loc1.longitude;
    const lat2 = loc2.latitude;
    const lon2 = loc2.longitude;
    
    const R = 6371000;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }
  
  // ========== STATUS AND STATS ==========
  
  async getScheduledSearchStatus(phoneNumber) {
    try {
      const sanitizedPhone = this.sanitizePhoneNumber(phoneNumber);
      
      const [driverSearch, passengerSearch] = await Promise.all([
        this.getUserScheduledSearch('driver', sanitizedPhone),
        this.getUserScheduledSearch('passenger', sanitizedPhone)
      ]);
      
      return {
        success: true,
        phoneNumber: sanitizedPhone,
        hasDriverScheduled: !!driverSearch,
        hasPassengerScheduled: !!passengerSearch,
        driverData: driverSearch || null,
        passengerData: passengerSearch || null,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('❌ [SCHEDULED] Error getting status:', error.message);
      return { success: false, error: error.message };
    }
  }
  
  async getStats() {
    try {
      const [driverCount, passengerCount, matchCount, cancellationCount, fcmTokenCount] = await Promise.all([
        this.getCollectionCount('scheduled_searches_driver'),
        this.getCollectionCount('scheduled_searches_passenger'),
        this.getCollectionCount('scheduled_matches'),
        this.getCollectionCount(this.CANCELLATIONS),
        this.getCollectionCount(this.FCM_TOKENS)
      ]);
      
      return {
        success: true,
        stats: {
          cycleCount: this.cycleCount,
          driverSearches: driverCount,
          passengerSearches: passengerCount,
          matches: matchCount,
          cancellations: cancellationCount,
          fcmTokens: fcmTokenCount,
          timestamp: new Date().toISOString()
        }
      };
    } catch (error) {
      console.error('❌ [SCHEDULED] Error getting stats:', error.message);
      return { success: false, error: error.message };
    }
  }
  
  async getCollectionCount(collectionName) {
    try {
      const snapshot = await this.db.collection(collectionName)
        .limit(1000)
        .get();
      return snapshot.size;
    } catch (error) {
      return 0;
    }
  }
  
  // ========== CANCEL SCHEDULED SEARCH ==========
  
  async cancelScheduledSearch(userId, userType, reason = 'user_cancelled') {
    if (!userId) {
      return { success: false, error: 'User ID is required' };
    }
    
    try {
      const collectionName = userType === 'driver' 
        ? 'scheduled_searches_driver' 
        : 'scheduled_searches_passenger';
      
      const sanitizedPhone = this.sanitizePhoneNumber(userId);
      const docRef = this.db.collection(collectionName).doc(sanitizedPhone);
      const docSnapshot = await docRef.get();
      
      if (!docSnapshot.exists) {
        return { success: false, error: 'No active scheduled search found' };
      }
      
      const data = docSnapshot.data();
      
      // Only cancel if status allows it
      const allowedStatuses = ['actively_matching', 'scheduled', 'pending_driver_approval', 'pending_passenger_approval'];
      
      if (!allowedStatuses.includes(data.status)) {
        return { 
          success: false, 
          error: `Cannot cancel search with status: ${data.status}` 
        };
      }
      
      await docRef.update({
        status: 'cancelled',
        cancelledAt: new Date().toISOString(),
        cancellationReason: reason,
        updatedAt: new Date().toISOString(),
        lastUpdated: Date.now()
      });
      
      console.log(`✅ [SCHEDULED] Cancelled ${userType} search for ${sanitizedPhone}`);
      
      return { success: true, searchId: sanitizedPhone, userType };
    } catch (error) {
      console.error('❌ [SCHEDULED] Error cancelling scheduled search:', error.message);
      return { success: false, error: error.message };
    }
  }
  
  // ========== CLEANUP ==========
  
  async cleanupExpiredMatches() {
    console.log('🧹 [SCHEDULED] Cleaning up expired matches...');
    
    try {
      const now = new Date().toISOString();
      const snapshot = await this.db.collection('scheduled_matches')
        .where('status', 'in', ['awaiting_driver_approval', 'awaiting_passenger_approval'])
        .where('expiresAt', '<', now)
        .limit(50)
        .get();
      
      let cleaned = 0;
      for (const doc of snapshot.docs) {
        const matchData = doc.data();
        
        await doc.ref.update({
          status: 'expired',
          expiredAt: now,
          updatedAt: now
        });
        
        // Restore seats for driver if match expires
        if (matchData.driverPhone && matchData.driverDecision === 'accept') {
          const driverDoc = await this.getUserScheduledSearch('driver', matchData.driverPhone);
          if (driverDoc) {
            const passengerCount = matchData.passengerCount || 1;
            const currentSeats = driverDoc.availableSeats || 0;
            const restoredSeats = currentSeats + passengerCount;
            
            // Remove this passenger from accepted list
            const acceptedPassengers = driverDoc.acceptedPassengers || [];
            const updatedAccepted = acceptedPassengers.filter(p => p.matchId !== doc.id);
            
            // Update summary
            const updatedSummary = updatedAccepted.map(p => ({
              phone: p.passengerPhone,
              name: p.passengerName,
              count: p.passengerCount,
              status: p.status,
              photoUrl: p.profilePhoto,
              matchId: p.matchId
            }));
            
            await this.updateSearchStatus('driver', matchData.driverPhone, {
              status: restoredSeats > 0 ? 'actively_matching' : 'fully_booked',
              availableSeats: restoredSeats,
              acceptedPassengers: updatedAccepted,
              acceptedPassengersSummary: updatedSummary,
              matchId: null,
              matchedWith: null,
              matchStatus: null
            });
          }
        }
        
        if (matchData.passengerPhone) {
          await this.updateSearchStatus('passenger', matchData.passengerPhone, {
            status: 'actively_matching',
            matchId: null,
            matchedWith: null,
            matchStatus: null
          });
        }
        
        cleaned++;
      }
      
      console.log(`✅ [SCHEDULED] Cleaned up ${cleaned} expired matches`);
      return cleaned;
    } catch (error) {
      console.error('❌ [SCHEDULED] Error cleaning up matches:', error.message);
      return 0;
    }
  }
  
  stop() {
    console.log('🛑 [SCHEDULED] stop() called');
    
    if (this.matchingInterval) {
      clearInterval(this.matchingInterval);
      this.matchingInterval = null;
    }
    
    logger.info('SCHEDULED_SERVICE', '🛑 Scheduled Service stopped');
  }
}

module.exports = ScheduledService;
