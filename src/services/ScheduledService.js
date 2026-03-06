// services/ScheduledService.js
// COMPLETE FIXED VERSION - Properly updates Firestore structure
// FIXED: Now correctly updates acceptedPassengers array in driver document
// FIXED: Updates availableSeats in driver document
// FIXED: Creates acceptedPassengersSummary
// FIXED: Updates totalAcceptedPassengers counter
// FIXED: Matches the EXACT Firestore structure from your logs

const logger = require('../utils/Logger');

class ScheduledService {
  constructor(firestoreService, websocketServer, admin, notificationService) {
    console.log('🚀 [SCHEDULED] Initializing FIRESTORE-STRUCTURE-FIXED version...');
    
    this.firestoreService = firestoreService;
    this.websocketServer = websocketServer;
    this.admin = admin;
    this.notification = notificationService;
    
    // Initialize database connection
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
    
    // FCM Collections
    this.FCM_TOKENS = 'fcm_tokens';
    this.NOTIFICATIONS = 'notifications';
    this.CANCELLATIONS = 'trip_cancellations';
    
    // NO INTERVAL - completely event-driven
    this.MATCH_EXPIRY = 30 * 60 * 1000; // 30 minutes
    this.PENDING_EXPIRY = 15 * 60 * 1000; // 15 minutes
    
    // Active users in memory
    this.activeDrivers = new Map();
    this.activePassengers = new Map();
    this.processingMatches = new Set();
    this.userTTL = 30 * 60 * 1000;
    
    // Throttling for triggers
    this.lastTriggerTime = 0;
    this.MIN_TRIGGER_INTERVAL = 2000;
    
    // Start cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanup(), 300000);
    
    logger.info('SCHEDULED_SERVICE', '🚀 Firestore-Structure-Fixed Scheduled Service initialized');
  }
  
  async start() {
    console.log('🚀 [SCHEDULED] Starting FIRESTORE-STRUCTURE-FIXED service...');
    console.log('📊 Settings: Event-driven only, 5min cleanup, NO BLOCKING CACHE');
    
    // Test connection
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
    
    console.log('✅ [SCHEDULED] Service ready - ZERO CPU usage until users arrive');
    return true;
  }
  
  // ========== PHONE NUMBER SANITIZATION ==========
  
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
  
