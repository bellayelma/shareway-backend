// services/ScheduledService.js
// COMPLETE FULL SCRIPT - No minimized code, all functionality included

const logger = require('../utils/Logger');

class ScheduledService {
  constructor(firestoreService, websocketServer, admin, notificationService) {
    console.log('🚀 [SCHEDULED] Initializing COMPLETE FULL Scheduled Service...');
    
    this.firestoreService = firestoreService;
    this.websocketServer = websocketServer;
    this.admin = admin;
    this.notification = notificationService;
    
    try {
      if (firestoreService && firestoreService.db) {
        this.db = firestoreService.db;
        console.log('✅ [SCHEDULED] Got db from FirestoreService.db');
      } else if (admin && admin.firestore) {
        this.db = admin.firestore();
        console.log('✅ [SCHEDULED] Got db from admin.firestore()');
      }
    } catch (error) {
      console.error('❌ [SCHEDULED] Failed to initialize database:', error.message);
      this.db = null;
    }
    
    this.FCM_TOKENS = 'fcm_tokens';
    this.NOTIFICATIONS = 'notifications';
    this.CANCELLATIONS = 'trip_cancellations';
    this.DRIVER_SEARCHES = 'scheduled_searches_driver';
    this.PASSENGER_SEARCHES = 'scheduled_searches_passenger';
    this.MATCHES = 'scheduled_matches';
    
    this.MATCH_EXPIRY = 30 * 60 * 1000;
    this.PENDING_EXPIRY = 15 * 60 * 1000;
    
    this.activeDrivers = new Map();
    this.activePassengers = new Map();
    this.processingMatches = new Set();
    this.userTTL = 30 * 60 * 1000;
    
    this.lastTriggerTime = 0;
    this.MIN_TRIGGER_INTERVAL = 2000;
    
    this.cleanupInterval = setInterval(() => this.cleanup(), 300000);
    
    logger.info('SCHEDULED_SERVICE', '🚀 COMPLETE FULL Scheduled Service initialized');
    console.log('✅ [SCHEDULED] All functionality included - No minimized code');
  }
  
  async start() {
    console.log('🚀 [SCHEDULED] Starting COMPLETE FULL service...');
    console.log('📊 Settings: Event-driven only, 5min cleanup');
    console.log('✅ All methods are fully implemented');
    
    try {
      if (this.firestoreService) {
        await this.firestoreService.setDocument('scheduled_test', 'connection_test', { 
          test: true, 
          timestamp: new Date().toISOString() 
        });
        console.log('✅ [SCHEDULED] Firestore connection OK');
      }
    } catch (error) {
      console.error('❌ [SCHEDULED] Firestore error:', error.message);
    }
    
    console.log('✅ [SCHEDULED] Service ready');
    return true;
  }
  
  sanitizePhoneNumber(phoneNumber) {
    if (!phoneNumber) return 'unknown_user';
    
    let sanitized = String(phoneNumber).trim();
    
    if (sanitized.length === 0) return 'unknown_user';
    
    sanitized = sanitized.replace(/[^a-zA-Z0-9_\-.]/g, (match, index) => {
      return (index === 0 && match === '+') ? '+' : '_';
    });
    
    if (sanitized.startsWith('_')) sanitized = 'user' + sanitized;
    if (sanitized.length > 100) sanitized = sanitized.substring(0, 100);
    if (sanitized.length === 0) sanitized = 'user_' + Date.now();
    
    return sanitized;
  }
  
  async getDocument(collection, documentId) {
    if (this.firestoreService && this.firestoreService.getDocument) {
      return await this.firestoreService.getDocument(collection, documentId);
    } else if (this.db) {
      const docRef = this.db.collection(collection).doc(documentId);
      return await docRef.get();
    }
    throw new Error('No database access method available');
  }
  
  async setDocument(collection, documentId, data) {
    if (this.firestoreService && this.firestoreService.setDocument) {
      return await this.firestoreService.setDocument(collection, documentId, data);
    } else if (this.db) {
      const docRef = this.db.collection(collection).doc(documentId);
      await docRef.set(data);
      return documentId;
    }
    throw new Error('No database access method available');
  }
  
  async updateDocument(collection, documentId, data) {
    if (this.firestoreService && this.firestoreService.updateDocument) {
      return await this.firestoreService.updateDocument(collection, documentId, data);
    } else if (this.db) {
      const docRef = this.db.collection(collection).doc(documentId);
      await docRef.update(data);
      return true;
    }
    throw new Error('No database access method available');
  }
  
  async documentExists(collection, documentId) {
    if (this.firestoreService && this.firestoreService.documentExists) {
      return await this.firestoreService.documentExists(collection, documentId);
    } else if (this.db) {
      const docRef = this.db.collection(collection).doc(documentId);
      const doc = await docRef.get();
      return doc.exists;
    }
    throw new Error('No database access method available');
  }
  
  async addDocument(collection, data) {
    if (this.firestoreService && this.firestoreService.addDocument) {
      return await this.firestoreService.addDocument(collection, data);
    } else if (this.db) {
      const docRef = await this.db.collection(collection).add(data);
      return docRef.id;
    }
    throw new Error('No database access method available');
  }
  
  async queryCollection(collection, constraints, limit = 100) {
    if (this.firestoreService && this.firestoreService.queryCollection) {
      return await this.firestoreService.queryCollection(collection, constraints, limit);
    } else if (this.db) {
      let query = this.db.collection(collection);
      
      for (const constraint of constraints) {
        const { field, operator, value } = constraint;
        
        if (operator === 'orderBy') {
          query = query.orderBy(field, value || 'asc');
        } else {
          query = query.where(field, operator, value);
        }
      }
      
      if (limit) {
        query = query.limit(limit);
      }
      
      const snapshot = await query.get();
      const results = [];
      
      snapshot.forEach(doc => {
        results.push({ id: doc.id, ...doc.data() });
      });
      
      return results;
    }
    
    throw new Error('No database access method available');
  }
  
  async sendNotification(userId, notification, options = {}) {
    try {
      console.log(`📱 [SCHEDULED] Sending notification to ${userId}, type: ${notification.type}`);
      
      if (this.notification && typeof this.notification.sendNotification === 'function') {
        const result = await this.notification.sendNotification(userId, notification, options);
        
        if (result && result.success) {
          console.log(`✅ [SCHEDULED] Notification sent via NotificationService to ${userId}`);
          return { success: true, method: 'fcm', messageId: result.messageId };
        }
      }
      
      if (this.notification && typeof this.notification.sendToUser === 'function') {
        console.log(`📱 [SCHEDULED] Using sendToUser method`);
        const result = await this.notification.sendToUser(userId, notification, options);
        console.log(`✅ [SCHEDULED] Notification sent via sendToUser to ${userId}`);
        return { success: true, method: 'sendToUser' };
      }
      
      if (this.notification && typeof this.notification.sendPushNotification === 'function') {
        console.log(`📱 [SCHEDULED] Using sendPushNotification method`);
        const result = await this.notification.sendPushNotification(userId, notification, options);
        console.log(`✅ [SCHEDULED] Notification sent via sendPushNotification to ${userId}`);
        return { success: true, method: 'sendPushNotification' };
      }
      
      if (this.websocketServer && typeof this.websocketServer.sendToUser === 'function') {
        console.log(`📱 [SCHEDULED] Using WebSocket fallback`);
        const result = await this.websocketServer.sendToUser(userId, notification);
        console.log(`✅ [SCHEDULED] WebSocket sent to ${userId}`);
        return { success: true, method: 'websocket' };
      }
      
      if (this.admin && this.admin.messaging) {
        console.log(`📱 [SCHEDULED] Using direct admin.messaging()`);
        
        const tokensSnapshot = await this.db
          .collection(this.FCM_TOKENS)
          .where('userId', '==', userId)
          .where('active', '==', true)
          .get();
        
        if (tokensSnapshot.empty) {
          console.log(`📱 [SCHEDULED] No FCM tokens found for ${userId}`);
          return { success: false, error: 'No FCM tokens' };
        }
        
        const tokens = [];
        
        tokensSnapshot.forEach(doc => {
          const data = doc.data();
          if (data.token) tokens.push(data.token);
        });
        
        if (tokens.length === 0) {
          console.log(`📱 [SCHEDULED] No valid tokens for ${userId}`);
          return { success: false, error: 'No valid tokens' };
        }
        
        const message = {
          notification: {
            title: notification.title || notification.type || 'Notification',
            body: notification.body || notification.message || JSON.stringify(notification.data || {})
          },
          data: {
            type: notification.type || 'unknown',
            timestamp: Date.now().toString(),
            ...(notification.data || {})
          },
          tokens: tokens
        };
        
        const response = await this.admin.messaging().sendEachForMulticast(message);
        console.log(`✅ [SCHEDULED] Sent to ${response.successCount}/${tokens.length} devices`);
        
        if (response.failureCount > 0) {
          response.responses.forEach((resp, idx) => {
            if (!resp.success) {
              console.log(`❌ [SCHEDULED] Failed token ${tokens[idx]}: ${resp.error}`);
            }
          });
        }
        
        return { 
          success: response.successCount > 0, 
          successCount: response.successCount,
          failureCount: response.failureCount
        };
      }
      
      console.log(`❌ [SCHEDULED] No notification service available for ${userId}`);
      return { success: false, error: 'No notification service' };
      
    } catch (error) {
      console.error(`❌ [SCHEDULED] Error sending notification:`, error.message);
      return { success: false, error: error.message };
    }
  }
  
  async enrichDriverDataWithUserProfile(driverPhone, driverData) {
    try {
      if (!driverPhone) return driverData || {};
      if (!driverData) driverData = {};
      
      const sanitizedPhone = this.sanitizePhoneNumber(driverPhone);
      
      let userDoc = null;
      
      try {
        userDoc = await this.getDocument('users', sanitizedPhone);
      } catch (err) {
        console.log(`⚠️ [SCHEDULED] Error fetching user doc: ${err.message}`);
      }
      
      let userData = null;
      
      if (userDoc) {
        if (userDoc.exists !== undefined) {
          userData = userDoc.exists ? userDoc.data() : null;
        } else if (userDoc.data && typeof userDoc.data === 'function') {
          userData = userDoc.exists ? userDoc.data() : null;
        } else if (userDoc.data) {
          userData = userDoc.data;
        } else if (typeof userDoc === 'object' && userDoc !== null) {
          userData = userDoc;
        }
      }
      
      if (!userData) {
        console.log(`⚠️ [SCHEDULED] No user profile found for ${driverPhone}`);
        return driverData;
      }
      
      const realName = userData.name || userData.displayName || userData.fullName || driverData.driverName || 'Driver';
      const realPhoto = userData.photoUrl || userData.photoURL || userData.profilePhoto || driverData.profilePhoto || null;
      const realRating = userData.rating || userData.averageRating || driverData.rating || 5.0;
      const realTotalRides = userData.totalRides || userData.ridesCount || driverData.totalRides || 0;
      const realVerified = userData.isVerified || userData.verified || driverData.isVerified || false;
      
      const enrichedData = {
        ...driverData,
        driverName: realName,
        name: realName,
        profilePhoto: realPhoto,
        photoUrl: realPhoto,
        driverRating: realRating,
        rating: realRating,
        totalRides: realTotalRides,
        isVerified: realVerified,
        verified: realVerified,
        capacity: driverData.availableSeats || driverData.capacity || 4,
        passengerCount: this._calculateTotalPassengers(driverData),
        driverRating: realRating,
        vehicleInfo: {
          type: driverData.vehicleType || 'Car',
          model: driverData.vehicleModel || 'Standard',
          color: driverData.vehicleColor || 'Not specified',
          plate: driverData.licensePlate || 'Not specified',
          capacity: driverData.availableSeats || 4,
          driverName: realName,
          driverPhone: driverPhone,
          driverRating: realRating,
          driverTotalRides: realTotalRides,
          driverCompletedRides: driverData.completedRides || 0,
          driverTotalEarnings: driverData.totalEarnings || 0,
          driverVerified: realVerified,
          driverPhotoUrl: realPhoto
        },
        nextCheckTime: driverData.nextCheckTime || this._calculateNextCheckTime(driverData.scheduledTime),
        currentWindow: driverData.currentWindow || '12h',
        currentMatchRadius: driverData.currentMatchRadius || 10000
      };
      
      return enrichedData;
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error enriching driver data:', error.message);
      return driverData || {};
    }
  }
  