  // ========== DATABASE HELPERS ==========
  
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
      if (limit) query = query.limit(limit);
      const snapshot = await query.get();
      const results = [];
      snapshot.forEach(doc => results.push({ id: doc.id, ...doc.data() }));
      return results;
    }
    throw new Error('No database access method available');
  }
  
  // ========== ENRICH DRIVER DATA FROM USERS COLLECTION ==========
  
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
      
      const enrichedData = {
        ...driverData,
        driverName: realName,
        profilePhoto: realPhoto,
        name: realName,
        photoUrl: realPhoto,
      };
      
      if (enrichedData.vehicleInfo && typeof enrichedData.vehicleInfo === 'object') {
        enrichedData.vehicleInfo = {
          ...enrichedData.vehicleInfo,
          driverName: realName,
          driverPhotoUrl: realPhoto,
        };
      } else {
        enrichedData.vehicleInfo = {
          type: enrichedData.vehicleType || 'Car',
          model: enrichedData.vehicleModel || 'Standard',
          color: enrichedData.vehicleColor || 'Not specified',
          plate: enrichedData.licensePlate || 'Not specified',
          capacity: enrichedData.availableSeats || 4,
          driverName: realName,
          driverPhone: driverPhone,
          driverPhotoUrl: realPhoto,
          driverRating: enrichedData.rating || 5.0,
          driverTotalRides: enrichedData.totalRides || 0,
          driverCompletedRides: enrichedData.completedRides || 0,
          driverVerified: enrichedData.isVerified || false
        };
      }
      
      return enrichedData;
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error enriching driver data:', error.message);
      return driverData || {};
    }
  }
  
  // ========== CREATE/UPDATE SCHEDULED SEARCH ==========
  
  async handleCreateScheduledSearch(data, userId, userType) {
    console.log('📝 [SCHEDULED] handleCreateScheduledSearch called for', userType, userId);
    
    try {
      if (!userId) throw new Error('User ID is required');
      if (!userType || !['driver', 'passenger'].includes(userType)) {
        throw new Error('Valid user type required');
      }
      
      const sanitizedPhone = this.sanitizePhoneNumber(userId);
      const collectionName = userType === 'driver' 
        ? 'scheduled_searches_driver' 
        : 'scheduled_searches_passenger';
      
      const sourceData = (data && data.data) ? data.data : (data || {});
      
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
        const extractedPhoto = passengerSource.photoUrl || sourceData.passengerPhotoUrl || 
                              sourceData.photoUrl || sourceData.profilePhoto || null;
        
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
        scheduledSearchData = {
          ...scheduledSearchData,
          availableSeats: sourceData.availableSeats || sourceData.capacity || 4,
          initialSeats: sourceData.availableSeats || sourceData.capacity || 4,
          driverName: sourceData.driverName || sourceData.name || 'Driver',
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
          rating: sourceData.rating || sourceData.driverRating || 5.0,
          totalRides: sourceData.totalRides || 0,
          isVerified: sourceData.isVerified || sourceData.verified || false,
          acceptedPassengers: [],
          rejectedMatches: [],
          acceptedPassengersSummary: [],
          cancelledPassengersHistory: [],
          totalAcceptedPassengers: 0,
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
          driverRating: scheduledSearchData.rating,
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
  
  // ========== EVENT-DRIVEN TRIGGER ==========
  
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
  
  // ========== PERFORM MATCHING ==========
  
  async performMatching() {
    console.log('🤝 [SCHEDULED] ========== PERFORMING MATCHING ==========');
    
    try {
      let drivers = [];
      let passengers = [];
      
      for (const [phone, cached] of this.activeDrivers.entries()) {
        if (cached && cached.data && Date.now() - cached.timestamp < this.userTTL) {
          const availableSeats = this.extractCapacity(cached.data);
          if (availableSeats > 0) {
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
          passengers.push({
            id: phone,
            data: cached.data
          });
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
  
  // ========== GET ACTIVE SCHEDULED SEARCHES ==========
  
  async getActiveScheduledSearches(userType) {
    const collectionName = userType === 'driver' 
      ? 'scheduled_searches_driver' 
      : 'scheduled_searches_passenger';
    
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
  
  // ========== GET USER SCHEDULED SEARCH ==========
  
  async getUserScheduledSearch(userType, phoneNumber) {
    if (!phoneNumber) return null;
    
    const collectionName = userType === 'driver' 
      ? 'scheduled_searches_driver' 
      : 'scheduled_searches_passenger';
    
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
      
      return { 
        id: docSnapshot.id, 
        ...data 
      };
    } catch (error) {
      console.error(`❌ [SCHEDULED] Error getting ${userType} search:`, error.message);
      return null;
    }
  }
  
  // ========== UPDATE SEARCH STATUS ==========
  
  async updateSearchStatus(userType, phoneNumber, updates) {
    if (!phoneNumber) return false;
    
    const collectionName = userType === 'driver' 
      ? 'scheduled_searches_driver' 
      : 'scheduled_searches_passenger';
    
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
  
  // ========== PROCESS MATCH ==========
  
  async processMatch(match) {
    try {
      console.log(`🤝 [SCHEDULED] Processing match for driver ${match.driverPhone} and passenger ${match.passengerPhone}`);
      
      const enrichedDriverData = await this.enrichDriverDataWithUserProfile(
        match.driverPhone, 
        match.driverData || {}
      );
      
      match.driverData = enrichedDriverData;
      
      const driverDetails = this.extractDriverDetails(match.driverData);
      const passengerDetails = this.extractPassengerDetails(match.passengerData || {});
      
      const pickupName = match.passengerData?.pickupName || 
                         match.passengerData?.rideDetails?.pickupName || 
                         'Pickup location';
      const destinationName = match.passengerData?.destinationName || 
                              match.passengerData?.rideDetails?.destinationName || 
                              'Destination';
      
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
        
        pickupLocation: this.extractLocation(match.driverData, 'pickupLocation') || 
                        this.extractLocation(match.passengerData, 'pickupLocation'),
        destinationLocation: this.extractLocation(match.driverData, 'destinationLocation') || 
                             this.extractLocation(match.passengerData, 'destinationLocation'),
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
      
      const matchId = await this.addDocument('scheduled_matches', matchData);
      
      console.log(`✅ [FIRESTORE] Added document to scheduled_matches: ${matchId}`);
      
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
      
      await this.sendNotification(match.driverPhone, {
        type: 'scheduled_match_proposed_to_driver',
        data: {
          matchId: matchId,
          passengerPhone: match.passengerPhone,
          passengerName: passengerDetails.name,
          passengerDetails: passengerDetails,
          tripDetails: {
            pickupName: pickupName,
            destinationName: destinationName,
            scheduledTime: match.passengerData?.scheduledTime,
            passengerCount: match.passengerCount,
            estimatedFare: match.passengerData?.estimatedFare,
            paymentMethod: match.passengerData?.paymentMethod || 'cash'
          },
          expiresAt: new Date(Date.now() + this.MATCH_EXPIRY).toISOString(),
          approvalDeadline: new Date(Date.now() + this.PENDING_EXPIRY).toISOString(),
          timestamp: new Date().toISOString()
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
  
  // ========== DRIVER MATCH DECISION HANDLER - FIXED VERSION ==========
  // This now properly updates the Firestore structure
  
  async handleDriverMatchDecision(matchId, driverPhone, decision) {
    try {
      console.log(`🤔 [SCHEDULED] Driver ${driverPhone} decision: ${decision} for match ${matchId}`);
      
      const matchRef = this.db.collection('scheduled_matches').doc(matchId);
      const matchDoc = await matchRef.get();
      
      if (!matchDoc.exists) {
        console.error(`❌ [SCHEDULED] Match ${matchId} not found`);
        return { success: false, error: 'Match not found' };
      }
      
      const matchData = matchDoc.data();
      if (matchData.driverPhone !== driverPhone) {
        console.error(`❌ [SCHEDULED] Unauthorized: ${driverPhone} vs ${matchData.driverPhone}`);
        return { success: false, error: 'Unauthorized' };
      }
      
      if (matchData.status === 'expired') {
        return { success: false, error: 'Match has expired', matchId };
      }
      
      if (decision === 'accept') {
        console.log(`✅ [SCHEDULED] Driver ${driverPhone} ACCEPTING match ${matchId}`);
        
        // Get driver document using the correct phone format
        const driverDocRef = this.db.collection('scheduled_searches_driver').doc(driverPhone);
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
        
        // Get passenger details from match data
        const passengerPhone = matchData.passengerPhone;
        const passengerName = matchData.passengerName || 'Passenger';
        const passengerPhoto = matchData.passengerDetails?.profilePhoto || 
                              matchData.passengerData?.passengerPhotoUrl || 
                              matchData.passengerData?.profilePhoto ||
                              null;
        
        // Create FULL passenger details object matching the structure in your logs
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
        
        // Get current accepted passengers
        const currentAccepted = driverDoc.acceptedPassengers || [];
        console.log(`📊 [SCHEDULED] Driver currently has ${currentAccepted.length} accepted passengers`);
        
        // Add new passenger to the array
        const updatedAccepted = [...currentAccepted, passengerFullDetails];
        
        // Create summary array
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
        
        // Calculate total accepted passengers
        const totalAccepted = (driverDoc.totalAcceptedPassengers || 0) + passengerCount;
        
        // Determine new status
        const driverNewStatus = newAvailableSeats <= 0 ? 'fully_booked' : 'actively_matching';
        
        console.log(`📝 [SCHEDULED] Updating driver document:`, {
          newAvailableSeats,
          driverNewStatus,
          totalAccepted,
          acceptedCount: updatedAccepted.length
        });
        
        // Prepare update data for driver - EXACT structure from your logs
        const driverUpdateData = {
          status: driverNewStatus,
          availableSeats: newAvailableSeats,
          acceptedPassengers: updatedAccepted,
          acceptedPassengersSummary: acceptedSummary,
          totalAcceptedPassengers: totalAccepted,
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
        
        // Update driver document
        await driverDocRef.update(driverUpdateData);
        console.log(`✅ [FIRESTORE] Updated driver document ${driverPhone} with accepted passenger`);
        
        // Update match document
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
        console.log(`✅ [FIRESTORE] Updated match document ${matchId} to confirmed`);
        
        // Update passenger document
        const passengerDocRef = this.db.collection('scheduled_searches_passenger').doc(passengerPhone);
        
        // Create driver details for passenger with REAL data
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
        
        // Remove from memory cache
        this.activePassengers.delete(passengerPhone);
        
        // Update driver in memory cache
        const cachedDriver = this.activeDrivers.get(driverPhone);
        if (cachedDriver) {
          cachedDriver.data = { ...cachedDriver.data, ...driverUpdateData };
          cachedDriver.timestamp = Date.now();
          this.activeDrivers.set(driverPhone, cachedDriver);
        }
        
        // If driver has no seats left, remove from active cache
        if (newAvailableSeats <= 0) {
          this.activeDrivers.delete(driverPhone);
        }
        
        // Send confirmation notifications
        await this.sendMatchConfirmedNotifications(matchData, matchId, driverPhone, driverDoc, passengerFullDetails);
        
        console.log(`✅ [SCHEDULED] Match ${matchId} confirmed!`);
        console.log(`👥 [SCHEDULED] Driver now has ${updatedAccepted.length} accepted passengers`);
        console.log(`💺 [SCHEDULED] Seats left: ${newAvailableSeats}`);
        console.log(`📸 [SCHEDULED] Passenger photo stored: ${passengerPhoto ? 'Yes' : 'No'}`);
        
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
        
      } else if (decision === 'reject') {
        console.log(`❌ [SCHEDULED] Driver ${driverPhone} REJECTING match ${matchId}`);
        
        await matchRef.update({
          status: 'driver_rejected',
          driverDecision: 'reject',
          driverDecisionAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        
        // Clear pending match from driver
        await this.updateSearchStatus('driver', driverPhone, {
          status: 'actively_matching',
          pendingMatchId: null,
          pendingMatchWith: null,
          pendingMatchStatus: null
        });
        
        // Put passenger back in matching pool
        await this.updateSearchStatus('passenger', matchData.passengerPhone, {
          status: 'actively_matching',
          matchId: null,
          matchedWith: null,
          matchStatus: null
        });
        
        // Add passenger back to memory cache
        const passengerDoc = await this.getDocument('scheduled_searches_passenger', matchData.passengerPhone);
        if (passengerDoc && (passengerDoc.exists || passengerDoc.data)) {
          const passengerData = passengerDoc.data ? passengerDoc.data() : passengerDoc;
          this.activePassengers.set(matchData.passengerPhone, {
            data: passengerData,
            timestamp: Date.now()
          });
        }
        
        console.log(`✅ [SCHEDULED] Match ${matchId} rejected`);
        
        return { success: true, matchId, decision };
      }
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error handling driver decision:', error.message);
      console.error('❌ [SCHEDULED] Error stack:', error.stack);
      return { success: false, error: error.message };
    }
  }
  
  // ========== SEND CONFIRMATION NOTIFICATIONS ==========
  
  async sendMatchConfirmedNotifications(matchData, matchId, driverPhone, driverDoc, passengerDetails) {
    try {
      // Notification for driver
      const driverNotification = {
        type: 'scheduled_match_confirmed',
        data: {
          matchId: matchId,
          confirmedBy: driverPhone,
          confirmedByType: 'driver',
          passengerPhone: matchData.passengerPhone,
          passengerName: matchData.passengerName,
          passengerDetails: passengerDetails,
          confirmedAt: new Date().toISOString(),
          timestamp: new Date().toISOString(),
          contactInfo: {
            passengerPhone: matchData.passengerPhone,
            passengerName: matchData.passengerName,
            passengerPhoto: passengerDetails.profilePhoto
          },
          matchDetails: matchData.matchDetails,
          pickupName: matchData.pickupName || 'Pickup location',
          destinationName: matchData.destinationName || 'Destination'
        }
      };
      
      await this.sendNotification(driverPhone, driverNotification, { important: true });
      
      // Notification for passenger
      const passengerNotification = {
        type: 'scheduled_match_confirmed',
        data: {
          matchId: matchId,
          confirmedBy: driverPhone,
          confirmedByType: 'driver',
          driverPhone: driverPhone,
          driverName: driverDoc.driverName || 'Driver',
          driverDetails: {
            name: driverDoc.driverName || 'Driver',
            phone: driverPhone,
            photoUrl: driverDoc.profilePhoto || null,
            rating: driverDoc.rating || 5.0,
            availableSeats: driverDoc.availableSeats || 0,
            vehicleInfo: driverDoc.vehicleInfo || {
              type: driverDoc.vehicleType || 'Car',
              model: driverDoc.vehicleModel || 'Standard',
              color: driverDoc.vehicleColor || 'Not specified',
              plate: driverDoc.licensePlate || 'Not specified'
            }
          },
          confirmedAt: new Date().toISOString(),
          timestamp: new Date().toISOString(),
          contactInfo: {
            driverPhone: driverPhone,
            driverName: driverDoc.driverName || 'Driver',
            vehicleInfo: driverDoc.vehicleInfo,
            driverPhoto: driverDoc.profilePhoto || null
          },
          matchDetails: matchData.matchDetails,
          pickupName: matchData.pickupName || 'Pickup location',
          destinationName: matchData.destinationName || 'Destination',
          scheduledTime: matchData.scheduledTime
        }
      };
      
      await this.sendNotification(matchData.passengerPhone, passengerNotification, { important: true });
      
      console.log(`🎉 [SCHEDULED] Confirmation notifications sent for match ${matchId}`);
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error sending confirmation notifications:', error.message);
    }
  }
  
  // ========== GET ACCEPTED PASSENGERS FOR DRIVER ==========
  
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
  
  // ========== NOTIFICATION METHODS ==========
  
  async sendNotification(userId, notification, options = {}) {
    try {
      console.log(`📨 [SCHEDULED] Sending notification to ${userId}, type: ${notification.type}`);
      
      if (this.websocketServer && this.websocketServer.sendToUser) {
        try {
          await this.websocketServer.sendToUser(userId, notification);
          console.log(`✅ [SCHEDULED] WebSocket sent to ${userId}`);
        } catch (wsError) {
          console.error(`❌ [SCHEDULED] WebSocket error:`, wsError.message);
        }
      }
      
      return { success: true };
    } catch (error) {
      console.error(`❌ [SCHEDULED] Error in sendNotification:`, error.message);
      return { success: false };
    }
  }
  
  // ========== DRIVER CANCELLATION HANDLERS ==========
  
  async handleDriverCancelAll(driverPhone, reason = 'driver_cancelled_trip') {
    console.log(`🚫 [SCHEDULED] Driver ${driverPhone} cancelling ALL passengers`);
    
    try {
      const driverDoc = await this.getUserScheduledSearch('driver', driverPhone);
      
      if (!driverDoc) {
        return { success: false, error: 'Driver schedule not found' };
      }
      
      const acceptedPassengers = driverDoc.acceptedPassengers || [];
      
      if (acceptedPassengers.length === 0) {
        return await this.cancelScheduledSearch(driverPhone, 'driver', reason);
      }
      
      console.log(`👥 Notifying ${acceptedPassengers.length} passengers about cancellation`);
      
      const batch = this.db.batch();
      
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
            canReschedule: true
          }
        }, { important: true });
      }
      
      const driverDocRef = this.db
        .collection('scheduled_searches_driver')
        .doc(this.sanitizePhoneNumber(driverPhone));
      
      batch.update(driverDocRef, {
        status: 'cancelled',
        cancellationReason: reason,
        cancelledAt: new Date().toISOString(),
        availableSeats: driverDoc.initialSeats || 4,
        acceptedPassengers: [],
        acceptedPassengersSummary: [],
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
      
      await batch.commit();
      
      console.log(`✅ [SCHEDULED] Driver ${driverPhone} cancelled all ${acceptedPassengers.length} passengers`);
      
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
  
  async handleDriverCancelPassenger(driverPhone, passengerPhone, reason = 'driver_cancelled_passenger') {
    console.log(`🚫 [SCHEDULED] Driver ${driverPhone} cancelling passenger ${passengerPhone}`);
    
    try {
      const driverDoc = await this.getUserScheduledSearch('driver', driverPhone);
      
      if (!driverDoc) {
        return { success: false, error: 'Driver schedule not found' };
      }
      
      const acceptedPassengers = driverDoc.acceptedPassengers || [];
      const passengerIndex = acceptedPassengers.findIndex(
        p => p.passengerPhone === passengerPhone
      );
      
      if (passengerIndex === -1) {
        return { success: false, error: 'Passenger not found in driver\'s accepted list' };
      }
      
      const cancelledPassenger = acceptedPassengers[passengerIndex];
      const passengerCount = cancelledPassenger.passengerCount || 1;
      const currentAvailableSeats = driverDoc.availableSeats || 0;
      const restoredSeats = currentAvailableSeats + passengerCount;
      
      const batch = this.db.batch();
      
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
        matchId: null,
        matchedWith: null,
        matchStatus: null,
        updatedAt: new Date().toISOString(),
        lastUpdated: Date.now()
      });
      
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
      
      await batch.commit();
      
      console.log(`✅ [SCHEDULED] Removed passenger ${passengerPhone} from driver ${driverPhone}`);
      console.log(`💺 [SCHEDULED] Seats restored: ${restoredSeats} (was ${currentAvailableSeats})`);
      
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
          canReschedule: true
        }
      }, { important: true });
      
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
  
  // ========== PASSENGER CANCELLATION HANDLER ==========
  
  async handlePassengerCancelRide(passengerPhone, driverPhone, reason = 'passenger_cancelled_ride') {
    console.log(`🚫 [SCHEDULED] Passenger ${passengerPhone} cancelling ride with driver ${driverPhone}`);
    
    try {
      const [passengerDoc, driverDoc] = await Promise.all([
        this.getUserScheduledSearch('passenger', passengerPhone),
        this.getUserScheduledSearch('driver', driverPhone)
      ]);
      
      if (!passengerDoc || !driverDoc) {
        return { success: false, error: 'Schedule not found' };
      }
      
      const acceptedPassengers = driverDoc.acceptedPassengers || [];
      const passengerIndex = acceptedPassengers.findIndex(p => p.passengerPhone === passengerPhone);
      
      if (passengerIndex === -1) {
        return { success: false, error: 'Passenger not found in driver\'s list' };
      }
      
      const cancelledPassenger = acceptedPassengers[passengerIndex];
      const passengerCount = cancelledPassenger.passengerCount || 1;
      
      const batch = this.db.batch();
      
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
      
      const driverRef = this.db.collection('scheduled_searches_driver')
        .doc(this.sanitizePhoneNumber(driverPhone));
      
      const updatedAccepted = acceptedPassengers.filter((_, i) => i !== passengerIndex);
      const newAvailableSeats = (driverDoc.availableSeats || 0) + passengerCount;
      
      batch.update(driverRef, {
        acceptedPassengers: updatedAccepted,
        availableSeats: newAvailableSeats,
        status: newAvailableSeats > 0 ? 'actively_matching' : 'fully_booked',
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
      
      const cancellationRef = this.db.collection(this.CANCELLATIONS).doc();
      await cancellationRef.set({
        ...cancellationData,
        id: cancellationRef.id,
        createdAt: new Date().toISOString()
      });
      
      console.log(`✅ [SCHEDULED] Passenger ${passengerPhone} cancelled ride with driver ${driverPhone}`);
      console.log(`💺 [SCHEDULED] Driver seats restored: ${newAvailableSeats}`);
      console.log(`📝 [SCHEDULED] Cancellation record created: ${cancellationRef.id}`);
      
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
          availableSeats: newAvailableSeats,
          remainingPassengers: updatedAccepted.length,
          canAcceptNewPassengers: newAvailableSeats > 0
        }
      }, { important: true });
      
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
  
  // ========== HELPER METHODS ==========
  
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
  
  extractTime(data) {
    try {
      const timeSources = [
        data.scheduledTimestamp,
        data.scheduledTime,
        data.rideDetails?.scheduledTime,
        data.createdAt
      ];
      
      for (const source of timeSources) {
        if (!source) continue;
        if (typeof source === 'number') return source;
        if (typeof source === 'string') {
          const ts = new Date(source).getTime();
          if (!isNaN(ts)) return ts;
        }
      }
      return Date.now();
    } catch {
      return Date.now();
    }
  }
  
  extractCapacity(data) {
    try {
      return data.availableSeats || 
             data.capacity || 
             data.seatsAvailable || 
             data.vehicleInfo?.capacity ||
             4;
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
        rating: data.rating || data.driverRating || data.vehicleInfo?.driverRating || 5.0,
        totalRides: data.totalRides || 0,
        profilePhoto: data.profilePhoto || data.driverPhoto || data.photoUrl || null,
        isVerified: data.isVerified || data.verified || false,
        availableSeats: this.extractCapacity(data)
      };
    } catch {
      return {
        name: 'Driver',
        phone: 'Unknown',
        vehicleInfo: {},
        vehicleType: 'Car',
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
  
  // ========== CLEANUP ==========
  
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
        'scheduled_matches',
        [
          { field: 'status', operator: 'in', value: ['awaiting_driver_approval', 'awaiting_passenger_approval'] },
          { field: 'proposedAt', operator: '<', value: expiryTime }
        ],
        10
      );
      
      if (matches && matches.length > 0) {
        for (const match of matches) {
          await this.updateDocument('scheduled_matches', match.id, {
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