  _calculateTotalPassengers(driverData) {
    try {
      const accepted = driverData.acceptedPassengers || [];
      return accepted.reduce((sum, p) => sum + (p.passengerCount || 1), 0);
    } catch {
      return 0;
    }
  }
  
  _calculateNextCheckTime(scheduledTime) {
    try {
      if (!scheduledTime) return new Date().toISOString();
      
      const scheduled = new Date(scheduledTime).getTime();
      const now = Date.now();
      const randomOffset = Math.floor(Math.random() * 30 * 60 * 1000);
      
      return new Date(Math.min(scheduled, now + randomOffset)).toISOString();
    } catch {
      return new Date().toISOString();
    }
  }
  
  async handleCreateScheduledSearch(data, userId, userType) {
    console.log('📝 [SCHEDULED] handleCreateScheduledSearch called for', userType, userId);
    
    try {
      if (!userId) throw new Error('User ID is required');
      if (!userType || !['driver', 'passenger'].includes(userType)) {
        throw new Error('Valid user type required');
      }
      
      const sanitizedPhone = this.sanitizePhoneNumber(userId);
      const collectionName = userType === 'driver' ? this.DRIVER_SEARCHES : this.PASSENGER_SEARCHES;
      
      let sourceData = data;
      
      if (data && data.data) {
        sourceData = data.data;
        console.log('📦 [SCHEDULED] Using nested data structure');
      }
      
      if (data && data.type === 'CREATE_SCHEDULED_SEARCH' && !data.data) {
        sourceData = data;
        console.log('📦 [SCHEDULED] Using root data structure with type');
      }
      
      let scheduledTime = null;
      
      if (userType === 'driver') {
        scheduledTime = sourceData.scheduledTime || sourceData.departureTime;
      } else {
        scheduledTime = sourceData.rideDetails?.scheduledTime || sourceData.scheduledTime || sourceData.departureTime;
      }
      
      if (!scheduledTime) throw new Error('Scheduled time is required');
      
      const parsedTime = new Date(scheduledTime);
      
      if (isNaN(parsedTime.getTime())) throw new Error('Invalid scheduled time format');
      
      const scheduledTimestamp = parsedTime.getTime();
      const timeString = parsedTime.toISOString();
      
      let passengerInfo = null;
      let passengerPhotoUrl = null;
      
      if (userType === 'passenger') {
        const passengerSource = sourceData.passenger || sourceData.passengerInfo || {};
        const extractedPhoto = passengerSource.photoUrl || sourceData.passengerPhotoUrl || sourceData.photoUrl || sourceData.profilePhoto || null;
        
        passengerInfo = {
          name: passengerSource.name || sourceData.passengerName || 'Passenger',
          phone: passengerSource.phone || userId,
          rating: passengerSource.rating || sourceData.passengerRating || 5.0,
          totalRides: passengerSource.totalRides || sourceData.totalRides || 0,
          completedRides: passengerSource.completedRides || sourceData.completedRides || 0,
          isVerified: passengerSource.isVerified || sourceData.isVerified || false,
          photoUrl: extractedPhoto
        };
        
        passengerPhotoUrl = extractedPhoto;
      }
      
      let scheduledSearchData = {
        type: userType === 'driver' ? 'CREATE_SCHEDULED_SEARCH' : 'SCHEDULE_SEARCH',
        userId: userId,
        sanitizedUserId: sanitizedPhone,
        userType: userType,
        status: 'actively_matching',
        scheduledTime: timeString,
        scheduledTimestamp: scheduledTimestamp,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastUpdated: Date.now()
      };
      
      if (userType === 'driver') {
        const nextCheckTime = this._calculateNextCheckTime(timeString);
        
        scheduledSearchData = {
          ...scheduledSearchData,
          capacity: sourceData.availableSeats || sourceData.capacity || 4,
          availableSeats: sourceData.availableSeats || sourceData.capacity || 4,
          initialSeats: sourceData.availableSeats || sourceData.capacity || 4,
          driverName: sourceData.driverName || sourceData.name || 'Driver',
          name: sourceData.driverName || sourceData.name || 'Driver',
          driverPhone: userId,
          pickupLocation: sourceData.pickupLocation || null,
          destinationLocation: sourceData.destinationLocation || null,
          pickupName: sourceData.pickupName || 'Pickup location',
          destinationName: sourceData.destinationName || 'Destination',
          vehicleType: sourceData.vehicleType || 'Car',
          vehicleModel: sourceData.vehicleModel || 'Standard',
          vehicleColor: sourceData.vehicleColor || 'Not specified',
          licensePlate: sourceData.licensePlate || 'Not specified',
          profilePhoto: sourceData.profilePhoto || sourceData.driverPhoto || null,
          photoUrl: sourceData.profilePhoto || sourceData.driverPhoto || null,
          driverRating: sourceData.rating || sourceData.driverRating || 5.0,
          rating: sourceData.rating || sourceData.driverRating || 5.0,
          totalRides: sourceData.totalRides || 0,
          isVerified: sourceData.isVerified || sourceData.verified || false,
          verified: sourceData.isVerified || sourceData.verified || false,
          acceptedPassengers: [],
          rejectedMatches: [],
          acceptedPassengersSummary: [],
          cancelledPassengersHistory: [],
          totalAcceptedPassengers: 0,
          nextCheckTime: nextCheckTime,
          currentWindow: '12h',
          currentMatchRadius: 10000,
          lastActivityAt: new Date().toISOString(),
          lastActivityType: 'created_schedule'
        };
        
        scheduledSearchData.vehicleInfo = {
          type: sourceData.vehicleType || 'Car',
          model: sourceData.vehicleModel || 'Standard',
          color: sourceData.vehicleColor || 'Not specified',
          plate: sourceData.licensePlate || 'Not specified',
          capacity: sourceData.availableSeats || sourceData.capacity || 4,
          driverName: scheduledSearchData.driverName,
          driverPhone: userId,
          driverRating: scheduledSearchData.driverRating,
          driverTotalRides: scheduledSearchData.totalRides,
          driverCompletedRides: sourceData.completedRides || 0,
          driverTotalEarnings: sourceData.totalEarnings || 0,
          driverVerified: scheduledSearchData.isVerified,
          driverPhotoUrl: scheduledSearchData.profilePhoto
        };
        
        scheduledSearchData = await this.enrichDriverDataWithUserProfile(userId, scheduledSearchData);
        
        if (sourceData.estimatedFare) scheduledSearchData.estimatedFare = sourceData.estimatedFare;
        if (sourceData.estimatedDistance) scheduledSearchData.estimatedDistance = sourceData.estimatedDistance;
        if (sourceData.estimatedDuration) scheduledSearchData.estimatedDuration = sourceData.estimatedDuration;
      }
      
      if (userType === 'passenger') {
        scheduledSearchData = {
          ...scheduledSearchData,
          passengerInfo: passengerInfo,
          passengerPhotoUrl: passengerPhotoUrl,
          passengerName: passengerInfo?.name || 'Passenger',
          passengerPhone: userId,
          passengerCount: sourceData.passengerCount || 1,
          pickupLocation: sourceData.pickupLocation || null,
          destinationLocation: sourceData.destinationLocation || null,
          pickupName: sourceData.pickupName || 'Pickup location',
          destinationName: sourceData.destinationName || 'Destination',
          luggageCount: sourceData.luggageCount || 0,
          specialRequests: sourceData.specialRequests || '',
          paymentMethod: sourceData.paymentMethod || 'cash',
          estimatedFare: sourceData.estimatedFare || 0,
          estimatedDistance: sourceData.estimatedDistance || 0,
          estimatedDuration: sourceData.estimatedDuration || 0,
          matchHistory: [],
          rating: sourceData.rating || 5.0,
          profilePhoto: passengerPhotoUrl || sourceData.profilePhoto || null
        };
        
        scheduledSearchData.rideDetails = {
          scheduledTime: timeString,
          scheduledTimestamp: scheduledTimestamp,
          pickupName: sourceData.pickupName || 'Pickup location',
          destinationName: sourceData.destinationName || 'Destination',
          pickupLocation: sourceData.pickupLocation || null,
          destinationLocation: sourceData.destinationLocation || null,
          passengerCount: sourceData.passengerCount || 1,
          luggageCount: sourceData.luggageCount || 0,
          specialRequests: sourceData.specialRequests || '',
          paymentMethod: sourceData.paymentMethod || 'cash',
          estimatedFare: sourceData.estimatedFare || 0,
          estimatedDistance: sourceData.estimatedDistance || 0,
          estimatedDuration: sourceData.estimatedDuration || 0,
          passenger: {
            name: passengerInfo?.name || 'Passenger',
            phone: userId,
            photoUrl: passengerPhotoUrl,
            rating: sourceData.rating || 5.0
          }
        };
      }
      
      const exists = await this.documentExists(collectionName, sanitizedPhone);
      
      if (exists) {
        const docSnapshot = await this.getDocument(collectionName, sanitizedPhone);
        let existingData = null;
        
        if (docSnapshot) {
          if (docSnapshot.data && typeof docSnapshot.data === 'function') {
            existingData = docSnapshot.data();
          } else if (docSnapshot.data) {
            existingData = docSnapshot.data;
          } else {
            existingData = docSnapshot;
          }
        }
        
        if (userType === 'driver' && existingData) {
          scheduledSearchData.acceptedPassengers = existingData.acceptedPassengers || [];
          scheduledSearchData.rejectedMatches = existingData.rejectedMatches || [];
          scheduledSearchData.acceptedPassengersSummary = existingData.acceptedPassengersSummary || [];
          scheduledSearchData.cancelledPassengersHistory = existingData.cancelledPassengersHistory || [];
          scheduledSearchData.totalAcceptedPassengers = existingData.totalAcceptedPassengers || 0;
          scheduledSearchData.passengerCount = this._calculateTotalPassengers(scheduledSearchData);
          
          if (existingData.vehicleInfo && typeof existingData.vehicleInfo === 'object') {
            scheduledSearchData.vehicleInfo = {
              ...existingData.vehicleInfo,
              ...scheduledSearchData.vehicleInfo
            };
          }
        }
        
        const updateData = {
          ...scheduledSearchData,
          createdAt: existingData?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastUpdated: Date.now()
        };
        
        await this.updateDocument(collectionName, sanitizedPhone, updateData);
        console.log('✅ [SCHEDULED] Updated existing document:', sanitizedPhone);
      } else {
        await this.setDocument(collectionName, sanitizedPhone, scheduledSearchData);
        console.log('✅ [SCHEDULED] Created new document:', sanitizedPhone);
      }
      
      if (userType === 'driver') {
        this.activeDrivers.set(sanitizedPhone, {
          data: scheduledSearchData,
          timestamp: Date.now()
        });
        console.log(`📦 [SCHEDULED] Driver ${sanitizedPhone} added to memory cache`);
      } else {
        this.activePassengers.set(sanitizedPhone, {
          data: scheduledSearchData,
          timestamp: Date.now()
        });
        console.log(`📦 [SCHEDULED] Passenger ${sanitizedPhone} added to memory cache`);
      }
      
      await this.triggerMatching(userType, sanitizedPhone);
      
      return {
        success: true,
        userId: userId,
        userType: userType,
        searchId: sanitizedPhone,
        scheduledTime: timeString,
        message: exists ? 'Scheduled search updated successfully' : 'Scheduled search created successfully'
      };
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error creating scheduled search:', error.message);
      return { success: false, error: error.message };
    }
  }
  
  async triggerMatching(triggeredByType, triggeredById) {
    const now = Date.now();
    
    if (now - this.lastTriggerTime < this.MIN_TRIGGER_INTERVAL) {
      console.log(`⏱️ [TRIGGER] Throttling - too soon (${now - this.lastTriggerTime}ms)`);
      return;
    }
    
    this.lastTriggerTime = now;
    
    console.log(`⚡ [TRIGGER] New ${triggeredByType} added: ${triggeredById}`);
    
    setTimeout(() => {
      this.performMatching().catch(err => 
        console.error('❌ [TRIGGER] Matching error:', err.message)
      );
    }, 100);
  }
  
  async performMatching() {
    console.log('🤝 [SCHEDULED] ========== PERFORMING MATCHING ==========');
    
    try {
      let drivers = [];
      let passengers = [];
      
      for (const [phone, cached] of this.activeDrivers.entries()) {
        if (cached && cached.data && Date.now() - cached.timestamp < this.userTTL) {
          const availableSeats = this.extractCapacity(cached.data);
          
          if (availableSeats > 0 && cached.data.status === 'actively_matching') {
            drivers.push({
              id: phone,
              data: cached.data
            });
          }
        } else {
          this.activeDrivers.delete(phone);
        }
      }
      
      for (const [phone, cached] of this.activePassengers.entries()) {
        if (cached && cached.data && Date.now() - cached.timestamp < this.userTTL) {
          if (cached.data.status === 'actively_matching') {
            passengers.push({
              id: phone,
              data: cached.data
            });
          } else {
            console.log(`ℹ [SCHEDULED] Skipping passenger ${phone} with status: ${cached.data.status}`);
          }
        } else {
          this.activePassengers.delete(phone);
        }
      }
      
      console.log(`📊 Memory cache: ${drivers.length} drivers, ${passengers.length} passengers`);
      
      if (drivers.length === 0 || passengers.length === 0) {
        console.log('💤 No match possible from memory, checking Firestore...');
        
        const [dbDrivers, dbPassengers] = await Promise.all([
          this.getActiveScheduledSearches('driver'),
          this.getActiveScheduledSearches('passenger')
        ]);
        
        if (dbDrivers.length === 0 || dbPassengers.length === 0) {
          console.log('💤 No active users in Firestore - sleeping');
          return;
        }
        
        console.log(`📊 Firestore: ${dbDrivers.length} drivers, ${dbPassengers.length} passengers`);
        
        for (const driver of dbDrivers) {
          if (driver && driver.id) {
            this.activeDrivers.set(driver.id, {
              data: driver.data || {},
              timestamp: Date.now()
            });
          }
        }
        
        for (const passenger of dbPassengers) {
          if (passenger && passenger.id) {
            this.activePassengers.set(passenger.id, {
              data: passenger.data || {},
              timestamp: Date.now()
            });
          }
        }
        
        drivers = dbDrivers;
        passengers = dbPassengers;
      }
      
      console.log(`🎯 Final: ${drivers.length} drivers, ${passengers.length} passengers ready`);
      
      let matchesCreated = 0;
      const processedPairs = new Set();
      
      for (const driver of drivers) {
        if (!driver || !driver.data) continue;
        
        const driverData = driver.data;
        const availableSeats = this.extractCapacity(driverData);
        
        if (availableSeats <= 0) continue;
        
        console.log(`👨‍✈️ Driver ${driver.id} has ${availableSeats} seats`);
        
        for (const passenger of passengers) {
          if (!passenger || !passenger.data) continue;
          
          const passengerData = passenger.data;
          const pairKey = `${driver.id}:${passenger.id}`;
          
          if (processedPairs.has(pairKey)) continue;
          
          processedPairs.add(pairKey);
          
          if (this.processingMatches.has(pairKey)) {
            console.log(`  ⚙️ Already processing: ${pairKey}, skipping for now`);
            continue;
          }
          
          const passengerCount = passengerData.passengerCount || 1;
          
          if (passengerCount > availableSeats) {
            console.log(`  ❌ Passenger needs ${passengerCount} seats, driver only has ${availableSeats}`);
            continue;
          }
          
          console.log(`✅ MATCHING: Driver ${driver.id} ↔ Passenger ${passenger.id} (${passengerCount} pax)`);
          
          this.processingMatches.add(pairKey);
          
          await this.processMatch({
            driverId: driver.id,
            passengerId: passenger.id,
            driverPhone: driverData.userId || driverData.driverPhone || driver.id,
            passengerPhone: passengerData.userId || passengerData.passengerPhone || passenger.id,
            driverData: driverData,
            passengerData: passengerData,
            passengerCount: passengerCount,
            availableSeats: availableSeats,
            pairKey: pairKey
          });
          
          matchesCreated++;
          
          const newSeats = availableSeats - passengerCount;
          driverData.availableSeats = newSeats;
          driverData.capacity = newSeats;
          
          this.activeDrivers.set(driver.id, {
            data: driverData,
            timestamp: Date.now()
          });
          
          this.activePassengers.delete(passenger.id);
          
          if (newSeats <= 0) {
            this.activeDrivers.delete(driver.id);
          }
          
          break;
        }
      }
      
      console.log(`🎯 [SCHEDULED] Created ${matchesCreated} matches this cycle`);
      
      setTimeout(() => {
        this.processingMatches.clear();
        console.log('🧹 [SCHEDULED] Cleared processing locks');
      }, 10000);
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Matching error:', error.message);
    }
  }
  
  async getActiveScheduledSearches(userType) {
    const collectionName = userType === 'driver' ? this.DRIVER_SEARCHES : this.PASSENGER_SEARCHES;
    
    try {
      const constraints = [
        { field: 'status', operator: '==', value: 'actively_matching' }
      ];
      
      const results = await this.queryCollection(collectionName, constraints, 100);
      
      const activeUsers = [];
      
      for (const item of results) {
        if (!item) continue;
        
        if (userType === 'driver') {
          const availableSeats = this.extractCapacity(item);
          
          if (availableSeats <= 0) continue;
          
          if (!item.capacity) {
            item.capacity = availableSeats;
          }
          
          if (!item.passengerCount) {
            item.passengerCount = this._calculateTotalPassengers(item);
          }
        }
        
        activeUsers.push({
          id: item.id,
          data: {
            ...item,
            userId: item.userId || item.passengerPhone || item.driverPhone || item.id
          }
        });
      }
      
      console.log(`📊 Found ${activeUsers.length} active ${userType}s`);
      return activeUsers;
      
    } catch (error) {
      console.error(`❌ [SCHEDULED] Error getting ${userType} searches:`, error.message);
      return [];
    }
  }
  
  async processMatch(match) {
    try {
      console.log(`🤝 [SCHEDULED] Processing match for driver ${match.driverPhone} and passenger ${match.passengerPhone}`);
      
      const enrichedDriverData = await this.enrichDriverDataWithUserProfile(match.driverPhone, match.driverData || {});
      
      match.driverData = enrichedDriverData;
      
      const driverDetails = this.extractDriverDetails(match.driverData);
      const passengerDetails = this.extractPassengerDetails(match.passengerData || {});
      
      const pickupName = match.passengerData?.pickupName || match.passengerData?.rideDetails?.pickupName || 'Pickup location';
      const destinationName = match.passengerData?.destinationName || match.passengerData?.rideDetails?.destinationName || 'Destination';
      
      const matchData = {
        driverId: match.driverId,
        passengerId: match.passengerId,
        driverPhone: match.driverPhone,
        passengerPhone: match.passengerPhone,
        driverName: driverDetails.name,
        passengerName: passengerDetails.name,
        driverDetails: driverDetails,
        passengerDetails: passengerDetails,
        status: 'awaiting_driver_approval',
        approvalStep: 1,
        proposedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + this.MATCH_EXPIRY).toISOString(),
        driverDecision: null,
        passengerDecision: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pickupLocation: this.extractLocation(match.driverData, 'pickupLocation') || this.extractLocation(match.passengerData, 'pickupLocation'),
        destinationLocation: this.extractLocation(match.driverData, 'destinationLocation') || this.extractLocation(match.passengerData, 'destinationLocation'),
        pickupName: pickupName,
        destinationName: destinationName,
        scheduledTime: match.driverData?.scheduledTime || match.passengerData?.scheduledTime,
        scheduledTimestamp: match.driverData?.scheduledTimestamp || match.passengerData?.scheduledTimestamp,
        passengerData: match.passengerData,
        driverData: match.driverData,
        matchDetails: {
          driverCapacity: match.availableSeats,
          passengerCount: match.passengerCount,
          estimatedFare: match.passengerData?.estimatedFare || match.driverData?.estimatedFare || 0,
          estimatedDistance: match.passengerData?.estimatedDistance || match.driverData?.estimatedDistance || 0
        }
      };
      
      const matchId = await this.addDocument(this.MATCHES, matchData);
      
      console.log(`✅ [FIRESTORE] Added document to ${this.MATCHES}: ${matchId}`);
      
      await this.updateSearchStatus('driver', match.driverPhone, {
        status: 'actively_matching',
        pendingMatchId: {
          approvalStep: 1,
          createdAt: new Date().toISOString(),
          destinationLocation: matchData.destinationLocation,
          destinationName: destinationName,
          driverData: match.driverData,
          matchDetails: matchData.matchDetails,
          passengerData: match.passengerData,
          passengerId: match.passengerId,
          passengerName: passengerDetails.name,
          pickupLocation: matchData.pickupLocation,
          pickupName: pickupName,
          proposedAt: matchData.proposedAt,
          scheduledTime: match.driverData?.scheduledTime || match.passengerData?.scheduledTime,
          scheduledTimestamp: match.driverData?.scheduledTimestamp || match.passengerData?.scheduledTimestamp,
          status: 'awaiting_driver_approval'
        },
        pendingMatchWith: match.passengerPhone,
        pendingMatchStatus: 'awaiting_driver_approval',
        matchScore: 70
      });
      
      await this.updateSearchStatus('passenger', match.passengerPhone, {
        status: 'pending_driver_approval',
        matchId: matchId,
        matchedWith: match.driverPhone,
        matchStatus: 'awaiting_driver_approval',
        lastActivityAt: new Date().toISOString(),
        lastActivityType: 'match_proposed'
      });
      
      // UPDATED NOTIFICATION SECTION - Flat fields added for Android
      await this.sendNotification(match.driverPhone, {
        type: 'NEW_MATCH_PROPOSAL',
        title: 'New Passenger Match!',
        body: `${passengerDetails.name} wants to join your trip`,
        data: {
          // Flat fields (what Android needs)
          matchId: matchId,
          passengerPhone: match.passengerPhone,
          passengerName: passengerDetails.name,
          passengerPhoto: passengerDetails.profilePhoto || '',
          pickupName: pickupName,
          destinationName: destinationName,
          estimatedFare: (match.passengerData?.estimatedFare || 0).toString(),
          passengerCount: (match.passengerCount || 1).toString(),
          scheduledTime: match.passengerData?.scheduledTime || '',
          timestamp: new Date().toISOString(),
          approvalDeadline: new Date(Date.now() + this.PENDING_EXPIRY).toISOString(),
          expiresAt: new Date(Date.now() + this.MATCH_EXPIRY).toISOString(),
          
          // Keep nested for backward compatibility
          passengerDetails: passengerDetails,
          tripDetails: {
            pickupName: pickupName,
            destinationName: destinationName,
            scheduledTime: match.passengerData?.scheduledTime,
            passengerCount: match.passengerCount,
            estimatedFare: match.passengerData?.estimatedFare,
            paymentMethod: match.passengerData?.paymentMethod || 'cash'
          }
        }
      }, { important: true });
      
      setTimeout(() => {
        if (match.pairKey) {
          this.processingMatches.delete(match.pairKey);
        }
      }, 15000);
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error processing match:', error.message);
      
      if (match.pairKey) {
        this.processingMatches.delete(match.pairKey);
      }
    }
  }
  
  async handleMatchDecision(matchId, userPhone, userType, decision, reason) {
    console.log(`🎯 [SCHEDULED] handleMatchDecision called:`, {
      matchId,
      userPhone,
      userType,
      decision
    });
    
    try {
      if (!matchId || !userPhone || !userType || !decision) {
        return { success: false, error: 'Missing required parameters' };
      }
      
      if (userType === 'driver' && (decision === 'cancell' || decision === 'cancel')) {
        console.log(`🚫 [SCHEDULED] Detected cancellation request for confirmed passenger, redirecting to handleDriverCancelPassenger`);
        
        const matchRef = this.db.collection(this.MATCHES).doc(matchId);
        const matchDoc = await matchRef.get();
        
        if (matchDoc.exists) {
          const matchData = matchDoc.data();
          const passengerPhone = matchData.passengerPhone;
          
          return await this.handleDriverCancelPassenger(userPhone, passengerPhone, reason || 'driver_cancelled_confirmed_passenger');
        }
      }
      
      const matchRef = this.db.collection(this.MATCHES).doc(matchId);
      const matchDoc = await matchRef.get();
      
      if (!matchDoc.exists) {
        console.error(`❌ [SCHEDULED] Match ${matchId} not found`);
        return { success: false, error: 'Match not found' };
      }
      
      const matchData = matchDoc.data();
      
      if (userType === 'driver' && matchData.driverPhone !== userPhone) {
        return { success: false, error: 'Unauthorized' };
      }
      
      if (userType === 'passenger' && matchData.passengerPhone !== userPhone) {
        return { success: false, error: 'Unauthorized' };
      }
      
      if (matchData.status === 'confirmed' || matchData.status === 'matched_confirmed') {
        console.log(`⚠️ [SCHEDULED] Match is already confirmed. For cancellations, use dedicated cancel endpoints.`);
        
        if (userType === 'driver') {
          return await this.handleDriverCancelPassenger(userPhone, matchData.passengerPhone, reason || 'driver_cancelled_confirmed_passenger');
        } else if (userType === 'passenger') {
          return await this.handlePassengerCancelRide(userPhone, matchData.driverPhone, reason || 'passenger_cancelled_ride');
        }
      }
      
      if (userType === 'driver') {
        return await this._handleDriverMatchDecisionInternal(matchId, userPhone, decision, reason, matchData);
      } else {
        return await this._handlePassengerMatchDecisionInternal(matchId, userPhone, decision, reason, matchData);
      }
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error in handleMatchDecision:', error.message);
      return { success: false, error: error.message };
    }
  }
  
  async _handleDriverMatchDecisionInternal(matchId, driverPhone, decision, reason, matchData) {
    try {
      console.log(`🤔 [SCHEDULED] Driver ${driverPhone} decision for match ${matchId}: ${decision}`);
      
      const matchRef = this.db.collection(this.MATCHES).doc(matchId);
      
      if (decision === 'accept') {
        console.log(`✅ [SCHEDULED] Driver ${driverPhone} ACCEPTING match ${matchId}`);
        
        const driverDocRef = this.db.collection(this.DRIVER_SEARCHES).doc(driverPhone);
        const driverDocSnapshot = await driverDocRef.get();
        
        if (!driverDocSnapshot.exists) {
          console.error(`❌ [SCHEDULED] Driver document not found for ${driverPhone}`);
          return { success: false, error: 'Driver document not found' };
        }
        
        const driverDoc = driverDocSnapshot.data();
        console.log(`📄 [SCHEDULED] Driver current availableSeats: ${driverDoc.availableSeats}`);
        
        const passengerCount = matchData.matchDetails?.passengerCount || 1;
        const currentAvailableSeats = driverDoc.availableSeats || 0;
        const newAvailableSeats = Math.max(0, currentAvailableSeats - passengerCount);
        
        console.log(`💺 [SCHEDULED] Seats: current=${currentAvailableSeats}, needed=${passengerCount}, new=${newAvailableSeats}`);
        
        const passengerPhone = matchData.passengerPhone;
        const passengerName = matchData.passengerName || 'Passenger';
        const passengerPhoto = matchData.passengerDetails?.profilePhoto || matchData.passengerData?.passengerPhotoUrl || matchData.passengerData?.profilePhoto || null;
        
        const passengerFullDetails = {
          passengerPhone: passengerPhone,
          passengerName: passengerName,
          passengerCount: passengerCount,
          profilePhoto: passengerPhoto,
          photoUrl: passengerPhoto,
          rating: matchData.passengerDetails?.rating || 5.0,
          totalRides: matchData.passengerDetails?.totalRides || 0,
          completedRides: matchData.passengerDetails?.completedRides || 0,
          isVerified: matchData.passengerDetails?.isVerified || false,
          pickupLocation: matchData.pickupLocation || null,
          destinationLocation: matchData.destinationLocation || null,
          pickupName: matchData.pickupName || 'Pickup location',
          destinationName: matchData.destinationName || 'Destination',
          scheduledTime: matchData.scheduledTime || null,
          scheduledTimestamp: matchData.scheduledTimestamp || null,
          paymentMethod: matchData.passengerDetails?.paymentMethod || 'cash',
          luggageCount: matchData.passengerData?.luggageCount || 0,
          specialRequests: matchData.passengerData?.specialRequests || '',
          matchId: matchId,
          acceptedAt: new Date().toISOString(),
          confirmedAt: new Date().toISOString(),
          status: 'confirmed',
          passengerInfo: matchData.passengerData?.passengerInfo || null,
          contactInfo: {
            phone: passengerPhone,
            name: passengerName,
            photoUrl: passengerPhoto
          },
          locationCoordinates: {
            pickup: matchData.pickupLocation || null,
            destination: matchData.destinationLocation || null
          },
          estimatedFare: matchData.matchDetails?.estimatedFare || 0
        };
        
        console.log(`👤 [SCHEDULED] Adding passenger to driver's accepted list:`, {
          name: passengerName,
          photo: passengerPhoto ? 'Yes' : 'No'
        });
        
        const currentAccepted = driverDoc.acceptedPassengers || [];
        const updatedAccepted = [...currentAccepted, passengerFullDetails];
        
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
        
        const totalAccepted = (driverDoc.totalAcceptedPassengers || 0) + passengerCount;
        const driverNewStatus = newAvailableSeats <= 0 ? 'fully_booked' : 'actively_matching';
        const totalPassengerCount = updatedAccepted.reduce((sum, p) => sum + (p.passengerCount || 1), 0);
        
        const driverUpdateData = {
          status: driverNewStatus,
          availableSeats: newAvailableSeats,
          capacity: newAvailableSeats,
          acceptedPassengers: updatedAccepted,
          acceptedPassengersSummary: acceptedSummary,
          totalAcceptedPassengers: totalAccepted,
          passengerCount: totalPassengerCount,
          lastAcceptedAt: new Date().toISOString(),
          lastConfirmedAt: new Date().toISOString(),
          pendingMatchId: null,
          pendingMatchWith: null,
          pendingMatchStatus: null,
          lastActivityAt: new Date().toISOString(),
          lastActivityType: 'confirmed_match',
          updatedAt: new Date().toISOString(),
          lastUpdated: Date.now()
        };
        
        await driverDocRef.update(driverUpdateData);
        console.log(`✅ [FIRESTORE] Updated driver document ${driverPhone}`);
        console.log(`💺 [SCHEDULED] New available seats: ${newAvailableSeats}`);
        
        await matchRef.update({
          status: 'confirmed',
          finalStatus: 'accepted',
          confirmedAt: new Date().toISOString(),
          driverDecision: 'accept',
          driverDecisionAt: new Date().toISOString(),
          passengerDecision: 'accept',
          passengerDecisionAt: new Date().toISOString(),
          passengerCount: passengerCount,
          remainingSeatsAfterThisMatch: newAvailableSeats,
          updatedAt: new Date().toISOString()
        });
        
        const passengerDocRef = this.db.collection(this.PASSENGER_SEARCHES).doc(passengerPhone);
        
        const driverDetailsForPassenger = {
          name: driverDoc.driverName || 'Driver',
          phone: driverPhone,
          photoUrl: driverDoc.profilePhoto || null,
          rating: driverDoc.rating || 5.0,
          availableSeats: newAvailableSeats,
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
        
        await passengerDocRef.update({
          status: 'matched_confirmed',
          matchId: matchId,
          matchedWith: driverPhone,
          matchStatus: 'confirmed',
          confirmedAt: new Date().toISOString(),
          driverAccepted: true,
          driverAcceptedAt: new Date().toISOString(),
          driverDetails: driverDetailsForPassenger,
          updatedAt: new Date().toISOString(),
          lastUpdated: Date.now()
        });
        
        console.log(`✅ [FIRESTORE] Updated passenger document ${passengerPhone} to confirmed`);
        
        this.activePassengers.delete(passengerPhone);
        
        const cachedDriver = this.activeDrivers.get(driverPhone);
        
        if (cachedDriver) {
          cachedDriver.data = { ...cachedDriver.data, ...driverUpdateData };
          cachedDriver.timestamp = Date.now();
          this.activeDrivers.set(driverPhone, cachedDriver);
        }
        
        if (newAvailableSeats <= 0) {
          this.activeDrivers.delete(driverPhone);
        }
        
        await this.sendNotification(driverPhone, {
          type: 'SCHEDULED_MATCH_CONFIRMED',
          title: 'Passenger Confirmed!',
          body: `${passengerName} has been added to your trip`,
          data: {
            matchId: matchId,
            passengerPhone: passengerPhone,
            passengerName: passengerName,
            confirmedAt: new Date().toISOString()
          }
        });
        
        await this.sendNotification(passengerPhone, {
          type: 'SCHEDULED_MATCH_CONFIRMED',
          title: 'Driver Accepted!',
          body: `Your ride with ${driverDoc.driverName || 'Driver'} has been confirmed`,
          data: {
            matchId: matchId,
            driverPhone: driverPhone,
            driverName: driverDoc.driverName || 'Driver',
            confirmedAt: new Date().toISOString()
          }
        });
        
        console.log(`✅ [SCHEDULED] Match ${matchId} confirmed!`);
        console.log(`👥 [SCHEDULED] Driver now has ${updatedAccepted.length} accepted passengers`);
        console.log(`💺 [SCHEDULED] Seats left: ${newAvailableSeats}`);
        
        return { 
          success: true, 
          matchId, 
          decision,
          data: {
            availableSeats: newAvailableSeats,
            acceptedCount: updatedAccepted.length,
            passengerAdded: passengerName
          }
        };
        
      } else if (decision === 'reject' || decision === 'decline') {
        console.log(`❌ [SCHEDULED] Driver ${driverPhone} REJECTING match ${matchId}`);
        
        const batch = this.db.batch();
        
        batch.update(matchRef, {
          status: 'driver_rejected',
          driverDecision: 'reject',
          driverDecisionAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        
        const driverDocRef = this.db.collection(this.DRIVER_SEARCHES).doc(driverPhone);
        
        batch.update(driverDocRef, {
          pendingMatchId: null,
          pendingMatchWith: null,
          pendingMatchStatus: null,
          updatedAt: new Date().toISOString(),
          lastUpdated: Date.now()
        });
        
        const passengerDocRef = this.db.collection(this.PASSENGER_SEARCHES).doc(matchData.passengerPhone);
        
        batch.update(passengerDocRef, {
          status: 'actively_matching',
          matchId: null,
          matchedWith: null,
          matchStatus: null,
          updatedAt: new Date().toISOString(),
          lastUpdated: Date.now()
        });
        
        const cancellationRef = this.db.collection(this.CANCELLATIONS).doc();
        
        batch.set(cancellationRef, {
          id: cancellationRef.id,
          type: 'driver_rejected_match',
          matchId: matchId,
          driverPhone: driverPhone,
          passengerPhone: matchData.passengerPhone,
          driverName: matchData.driverName || 'Driver',
          passengerName: matchData.passengerName || 'Passenger',
          reason: reason || decision,
          createdAt: new Date().toISOString(),
          timestamp: Date.now()
        });
        
        await batch.commit();
        console.log(`✅ [BATCH] Match rejection committed to Firestore`);
        
        await this.sendNotification(matchData.passengerPhone, {
          type: 'MATCH_DECLINED',
          title: 'Match Declined',
          body: `The driver declined your ride request`,
          data: {
            matchId: matchId,
            driverPhone: driverPhone,
            driverName: matchData.driverName || 'Driver',
            decision: 'reject',
            timestamp: new Date().toISOString()
          }
        });
        
        console.log(`✅ [SCHEDULED] Match ${matchId} rejected, Firestore updated and FCM sent`);
        
        return { success: true, matchId, decision: 'reject' };
      }
      
      return { success: false, error: 'Invalid decision' };
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error in _handleDriverMatchDecisionInternal:', error.message);
      console.error('❌ [SCHEDULED] Error stack:', error.stack);
      return { success: false, error: error.message };
    }
  }
  
  async _handlePassengerMatchDecisionInternal(matchId, passengerPhone, decision, reason, matchData) {
    try {
      console.log(`👤 [SCHEDULED] Passenger ${passengerPhone} decision for match ${matchId}: ${decision}`);
      
      const matchRef = this.db.collection(this.MATCHES).doc(matchId);
      
      if (decision === 'accept') {
        await matchRef.update({
          passengerDecision: 'accept',
          passengerDecisionAt: new Date().toISOString(),
          status: 'confirmed',
          updatedAt: new Date().toISOString()
        });
        
        await this.sendNotification(matchData.driverPhone, {
          type: 'PASSENGER_ACCEPTED',
          title: 'Passenger Accepted',
          body: `${matchData.passengerName || 'Passenger'} has accepted the ride`,
          data: {
            matchId: matchId,
            passengerPhone: passengerPhone,
            passengerName: matchData.passengerName,
            acceptedAt: new Date().toISOString()
          }
        });
        
        return { success: true, matchId, decision };
        
      } else {
        await matchRef.update({
          passengerDecision: 'reject',
          passengerDecisionAt: new Date().toISOString(),
          status: 'passenger_rejected',
          updatedAt: new Date().toISOString()
        });
        
        const driverDocRef = this.db.collection(this.DRIVER_SEARCHES).doc(matchData.driverPhone);
        
        await driverDocRef.update({
          pendingMatchId: null,
          pendingMatchWith: null,
          pendingMatchStatus: null,
          updatedAt: new Date().toISOString()
        });
        
        await this.sendNotification(matchData.driverPhone, {
          type: 'PASSENGER_DECLINED',
          title: 'Passenger Declined',
          body: `${matchData.passengerName || 'Passenger'} declined the ride request`,
          data: {
            matchId: matchId,
            passengerPhone: passengerPhone,
            passengerName: matchData.passengerName,
            declinedAt: new Date().toISOString()
          }
        });
        
        return { success: true, matchId, decision: 'reject' };
      }
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error in _handlePassengerMatchDecisionInternal:', error.message);
      return { success: false, error: error.message };
    }
  }
  
  async handleDriverCancelPassenger(driverPhone, passengerPhone, reason = 'driver_cancelled_passenger') {
    console.log(`🚫 [SCHEDULED] ===== DRIVER CANCELLING CONFIRMED PASSENGER =====`);
    console.log(`🚫 Driver: ${driverPhone}`);
    console.log(`🚫 Passenger: ${passengerPhone}`);
    console.log(`🚫 Reason: ${reason}`);
    
    try {
      const driverDoc = await this.getUserScheduledSearch('driver', driverPhone);
      
      if (!driverDoc) {
        console.error(`❌ [SCHEDULED] Driver schedule not found for ${driverPhone}`);
        return { success: false, error: 'Driver schedule not found' };
      }
      
      console.log(`📄 Driver document found:`, {
        driverName: driverDoc.driverName,
        availableSeats: driverDoc.availableSeats,
        acceptedCount: driverDoc.acceptedPassengers?.length || 0
      });
      
      const acceptedPassengers = driverDoc.acceptedPassengers || [];
      
      console.log(`📊 Driver has ${acceptedPassengers.length} accepted passengers`);
      
      const passengerIndex = acceptedPassengers.findIndex(
        p => p.passengerPhone === passengerPhone || 
             p.phone === passengerPhone ||
             p.passengerPhone === this.sanitizePhoneNumber(passengerPhone)
      );
      
      if (passengerIndex === -1) {
        console.error(`❌ [SCHEDULED] Passenger ${passengerPhone} not found in driver's accepted list`);
        console.log(`Available passengers:`, acceptedPassengers.map(p => p.passengerPhone));
        return { success: false, error: 'Passenger not found in driver\'s accepted list' };
      }
      
      const cancelledPassenger = acceptedPassengers[passengerIndex];
      const passengerCount = cancelledPassenger.passengerCount || 1;
      const currentAvailableSeats = driverDoc.availableSeats || 0;
      const restoredSeats = currentAvailableSeats + passengerCount;
      
      console.log(`✅ Found passenger to cancel:`, {
        name: cancelledPassenger.passengerName,
        count: passengerCount,
        matchId: cancelledPassenger.matchId
      });
      
      console.log(`💺 Current seats: ${currentAvailableSeats}, adding back ${passengerCount} = ${restoredSeats}`);
      
      const batch = this.db.batch();
      
      const updatedAccepted = acceptedPassengers.filter((_, index) => index !== passengerIndex);
      const updatedSummary = (driverDoc.acceptedPassengersSummary || []).filter(p => p.phone !== passengerPhone && p.phone !== cancelledPassenger.passengerPhone);
      
      const totalPassengerCount = updatedAccepted.reduce((sum, p) => sum + (p.passengerCount || 1), 0);
      
      const driverDocRef = this.db.collection(this.DRIVER_SEARCHES).doc(this.sanitizePhoneNumber(driverPhone));
      
      const driverUpdateData = {
        acceptedPassengers: updatedAccepted,
        acceptedPassengersSummary: updatedSummary,
        availableSeats: restoredSeats,
        capacity: restoredSeats,
        passengerCount: totalPassengerCount,
        status: restoredSeats > 0 ? 'actively_matching' : 'fully_booked',
        cancelledPassengersHistory: [
          ...(driverDoc.cancelledPassengersHistory || []),
          {
            passenger: cancelledPassenger,
            cancelledAt: new Date().toISOString(),
            reason: reason,
            cancelledBy: 'driver',
            driverPhone: driverPhone,
            driverName: driverDoc.driverName || 'Driver'
          }
        ],
        updatedAt: new Date().toISOString(),
        lastUpdated: Date.now()
      };
      
      console.log(`📝 Updating driver document:`, {
        acceptedPassengers: updatedAccepted.length,
        availableSeats: restoredSeats,
        passengerCount: totalPassengerCount
      });
      
      batch.update(driverDocRef, driverUpdateData);
      
      const passengerDocRef = this.db.collection(this.PASSENGER_SEARCHES).doc(this.sanitizePhoneNumber(passengerPhone));
      
      const passengerUpdateData = {
        status: 'cancelled_by_driver',
        cancellationReason: reason,
        cancelledAt: new Date().toISOString(),
        cancelledByDriver: {
          driverPhone: driverPhone,
          driverName: driverDoc.driverName || 'Driver',
          cancelledAt: new Date().toISOString(),
          reason: reason,
          previousMatchId: cancelledPassenger.matchId
        },
        matchId: null,
        matchedWith: null,
        matchStatus: null,
        updatedAt: new Date().toISOString(),
        lastUpdated: Date.now()
      };
      
      console.log(`📝 Updating passenger document:`, {
        status: 'cancelled_by_driver',
        driverName: driverDoc.driverName
      });
      
      batch.update(passengerDocRef, passengerUpdateData);
      
      if (cancelledPassenger.matchId) {
        const matchRef = this.db.collection(this.MATCHES).doc(cancelledPassenger.matchId);
        
        const matchUpdateData = {
          status: 'cancelled_by_driver',
          finalStatus: 'cancelled',
          cancellationReason: reason,
          cancelledAt: new Date().toISOString(),
          cancelledByDriver: {
            driverPhone: driverPhone,
            driverName: driverDoc.driverName || 'Driver',
            cancelledAt: new Date().toISOString()
          },
          updatedAt: new Date().toISOString()
        };
        
        console.log(`📝 Updating match document:`, {
          matchId: cancelledPassenger.matchId,
          status: 'cancelled_by_driver'
        });
        
        batch.update(matchRef, matchUpdateData);
      }
      
      const cancellationRef = this.db.collection(this.CANCELLATIONS).doc();
      
      const cancellationData = {
        id: cancellationRef.id,
        cancellationType: 'driver_cancelled_passenger',
        cancelledBy: driverPhone,
        cancelledByRole: 'driver',
        cancellationReason: reason,
        driverDetails: {
          phone: driverPhone,
          name: driverDoc.driverName || 'Driver',
          availableSeats: restoredSeats,
          remainingPassengers: updatedAccepted.length
        },
        passengerDetails: {
          phone: passengerPhone,
          name: cancelledPassenger.passengerName,
          passengerCount: passengerCount,
          pickupName: cancelledPassenger.pickupName,
          destinationName: cancelledPassenger.destinationName,
          matchId: cancelledPassenger.matchId
        },
        originalTrip: {
          matchId: cancelledPassenger.matchId,
          scheduledTime: cancelledPassenger.scheduledTime,
          pickupName: cancelledPassenger.pickupName,
          destinationName: cancelledPassenger.destinationName
        },
        afterCancellation: {
          driverAvailableSeats: restoredSeats,
          driverRemainingPassengers: updatedAccepted.length,
          passengerStatus: 'cancelled_by_driver'
        },
        createdAt: new Date().toISOString(),
        timestamp: Date.now()
      };
      
      batch.set(cancellationRef, cancellationData);
      console.log(`📝 Creating cancellation record: ${cancellationRef.id}`);
      
      await batch.commit();
      console.log(`✅ [BATCH] All Firestore updates committed successfully`);
      
      console.log(`✅ [SCHEDULED] Removed passenger ${passengerPhone} from driver ${driverPhone}`);
      console.log(`💺 [SCHEDULED] Seats restored: ${restoredSeats} (was ${currentAvailableSeats})`);
      console.log(`👥 [SCHEDULED] Driver now has ${updatedAccepted.length} passengers remaining`);
      
      await this.sendNotification(passengerPhone, {
        type: 'DRIVER_CANCELLED_YOUR_RIDE',
        title: 'Ride Cancelled',
        body: `${driverDoc.driverName || 'Your driver'} has cancelled your ride`,
        data: {
          message: 'Driver has cancelled your ride',
          driverName: driverDoc.driverName || 'Driver',
          driverPhone: driverPhone,
          reason: reason,
          cancelledAt: new Date().toISOString(),
          cancellationId: cancellationRef.id,
          yourBooking: {
            passengerName: cancelledPassenger.passengerName,
            pickupName: cancelledPassenger.pickupName,
            destinationName: cancelledPassenger.destinationName,
            scheduledTime: cancelledPassenger.scheduledTime,
            passengerCount: cancelledPassenger.passengerCount
          },
          canReschedule: true
        }
      }, { important: true });
      
      console.log(`📱 [FCM] Cancellation notification sent to passenger ${passengerPhone}`);
      
      return {
        success: true,
        cancellationId: cancellationRef.id,
        cancelledPassenger: {
          name: cancelledPassenger.passengerName,
          phone: cancelledPassenger.passengerPhone
        },
        remainingPassengers: updatedAccepted.length,
        availableSeats: restoredSeats,
        capacity: restoredSeats,
        passengerCount: totalPassengerCount,
        message: `Cancelled ride for ${cancelledPassenger.passengerName}`
      };
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error in handleDriverCancelPassenger:', error.message);
      console.error('❌ [SCHEDULED] Error stack:', error.stack);
      return { success: false, error: error.message };
    }
  }
  
  async handleDriverCancelAll(driverPhone, reason = 'driver_cancelled_trip') {
    console.log(`🚫 [SCHEDULED] ===== DRIVER CANCELLING ALL PASSENGERS =====`);
    console.log(`🚫 Driver: ${driverPhone}`);
    console.log(`🚫 Reason: ${reason}`);
    
    try {
      const driverDoc = await this.getUserScheduledSearch('driver', driverPhone);
      
      if (!driverDoc) {
        console.error(`❌ [SCHEDULED] Driver schedule not found for ${driverPhone}`);
        return { success: false, error: 'Driver schedule not found' };
      }
      
      const acceptedPassengers = driverDoc.acceptedPassengers || [];
      
      console.log(`👥 Driver has ${acceptedPassengers.length} passengers to cancel`);
      
      if (acceptedPassengers.length === 0) {
        console.log(`ℹ️ No passengers to cancel`);
        return { success: true, message: 'No passengers to cancel', cancelledPassengers: 0 };
      }
      
      const batch = this.db.batch();
      const cancellationIds = [];
      
      for (const passenger of acceptedPassengers) {
        const passengerPhone = passenger.passengerPhone;
        const sanitizedPassengerPhone = this.sanitizePhoneNumber(passengerPhone);
        
        console.log(`📝 Updating passenger ${passengerPhone}...`);
        
        const passengerDocRef = this.db.collection(this.PASSENGER_SEARCHES).doc(sanitizedPassengerPhone);
        
        batch.update(passengerDocRef, {
          status: 'cancelled_by_driver',
          cancellationReason: reason,
          cancelledAt: new Date().toISOString(),
          cancelledByDriver: {
            driverPhone: driverPhone,
            driverName: driverDoc.driverName || 'Driver',
            cancelledAt: new Date().toISOString(),
            reason: reason
          },
          matchId: null,
          matchedWith: null,
          matchStatus: null,
          updatedAt: new Date().toISOString(),
          lastUpdated: Date.now()
        });
        
        if (passenger.matchId) {
          const matchRef = this.db.collection(this.MATCHES).doc(passenger.matchId);
          
          batch.update(matchRef, {
            status: 'cancelled_by_driver',
            finalStatus: 'cancelled',
            cancellationReason: reason,
            cancelledAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }
        
        await this.sendNotification(passengerPhone, {
          type: 'DRIVER_CANCELLED_ALL',
          title: 'Trip Cancelled',
          body: `${driverDoc.driverName || 'Your driver'} has cancelled the entire trip`,
          data: {
            message: 'Your driver has cancelled the trip',
            driverName: driverDoc.driverName || 'Driver',
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
            canReschedule: true
          }
        }, { important: true });
      }
      
      const driverDocRef = this.db.collection(this.DRIVER_SEARCHES).doc(this.sanitizePhoneNumber(driverPhone));
      
      const cancellationHistoryEntry = {
        passengers: acceptedPassengers.map(p => ({
          name: p.passengerName,
          phone: p.passengerPhone,
          count: p.passengerCount
        })),
        cancelledAt: new Date().toISOString(),
        reason: reason,
        totalPassengers: acceptedPassengers.length
      };
      
      const driverUpdateData = {
        status: 'actively_matching',
        availableSeats: driverDoc.initialSeats || 4,
        capacity: driverDoc.initialSeats || 4,
        acceptedPassengers: [],
        acceptedPassengersSummary: [],
        totalAcceptedPassengers: 0,
        passengerCount: 0,
        cancelledPassengersHistory: [
          ...(driverDoc.cancelledPassengersHistory || []),
          cancellationHistoryEntry
        ],
        lastCancelledAll: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastUpdated: Date.now()
      };
      
      console.log(`📝 Updating driver document:`, {
        acceptedPassengers: 0,
        availableSeats: driverDoc.initialSeats || 4,
        passengerCount: 0
      });
      
      batch.update(driverDocRef, driverUpdateData);
      
      const cancellationRef = this.db.collection(this.CANCELLATIONS).doc();
      cancellationIds.push(cancellationRef.id);
      
      const cancellationData = {
        id: cancellationRef.id,
        cancellationType: 'driver_cancelled_all',
        cancelledBy: driverPhone,
        cancelledByRole: 'driver',
        cancellationReason: reason,
        driverDetails: {
          phone: driverPhone,
          name: driverDoc.driverName || 'Driver',
          availableSeats: driverDoc.initialSeats || 4,
          remainingPassengers: 0
        },
        passengersCancelled: acceptedPassengers.map(p => ({
          phone: p.passengerPhone,
          name: p.passengerName,
          passengerCount: p.passengerCount,
          matchId: p.matchId
        })),
        totalPassengersCancelled: acceptedPassengers.length,
        afterCancellation: {
          driverAvailableSeats: driverDoc.initialSeats || 4,
          driverRemainingPassengers: 0,
          allPassengersCancelled: true
        },
        createdAt: new Date().toISOString(),
        timestamp: Date.now()
      };
      
      batch.set(cancellationRef, cancellationData);
      
      await batch.commit();
      console.log(`✅ [BATCH] All Firestore updates committed successfully`);
      
      console.log(`✅ [SCHEDULED] Driver ${driverPhone} cancelled all ${acceptedPassengers.length} passengers`);
      console.log(`💺 [SCHEDULED] Seats restored to: ${driverDoc.initialSeats || 4}`);
      
      return {
        success: true,
        cancellationId: cancellationRef.id,
        cancelledPassengers: acceptedPassengers.length,
        availableSeats: driverDoc.initialSeats || 4,
        capacity: driverDoc.initialSeats || 4,
        passengerCount: 0,
        message: `Cancelled trip and notified ${acceptedPassengers.length} passengers via FCM`
      };
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error in handleDriverCancelAll:', error.message);
      console.error('❌ [SCHEDULED] Error stack:', error.stack);
      return { success: false, error: error.message };
    }
  }
  
  async handlePassengerCancelRide(passengerPhone, driverPhone, reason = 'passenger_cancelled_ride') {
    console.log(`🚫 [SCHEDULED] ===== PASSENGER CANCELLING RIDE =====`);
    console.log(`🚫 Passenger: ${passengerPhone}`);
    console.log(`🚫 Driver: ${driverPhone}`);
    console.log(`🚫 Reason: ${reason}`);
    
    try {
      const [passengerDoc, driverDoc] = await Promise.all([
        this.getUserScheduledSearch('passenger', passengerPhone),
        this.getUserScheduledSearch('driver', driverPhone)
      ]);
      
      if (!passengerDoc) {
        console.error(`❌ [SCHEDULED] Passenger schedule not found for ${passengerPhone}`);
        return { success: false, error: 'Passenger schedule not found' };
      }
      
      if (!driverDoc) {
        console.error(`❌ [SCHEDULED] Driver schedule not found for ${driverPhone}`);
        return { success: false, error: 'Driver schedule not found' };
      }
      
      console.log(`📄 Passenger document found, status: ${passengerDoc.status}`);
      console.log(`📄 Driver document found, availableSeats: ${driverDoc.availableSeats}`);
      
      const acceptedPassengers = driverDoc.acceptedPassengers || [];
      
      console.log(`📊 Driver has ${acceptedPassengers.length} accepted passengers`);
      
      const passengerIndex = acceptedPassengers.findIndex(
        p => p.passengerPhone === passengerPhone || 
             p.phone === passengerPhone ||
             p.passengerPhone === this.sanitizePhoneNumber(passengerPhone)
      );
      
      if (passengerIndex === -1) {
        console.error(`❌ [SCHEDULED] Passenger ${passengerPhone} not found in driver's accepted list`);
        return { success: false, error: 'Passenger not found in driver\'s accepted list' };
      }
      
      const cancelledPassenger = acceptedPassengers[passengerIndex];
      const passengerCount = cancelledPassenger.passengerCount || 1;
      const currentAvailableSeats = driverDoc.availableSeats || 0;
      const restoredSeats = currentAvailableSeats + passengerCount;
      
      console.log(`✅ Found passenger to cancel:`, {
        name: cancelledPassenger.passengerName,
        count: passengerCount,
        matchId: cancelledPassenger.matchId
      });
      
      console.log(`💺 Driver seats: ${currentAvailableSeats} → ${restoredSeats} (+${passengerCount})`);
      
      const batch = this.db.batch();
      
      const passengerRef = this.db.collection(this.PASSENGER_SEARCHES).doc(this.sanitizePhoneNumber(passengerPhone));
      
      const passengerUpdateData = {
        status: 'cancelled_by_passenger',
        cancellationReason: reason,
        cancelledAt: new Date().toISOString(),
        matchId: null,
        matchedWith: null,
        matchStatus: null,
        updatedAt: new Date().toISOString(),
        lastUpdated: Date.now()
      };
      
      console.log(`📝 Updating passenger document:`, { status: 'cancelled_by_passenger' });
      
      batch.update(passengerRef, passengerUpdateData);
      
      const driverRef = this.db.collection(this.DRIVER_SEARCHES).doc(this.sanitizePhoneNumber(driverPhone));
      
      const updatedAccepted = acceptedPassengers.filter((_, i) => i !== passengerIndex);
      const updatedSummary = (driverDoc.acceptedPassengersSummary || []).filter(p => p.phone !== passengerPhone);
      
      const totalPassengerCount = updatedAccepted.reduce((sum, p) => sum + (p.passengerCount || 1), 0);
      
      const driverUpdateData = {
        acceptedPassengers: updatedAccepted,
        acceptedPassengersSummary: updatedSummary,
        availableSeats: restoredSeats,
        capacity: restoredSeats,
        passengerCount: totalPassengerCount,
        status: restoredSeats > 0 ? 'actively_matching' : 'fully_booked',
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
        updatedAt: new Date().toISOString(),
        lastUpdated: Date.now()
      };
      
      console.log(`📝 Updating driver document:`, {
        acceptedPassengers: updatedAccepted.length,
        availableSeats: restoredSeats,
        passengerCount: totalPassengerCount
      });
      
      batch.update(driverRef, driverUpdateData);
      
      if (cancelledPassenger.matchId) {
        const matchRef = this.db.collection(this.MATCHES).doc(cancelledPassenger.matchId);
        
        const matchUpdateData = {
          status: 'cancelled_by_passenger',
          finalStatus: 'cancelled',
          cancellationReason: reason,
          cancelledAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        
        console.log(`📝 Updating match document:`, {
          matchId: cancelledPassenger.matchId,
          status: 'cancelled_by_passenger'
        });
        
        batch.update(matchRef, matchUpdateData);
      }
      
      const cancellationRef = this.db.collection(this.CANCELLATIONS).doc();
      
      const cancellationData = {
        id: cancellationRef.id,
        cancellationType: 'passenger_cancelled_ride',
        cancelledBy: passengerPhone,
        cancelledByRole: 'passenger',
        cancellationReason: reason,
        passengerDetails: {
          phone: passengerPhone,
          name: passengerDoc.passengerName || 'Passenger',
          passengerCount: passengerCount,
          pickupName: cancelledPassenger.pickupName || passengerDoc.pickupName,
          destinationName: cancelledPassenger.destinationName || passengerDoc.destinationName
        },
        driverDetails: {
          phone: driverPhone,
          name: driverDoc.driverName || 'Driver',
          availableSeats: restoredSeats,
          remainingPassengers: updatedAccepted.length
        },
        originalTrip: {
          matchId: cancelledPassenger.matchId,
          scheduledTime: cancelledPassenger.scheduledTime || passengerDoc.scheduledTime,
          pickupName: cancelledPassenger.pickupName || passengerDoc.pickupName,
          destinationName: cancelledPassenger.destinationName || passengerDoc.destinationName
        },
        afterCancellation: {
          driverAvailableSeats: restoredSeats,
          driverRemainingPassengers: updatedAccepted.length,
          passengerStatus: 'cancelled_by_passenger'
        },
        createdAt: new Date().toISOString(),
        timestamp: Date.now()
      };
      
      batch.set(cancellationRef, cancellationData);
      console.log(`📝 Creating cancellation record: ${cancellationRef.id}`);
      
      await batch.commit();
      console.log(`✅ [BATCH] All Firestore updates committed successfully`);
      
      console.log(`✅ [SCHEDULED] Passenger ${passengerPhone} cancelled ride with driver ${driverPhone}`);
      console.log(`💺 [SCHEDULED] Driver seats restored: ${restoredSeats}`);
      console.log(`👥 [SCHEDULED] Driver now has ${updatedAccepted.length} passengers remaining`);
      
      await this.sendNotification(driverPhone, {
        type: 'PASSENGER_CANCELLED_RIDE',
        title: 'Passenger Cancelled',
        body: `${passengerDoc.passengerName || 'A passenger'} has cancelled their ride`,
        data: {
          message: `${passengerDoc.passengerName || 'A passenger'} has cancelled their ride`,
          passengerName: passengerDoc.passengerName || 'Passenger',
          passengerPhone: passengerPhone,
          passengerPhoto: passengerDoc.passengerPhotoUrl || passengerDoc.profilePhoto || null,
          reason: reason,
          cancelledAt: new Date().toISOString(),
          cancellationId: cancellationRef.id,
          matchId: cancelledPassenger.matchId,
          cancelledRide: {
            passengerName: cancelledPassenger.passengerName,
            pickupName: cancelledPassenger.pickupName || passengerDoc.pickupName,
            destinationName: cancelledPassenger.destinationName || passengerDoc.destinationName,
            scheduledTime: cancelledPassenger.scheduledTime || passengerDoc.scheduledTime,
            passengerCount: passengerCount
          },
          availableSeats: restoredSeats,
          capacity: restoredSeats,
          remainingPassengers: updatedAccepted.length,
          canAcceptNewPassengers: restoredSeats > 0
        }
      }, { important: true });
      
      await this.sendNotification(passengerPhone, {
        type: 'PASSENGER_CANCELLATION_CONFIRMED',
        title: 'Ride Cancelled',
        body: 'Your ride has been cancelled successfully',
        data: {
          success: true,
          message: 'Your ride has been cancelled successfully',
          cancelledAt: new Date().toISOString(),
          cancellationId: cancellationRef.id,
          matchId: cancelledPassenger.matchId,
          driverName: driverDoc.driverName || 'Driver',
          driverPhone: driverPhone,
          cancelledRide: {
            pickupName: passengerDoc.pickupName,
            destinationName: passengerDoc.destinationName,
            scheduledTime: passengerDoc.scheduledTime
          },
          canScheduleNewRide: true
        }
      }, { important: true });
      
      console.log(`📱 [FCM] Cancellation notifications sent to both parties`);
      
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
          name: driverDoc.driverName || 'Driver',
          remainingPassengers: updatedAccepted.length,
          availableSeats: restoredSeats,
          capacity: restoredSeats
        },
        message: `Ride cancelled successfully. FCM sent to both parties.`
      };
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error in handlePassengerCancelRide:', error.message);
      console.error('❌ [SCHEDULED] Error stack:', error.stack);
      return { success: false, error: error.message };
    }
  }
  
  async getUserScheduledSearch(userType, phoneNumber) {
    if (!phoneNumber) return null;
    
    const collectionName = userType === 'driver' ? this.DRIVER_SEARCHES : this.PASSENGER_SEARCHES;
    const sanitizedPhone = this.sanitizePhoneNumber(phoneNumber);
    
    try {
      const docSnapshot = await this.getDocument(collectionName, sanitizedPhone);
      
      if (!docSnapshot || !docSnapshot.exists) return null;
      
      let data = null;
      
      if (docSnapshot.data && typeof docSnapshot.data === 'function') {
        data = docSnapshot.data();
      } else if (docSnapshot.data) {
        data = docSnapshot.data;
      } else {
        data = docSnapshot;
      }
      
      if (userType === 'driver' && data) {
        if (!data.capacity) {
          data.capacity = data.availableSeats || 4;
        }
        
        if (!data.passengerCount) {
          data.passengerCount = this._calculateTotalPassengers(data);
        }
        
        if (!data.driverRating) {
          data.driverRating = data.rating || 5.0;
        }
      }
      
      return { id: docSnapshot.id, ...data };
      
    } catch (error) {
      console.error(`❌ [SCHEDULED] Error getting ${userType} search:`, error.message);
      return null;
    }
  }
  
  async updateSearchStatus(userType, phoneNumber, updates) {
    if (!phoneNumber) return false;
    
    const collectionName = userType === 'driver' ? this.DRIVER_SEARCHES : this.PASSENGER_SEARCHES;
    const sanitizedPhone = this.sanitizePhoneNumber(phoneNumber);
    
    try {
      const exists = await this.documentExists(collectionName, sanitizedPhone);
      
      if (!exists) return false;
      
      const fullUpdates = {
        ...updates,
        updatedAt: new Date().toISOString(),
        lastUpdated: Date.now()
      };
      
      await this.updateDocument(collectionName, sanitizedPhone, fullUpdates);
      
      console.log(`✅ [FIRESTORE] Updated document ${collectionName}/${sanitizedPhone}`);
      
      if (userType === 'driver') {
        const cached = this.activeDrivers.get(sanitizedPhone);
        
        if (cached) {
          cached.data = { ...cached.data, ...fullUpdates };
          cached.timestamp = Date.now();
          this.activeDrivers.set(sanitizedPhone, cached);
        }
      } else {
        const cached = this.activePassengers.get(sanitizedPhone);
        
        if (cached) {
          cached.data = { ...cached.data, ...fullUpdates };
          cached.timestamp = Date.now();
          this.activePassengers.set(sanitizedPhone, cached);
        }
      }
      
      return true;
      
    } catch (error) {
      console.error(`❌ [SCHEDULED] Error updating ${userType} status:`, error.message);
      return false;
    }
  }
  
  async getDriverAcceptedPassengers(driverPhone) {
    try {
      const driverDoc = await this.getUserScheduledSearch('driver', driverPhone);
      
      if (!driverDoc) {
        return { success: false, error: 'Driver not found', passengers: [] };
      }
      
      const acceptedPassengers = driverDoc.acceptedPassengers || [];
      const summary = driverDoc.acceptedPassengersSummary || [];
      
      const enhancedPassengers = acceptedPassengers.map(passenger => ({
        ...passenger,
        displayName: passenger.passengerName || passenger.name || 'Passenger',
        photoUrl: passenger.profilePhoto || passenger.photoUrl || passenger.passengerInfo?.photoUrl,
        timeUntilPickup: this.calculateTimeUntilPickup(passenger.scheduledTime),
        passengerName: passenger.passengerName,
        passengerPhone: passenger.passengerPhone,
        passengerCount: passenger.passengerCount,
        pickupName: passenger.pickupName,
        destinationName: passenger.destinationName,
        scheduledTime: passenger.scheduledTime,
        estimatedFare: passenger.estimatedFare,
        status: passenger.status || 'confirmed',
        matchId: passenger.matchId,
        acceptedAt: passenger.acceptedAt,
        confirmedAt: passenger.confirmedAt
      }));
      
      const totalPassengerCount = enhancedPassengers.reduce((sum, p) => sum + (p.passengerCount || 1), 0);
      
      return {
        success: true,
        passengers: enhancedPassengers,
        summary: summary,
        totalPassengers: enhancedPassengers.length,
        totalPassengerCount: totalPassengerCount,
        availableSeats: driverDoc.availableSeats || 0,
        capacity: driverDoc.capacity || driverDoc.availableSeats || 0,
        driverStatus: driverDoc.status,
        driverName: driverDoc.driverName,
        driverPhone: driverPhone,
        driverDoc: {
          id: driverDoc.id,
          driverName: driverDoc.driverName,
          name: driverDoc.name || driverDoc.driverName,
          availableSeats: driverDoc.availableSeats,
          capacity: driverDoc.capacity || driverDoc.availableSeats || 0,
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
          photoUrl: driverDoc.photoUrl || driverDoc.profilePhoto,
          driverRating: driverDoc.driverRating || driverDoc.rating || 5.0,
          rating: driverDoc.rating || driverDoc.driverRating || 5.0,
          totalRides: driverDoc.totalRides || 0,
          isVerified: driverDoc.isVerified || false,
          verified: driverDoc.verified || driverDoc.isVerified || false,
          vehicleInfo: driverDoc.vehicleInfo,
          passengerCount: driverDoc.passengerCount || totalPassengerCount || 0,
          nextCheckTime: driverDoc.nextCheckTime || this._calculateNextCheckTime(driverDoc.scheduledTime),
          currentWindow: driverDoc.currentWindow || '12h',
          currentMatchRadius: driverDoc.currentMatchRadius || 10000
        }
      };
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error getting driver passengers:', error.message);
      return { success: false, error: error.message, passengers: [] };
    }
  }
  
  async getScheduledSearchStatus(phoneNumber) {
    try {
      const [driverDoc, passengerDoc] = await Promise.all([
        this.getUserScheduledSearch('driver', phoneNumber),
        this.getUserScheduledSearch('passenger', phoneNumber)
      ]);
      
      return {
        success: true,
        phoneNumber,
        hasDriverScheduled: !!driverDoc,
        hasPassengerScheduled: !!passengerDoc,
        driver: driverDoc ? {
          status: driverDoc.status,
          scheduledTime: driverDoc.scheduledTime,
          availableSeats: driverDoc.availableSeats,
          acceptedPassengers: (driverDoc.acceptedPassengers || []).length,
          destinationName: driverDoc.destinationName
        } : null,
        passenger: passengerDoc ? {
          status: passengerDoc.status,
          scheduledTime: passengerDoc.scheduledTime,
          passengerCount: passengerDoc.passengerCount,
          matchedWith: passengerDoc.matchedWith,
          destinationName: passengerDoc.destinationName
        } : null
      };
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error getting status:', error.message);
      return { success: false, error: error.message };
    }
  }
  
  async cancelScheduledSearch(userId, userType, reason = 'user_cancelled') {
    if (!userId) {
      return { success: false, error: 'User ID is required' };
    }
    
    try {
      const collectionName = userType === 'driver' ? this.DRIVER_SEARCHES : this.PASSENGER_SEARCHES;
      const sanitizedPhone = this.sanitizePhoneNumber(userId);
      
      const exists = await this.documentExists(collectionName, sanitizedPhone);
      
      if (!exists) {
        return { success: false, error: 'No active scheduled search found' };
      }
      
      await this.updateDocument(collectionName, sanitizedPhone, {
        status: 'cancelled',
        cancelledAt: new Date().toISOString(),
        cancellationReason: reason,
        updatedAt: new Date().toISOString(),
        lastUpdated: Date.now()
      });
      
      if (userType === 'driver') {
        this.activeDrivers.delete(sanitizedPhone);
      } else {
        this.activePassengers.delete(sanitizedPhone);
      }
      
      console.log(`✅ [SCHEDULED] Cancelled ${userType} search for ${sanitizedPhone}`);
      
      return { success: true, searchId: sanitizedPhone, userType };
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error cancelling scheduled search:', error.message);
      return { success: false, error: error.message };
    }
  }
  
  extractLocation(data, fieldName) {
    try {
      const location = data[fieldName];
      
      if (!location) return null;
      
      if (typeof location === 'object') {
        if (location.lat !== undefined && location.lng !== undefined) {
          return { latitude: location.lat, longitude: location.lng };
        }
        
        if (location.latitude !== undefined && location.longitude !== undefined) {
          return { latitude: location.latitude, longitude: location.longitude };
        }
      }
      
      return null;
      
    } catch {
      return null;
    }
  }
  
  extractCapacity(data) {
    try {
      return data.capacity || data.availableSeats || data.seatsAvailable || data.vehicleInfo?.capacity || 4;
    } catch {
      return 4;
    }
  }
  
  extractPassengerDetails(data) {
    try {
      let profilePhoto = null;
      
      if (data.passengerInfo && data.passengerInfo.photoUrl) {
        profilePhoto = data.passengerInfo.photoUrl;
      } else if (data.passengerPhotoUrl) {
        profilePhoto = data.passengerPhotoUrl;
      } else if (data.passenger && data.passenger.photoUrl) {
        profilePhoto = data.passenger.photoUrl;
      } else if (data.rideDetails?.passenger?.photoUrl) {
        profilePhoto = data.rideDetails.passenger.photoUrl;
      }
      
      return {
        name: data.passengerInfo?.name || data.passengerName || 'Passenger',
        phone: data.passengerInfo?.phone || data.passengerPhone || data.userId,
        passengerCount: data.passengerCount || 1,
        profilePhoto: profilePhoto,
        rating: data.passengerInfo?.rating || data.rating || 5.0,
        totalRides: data.passengerInfo?.totalRides || data.totalRides || 0,
        completedRides: data.passengerInfo?.completedRides || data.completedRides || 0,
        isVerified: data.passengerInfo?.isVerified || data.isVerified || false,
        paymentMethod: data.paymentMethod || 'cash'
      };
      
    } catch {
      return {
        name: 'Passenger',
        phone: 'Unknown',
        passengerCount: 1,
        profilePhoto: null,
        rating: 5.0,
        paymentMethod: 'cash'
      };
    }
  }
  
  extractDriverDetails(data) {
    try {
      return {
        name: data.driverName || data.vehicleInfo?.driverName || 'Driver',
        phone: data.userId || data.driverPhone,
        vehicleInfo: data.vehicleInfo || {},
        vehicleType: data.vehicleType || data.vehicleInfo?.type || 'Car',
        vehicleModel: data.vehicleModel || data.vehicleInfo?.model || 'Standard',
        vehicleColor: data.vehicleColor || data.vehicleInfo?.color || 'Not specified',
        licensePlate: data.licensePlate || data.vehicleInfo?.plate || 'Not specified',
        driverRating: data.driverRating || data.rating || data.vehicleInfo?.driverRating || 5.0,
        rating: data.rating || data.driverRating || 5.0,
        totalRides: data.totalRides || 0,
        profilePhoto: data.profilePhoto || data.driverPhoto || data.photoUrl || null,
        isVerified: data.isVerified || data.verified || false,
        capacity: this.extractCapacity(data),
        availableSeats: this.extractCapacity(data)
      };
      
    } catch {
      return {
        name: 'Driver',
        phone: 'Unknown',
        vehicleInfo: {},
        vehicleType: 'Car',
        capacity: 4,
        availableSeats: 4
      };
    }
  }
  
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
      
    } catch {
      return 'Unknown';
    }
  }
  
  async cleanup() {
    console.log('🧹 [SCHEDULED] Running cleanup...');
    
    const now = Date.now();
    let cleaned = 0;
    
    for (const [phone, cached] of this.activeDrivers.entries()) {
      if (now - cached.timestamp > this.userTTL) {
        this.activeDrivers.delete(phone);
        cleaned++;
      }
    }
    
    for (const [phone, cached] of this.activePassengers.entries()) {
      if (now - cached.timestamp > this.userTTL) {
        this.activePassengers.delete(phone);
        cleaned++;
      }
    }
    
    console.log(`🧹 [SCHEDULED] Cleaned ${cleaned} expired entries from memory`);
    
    try {
      const expiryTime = new Date(Date.now() - this.MATCH_EXPIRY).toISOString();
      
      const matches = await this.queryCollection(
        this.MATCHES,
        [
          { field: 'status', operator: 'in', value: ['awaiting_driver_approval', 'awaiting_passenger_approval'] },
          { field: 'proposedAt', operator: '<', value: expiryTime }
        ],
        10
      );
      
      if (matches && matches.length > 0) {
        for (const match of matches) {
          await this.updateDocument(this.MATCHES, match.id, {
            status: 'expired',
            expiredAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }
        
        console.log(`🧹 [SCHEDULED] Cleaned ${matches.length} expired matches from Firestore`);
      }
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Cleanup error:', error.message);
    }
  }
  
  stop() {
    console.log('🛑 [SCHEDULED] stop() called');
    
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    
    this.activeDrivers.clear();
    this.activePassengers.clear();
    this.processingMatches.clear();
    
    logger.info('SCHEDULED_SERVICE', '🛑 Scheduled Service stopped');
  }
}

module.exports = ScheduledService;
