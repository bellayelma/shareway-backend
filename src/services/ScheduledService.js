// services/ScheduledService.js
// COMPLETE FIXED VERSION - NO RECENT MATCHES CACHE, ALWAYS MATCHES
// FIXED: Removed ALL recent matches cache references
// FIXED: Always matches when users are present
// OPTIMIZED: Event-driven, zero CPU when idle

const logger = require('../utils/Logger');

class ScheduledService {
  constructor(firestoreService, websocketServer, admin, notificationService) {
    console.log('🚀 [SCHEDULED] Initializing ALWAYS-MATCH version with NO BLOCKING CACHE...');
    
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
    
    // NO INTERVAL - completely event-driven
    this.MATCH_EXPIRY = 30 * 60 * 1000; // 30 minutes
    this.PENDING_EXPIRY = 15 * 60 * 1000; // 15 minutes
    
    // NO RECENT MATCHES CACHE - removed completely
    
    // Active users in memory
    this.activeDrivers = new Map(); // phone -> { data, timestamp }
    this.activePassengers = new Map(); // phone -> { data, timestamp }
    this.processingMatches = new Set(); // Currently processing matches (short-term only)
    this.userTTL = 30 * 60 * 1000; // 30 minutes
    
    // Throttling for triggers
    this.lastTriggerTime = 0;
    this.MIN_TRIGGER_INTERVAL = 2000; // 2 seconds minimum between triggers
    
    // Start cleanup interval only (runs every 5 minutes, minimal reads)
    this.cleanupInterval = setInterval(() => this.cleanup(), 300000); // 5 minutes
    
    logger.info('SCHEDULED_SERVICE', '🚀 Always-Match Scheduled Service initialized');
  }
  
  async start() {
    console.log('🚀 [SCHEDULED] Starting ALWAYS-MATCH service...');
    console.log('📊 Settings: Event-driven only, 5min cleanup, NO BLOCKING CACHE');
    console.log('📍 [SCHEDULED] LOCATION CHECKS DISABLED - Matching everyone');
    
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
  
  // ========== ENRICH DRIVER DATA ==========
  
  async enrichDriverDataWithUserProfile(driverPhone, driverData) {
    try {
      const sanitizedPhone = this.sanitizePhoneNumber(driverPhone);
      
      const userDoc = await this.getDocument('users', sanitizedPhone);
      
      if (userDoc && (userDoc.exists || userDoc.data)) {
        const userData = userDoc.data ? userDoc.data() : userDoc;
        
        const realName = userData.name || userData.displayName || userData.fullName;
        const realPhoto = userData.photoUrl || userData.photoURL || userData.profilePhoto;
        
        const enrichedData = {
          ...driverData,
          driverName: realName || driverData.driverName || 'Driver',
          profilePhoto: realPhoto || driverData.profilePhoto || null,
          name: realName || driverData.name || 'Driver',
          photoUrl: realPhoto || driverData.photoUrl || null,
        };
        
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
            capacity: enrichedData.availableSeats || 4,
            driverName: realName || 'Driver',
            driverPhone: driverPhone,
            driverPhotoUrl: realPhoto || null,
            driverRating: enrichedData.rating || 5.0,
            driverTotalRides: enrichedData.totalRides || 0,
            driverCompletedRides: enrichedData.completedRides || 0,
            driverVerified: enrichedData.isVerified || false
          };
        }
        
        return enrichedData;
      }
    } catch (error) {
      console.error('❌ [SCHEDULED] Error enriching driver data:', error.message);
    }
    
    return driverData;
  }
  
  // ========== CREATE/UPDATE SCHEDULED SEARCH ==========
  // FIXED: Triggers immediate matching when users are added
  
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
      
      const sourceData = data.data || data;
      
      // Validate time
      let scheduledTime = userType === 'driver' 
        ? sourceData.scheduledTime || sourceData.departureTime
        : sourceData.rideDetails?.scheduledTime || sourceData.scheduledTime || sourceData.departureTime;
      
      if (!scheduledTime) throw new Error('Scheduled time is required');
      
      const parsedTime = new Date(scheduledTime);
      if (isNaN(parsedTime.getTime())) throw new Error('Invalid scheduled time format');
      
      const scheduledTimestamp = parsedTime.getTime();
      const timeString = parsedTime.toISOString();
      
      // Extract passenger info
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
      
      // Build base document
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
      
      // Add driver-specific fields
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
        
        // vehicleInfo structure
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
      
      // Add passenger-specific fields
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
        
        // rideDetails structure
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
      
      // Check if document exists
      const exists = await this.documentExists(collectionName, sanitizedPhone);
      
      if (exists) {
        const docSnapshot = await this.getDocument(collectionName, sanitizedPhone);
        const existingData = docSnapshot.data ? docSnapshot.data() : docSnapshot;
        
        // Preserve accepted passengers and rejected matches
        if (userType === 'driver') {
          scheduledSearchData.acceptedPassengers = existingData.acceptedPassengers || [];
          scheduledSearchData.rejectedMatches = existingData.rejectedMatches || [];
          scheduledSearchData.acceptedPassengersSummary = existingData.acceptedPassengersSummary || [];
          scheduledSearchData.cancelledPassengersHistory = existingData.cancelledPassengersHistory || [];
          scheduledSearchData.totalAcceptedPassengers = existingData.totalAcceptedPassengers || 0;
          
          if (existingData.vehicleInfo) {
            scheduledSearchData.vehicleInfo = {
              ...existingData.vehicleInfo,
              ...scheduledSearchData.vehicleInfo
            };
          }
        }
        
        const updateData = {
          ...scheduledSearchData,
          createdAt: existingData.createdAt,
          updatedAt: new Date().toISOString(),
          lastUpdated: Date.now()
        };
        
        await this.updateDocument(collectionName, sanitizedPhone, updateData);
        console.log('✅ [SCHEDULED] Updated existing document:', sanitizedPhone);
      } else {
        await this.setDocument(collectionName, sanitizedPhone, scheduledSearchData);
        console.log('✅ [SCHEDULED] Created new document:', sanitizedPhone);
      }
      
      // ✅ STORE IN MEMORY FOR INSTANT MATCHING
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
      
      // ✅ TRIGGER MATCHING IMMEDIATELY
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
    
    // Throttle triggers (2 seconds minimum)
    if (now - this.lastTriggerTime < this.MIN_TRIGGER_INTERVAL) {
      console.log(`⏱️ [TRIGGER] Throttling - too soon (${now - this.lastTriggerTime}ms)`);
      return;
    }
    this.lastTriggerTime = now;
    
    console.log(`⚡ [TRIGGER] New ${triggeredByType} added: ${triggeredById}`);
    
    // Run matching in background (non-blocking)
    setTimeout(() => {
      this.performMatching().catch(err => 
        console.error('❌ [TRIGGER] Matching error:', err.message)
      );
    }, 100);
  }
  
  // ========== PERFORM MATCHING ==========
  // FIXED: NO RECENT MATCHES CACHE - always matches when users are present
  
  async performMatching() {
    console.log('🤝 [SCHEDULED] ========== PERFORMING MATCHING ==========');
    
    try {
      // STEP 1: Use memory cache first (fastest, zero reads)
      let drivers = [];
      let passengers = [];
      
      // Get active drivers from memory
      for (const [phone, cached] of this.activeDrivers.entries()) {
        if (Date.now() - cached.timestamp < this.userTTL) {
          const availableSeats = this.extractCapacity(cached.data);
          if (availableSeats > 0) {
            drivers.push({
              id: phone,
              data: cached.data
            });
          }
        } else {
          // Expired, remove from cache
          this.activeDrivers.delete(phone);
        }
      }
      
      // Get active passengers from memory
      for (const [phone, cached] of this.activePassengers.entries()) {
        if (Date.now() - cached.timestamp < this.userTTL) {
          passengers.push({
            id: phone,
            data: cached.data
          });
        } else {
          this.activePassengers.delete(phone);
        }
      }
      
      console.log(`📊 Memory cache: ${drivers.length} drivers, ${passengers.length} passengers`);
      
      // STEP 2: If no matches possible from memory, do a quick check
      if (drivers.length === 0 || passengers.length === 0) {
        console.log('💤 No match possible from memory, checking Firestore...');
        
        // Quick check from Firestore (minimal reads)
        const [dbDrivers, dbPassengers] = await Promise.all([
          this.getActiveScheduledSearches('driver'),
          this.getActiveScheduledSearches('passenger')
        ]);
        
        if (dbDrivers.length === 0 || dbPassengers.length === 0) {
          console.log('💤 No active users in Firestore - sleeping');
          return;
        }
        
        console.log(`📊 Firestore: ${dbDrivers.length} drivers, ${dbPassengers.length} passengers`);
        
        // Update memory cache with fresh data
        for (const driver of dbDrivers) {
          this.activeDrivers.set(driver.id, {
            data: driver.data,
            timestamp: Date.now()
          });
        }
        for (const passenger of dbPassengers) {
          this.activePassengers.set(passenger.id, {
            data: passenger.data,
            timestamp: Date.now()
          });
        }
        
        drivers = dbDrivers;
        passengers = dbPassengers;
      }
      
      console.log(`🎯 Final: ${drivers.length} drivers, ${passengers.length} passengers ready`);
      
      // STEP 3: Find matches - NO RECENT MATCHES CACHE!
      let matchesCreated = 0;
      const processedPairs = new Set(); // Only for this cycle, not persistent
      
      for (const driver of drivers) {
        const driverData = driver.data;
        const availableSeats = this.extractCapacity(driverData);
        
        if (availableSeats <= 0) continue;
        
        console.log(`👨‍✈️ Driver ${driver.id} has ${availableSeats} seats`);
        
        for (const passenger of passengers) {
          const passengerData = passenger.data;
          if (!passengerData) continue;
          
          const pairKey = `${driver.id}:${passenger.id}`;
          
          // Skip only if already processed in this cycle
          if (processedPairs.has(pairKey)) continue;
          processedPairs.add(pairKey);
          
          // Check if this pair is currently being processed (short-term lock)
          if (this.processingMatches.has(pairKey)) {
            console.log(`  ⚙️ Already processing: ${pairKey}, skipping for now`);
            continue;
          }
          
          const passengerCount = passengerData.passengerCount || 1;
          
          // ONLY CHECK SEAT AVAILABILITY
          if (passengerCount > availableSeats) {
            console.log(`  ❌ Passenger needs ${passengerCount} seats, driver only has ${availableSeats}`);
            continue;
          }
          
          // ✅ MATCH FOUND - ALWAYS MATCH, NO CACHE BLOCKING!
          console.log(`✅ MATCHING: Driver ${driver.id} ↔ Passenger ${passenger.id} (${passengerCount} pax)`);
          
          // Mark as processing to prevent duplicates (short-term lock)
          this.processingMatches.add(pairKey);
          
          // Process the match
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
          
          // Update driver in cache (seats decreased)
          const newSeats = availableSeats - passengerCount;
          driverData.availableSeats = newSeats;
          this.activeDrivers.set(driver.id, {
            data: driverData,
            timestamp: Date.now()
          });
          
          // Remove passenger from cache (they're now pending)
          this.activePassengers.delete(passenger.id);
          
          // If driver has no seats left, remove from cache
          if (newSeats <= 0) {
            this.activeDrivers.delete(driver.id);
          }
          
          // Break after one match per driver in this cycle
          break;
        }
      }
      
      console.log(`🎯 [SCHEDULED] Created ${matchesCreated} matches this cycle`);
      
      // Clean up processing markers after a delay
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
      // Get ALL actively_matching users
      const constraints = [
        { field: 'status', operator: '==', value: 'actively_matching' }
      ];
      
      const results = await this.queryCollection(collectionName, constraints, 100);
      
      const activeUsers = [];
      
      for (const item of results) {
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
      
      console.log(`📊 Found ${activeUsers.length} active ${userType}s (location checks disabled)`);
      return activeUsers;
      
    } catch (error) {
      console.error(`❌ [SCHEDULED] Error getting ${userType} searches:`, error.message);
      return [];
    }
  }
  
  // ========== PROCESS MATCH ==========
  
  async processMatch(match) {
    try {
      console.log(`🤝 [SCHEDULED] Processing match for driver ${match.driverPhone} and passenger ${match.passengerPhone}`);
      
      // Enrich driver data
      const enrichedDriverData = await this.enrichDriverDataWithUserProfile(
        match.driverPhone, 
        match.driverData
      );
      
      match.driverData = enrichedDriverData;
      
      const driverDetails = this.extractDriverDetails(match.driverData);
      const passengerDetails = this.extractPassengerDetails(match.passengerData);
      
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
        scheduledTime: match.driverData.scheduledTime || match.passengerData.scheduledTime,
        scheduledTimestamp: match.driverData.scheduledTimestamp || match.passengerData.scheduledTimestamp,
        
        passengerData: match.passengerData,
        driverData: match.driverData,
        
        matchDetails: {
          driverCapacity: match.availableSeats,
          passengerCount: match.passengerCount,
          estimatedFare: match.passengerData.estimatedFare || match.driverData.estimatedFare || 0,
          estimatedDistance: match.passengerData.estimatedDistance || match.driverData.estimatedDistance || 0
        }
      };
      
      const matchId = await this.addDocument('scheduled_matches', matchData);
      
      console.log(`✅ [SCHEDULED] Match document created: ${matchId}`);
      
      // Update driver
      await this.updateSearchStatus('driver', match.driverPhone, {
        status: 'actively_matching',
        pendingMatchId: matchId,
        pendingMatchWith: match.passengerPhone,
        pendingMatchStatus: 'awaiting_driver_approval'
      });
      
      // Update passenger
      await this.updateSearchStatus('passenger', match.passengerPhone, {
        status: 'pending_driver_approval',
        matchId: matchId,
        matchedWith: match.driverPhone,
        matchStatus: 'awaiting_driver_approval',
        lastActivityAt: new Date().toISOString(),
        lastActivityType: 'match_proposed'
      });
      
      // Send notification
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
            scheduledTime: match.passengerData.scheduledTime,
            passengerCount: match.passengerCount,
            estimatedFare: match.passengerData.estimatedFare,
            paymentMethod: match.passengerData.paymentMethod || 'cash'
          },
          expiresAt: new Date(Date.now() + this.MATCH_EXPIRY).toISOString(),
          approvalDeadline: new Date(Date.now() + this.PENDING_EXPIRY).toISOString(),
          timestamp: new Date().toISOString()
        }
      }, { important: true });
      
      // Remove from processing set after a delay
      setTimeout(() => {
        if (match.pairKey) {
          this.processingMatches.delete(match.pairKey);
          console.log(`🧹 [SCHEDULED] Removed processing lock for ${match.pairKey}`);
        }
      }, 15000);
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error processing match:', error.message);
      // Remove from processing set on error
      if (match.pairKey) {
        this.processingMatches.delete(match.pairKey);
      }
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
      
      // Update memory cache
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
  
  // ========== DRIVER ACCEPTANCE ==========
  
  async handleDriverMatchDecision(matchId, driverPhone, decision) {
    try {
      console.log(`🤔 [SCHEDULED] Driver ${driverPhone} decision: ${decision}`);
      
      const matchRef = this.db.collection('scheduled_matches').doc(matchId);
      const matchDoc = await matchRef.get();
      
      if (!matchDoc.exists) throw new Error('Match not found');
      
      const matchData = matchDoc.data();
      if (matchData.driverPhone !== driverPhone) throw new Error('Unauthorized');
      if (matchData.status === 'expired') {
        return { success: false, error: 'Match has expired', matchId };
      }
      
      const updateData = {
        driverDecision: decision,
        driverDecisionAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      if (decision === 'accept') {
        // Get driver document
        let driverDoc = await this.getDocument('scheduled_searches_driver', driverPhone);
        driverDoc = driverDoc.data ? driverDoc.data() : driverDoc;
        
        const currentAvailableSeats = this.extractCapacity(driverDoc);
        const passengerCount = matchData.matchDetails?.passengerCount || 1;
        const newAvailableSeats = currentAvailableSeats - passengerCount;
        
        // Update match
        updateData.status = 'confirmed';
        updateData.finalStatus = 'accepted';
        updateData.confirmedAt = new Date().toISOString();
        updateData.passengerDecision = 'accept';
        updateData.passengerDecisionAt = new Date().toISOString();
        updateData.passengerCount = passengerCount;
        updateData.remainingSeatsAfterThisMatch = Math.max(0, newAvailableSeats);
        
        await matchRef.update(updateData);
        
        // Create passenger record
        const passengerFullDetails = {
          passengerPhone: matchData.passengerPhone,
          passengerName: matchData.passengerName,
          passengerCount: passengerCount,
          profilePhoto: matchData.passengerDetails?.profilePhoto || null,
          photoUrl: matchData.passengerDetails?.profilePhoto || null,
          rating: matchData.passengerDetails?.rating || 5.0,
          totalRides: matchData.passengerDetails?.totalRides || 0,
          completedRides: matchData.passengerDetails?.completedRides || 0,
          isVerified: matchData.passengerDetails?.isVerified || false,
          pickupLocation: matchData.pickupLocation,
          destinationLocation: matchData.destinationLocation,
          pickupName: matchData.pickupName,
          destinationName: matchData.destinationName,
          scheduledTime: matchData.scheduledTime,
          scheduledTimestamp: matchData.scheduledTimestamp,
          paymentMethod: matchData.passengerDetails?.paymentMethod || 'cash',
          luggageCount: matchData.passengerData?.luggageCount || 0,
          specialRequests: matchData.passengerData?.specialRequests || '',
          matchId: matchId,
          acceptedAt: new Date().toISOString(),
          confirmedAt: new Date().toISOString(),
          status: 'confirmed',
          passengerInfo: matchData.passengerData?.passengerInfo,
          contactInfo: {
            phone: matchData.passengerPhone,
            name: matchData.passengerName,
            photoUrl: matchData.passengerDetails?.profilePhoto || null
          },
          locationCoordinates: {
            pickup: matchData.pickupLocation,
            destination: matchData.destinationLocation
          },
          estimatedFare: matchData.matchDetails?.estimatedFare || 0
        };
        
        // Update driver
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
          pickupName: p.pickupName,
          destinationName: p.destinationName,
          estimatedFare: p.estimatedFare
        }));
        
        const driverNewStatus = newAvailableSeats <= 0 ? 'fully_booked' : 'actively_matching';
        
        await this.updateSearchStatus('driver', driverPhone, {
          status: driverNewStatus,
          availableSeats: Math.max(0, newAvailableSeats),
          acceptedPassengers: updatedAccepted,
          acceptedPassengersSummary: acceptedSummary,
          lastAcceptedAt: new Date().toISOString(),
          lastConfirmedAt: new Date().toISOString(),
          pendingMatchId: null,
          pendingMatchWith: null,
          pendingMatchStatus: null,
          totalAcceptedPassengers: (driverDoc.totalAcceptedPassengers || 0) + passengerCount,
          lastActivityAt: new Date().toISOString(),
          lastActivityType: 'confirmed_match'
        });
        
        // Build driver details for passenger
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
        
        // Update passenger
        await this.updateSearchStatus('passenger', matchData.passengerPhone, {
          status: 'matched_confirmed',
          matchId: matchId,
          matchedWith: driverPhone,
          matchStatus: 'confirmed',
          confirmedAt: new Date().toISOString(),
          driverAccepted: true,
          driverAcceptedAt: new Date().toISOString(),
          driverDetails: driverDetailsForPassenger
        });
        
        // Remove from memory cache
        this.activePassengers.delete(matchData.passengerPhone);
        
        // Send confirmations
        await this.notifyMatchConfirmed(matchData, matchId, driverPhone, decision);
        
        console.log(`✅ [SCHEDULED] Match ${matchId} confirmed! Seats left: ${newAvailableSeats}`);
        
        return { success: true, matchId, decision };
        
      } else if (decision === 'reject') {
        updateData.status = 'driver_rejected';
        await matchRef.update(updateData);
        
        // Driver stays active
        await this.updateSearchStatus('driver', driverPhone, {
          status: 'actively_matching',
          pendingMatchId: null,
          pendingMatchWith: null,
          pendingMatchStatus: null
        });
        
        // Passenger goes back to matching pool
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
        
        console.log(`❌ [SCHEDULED] Driver rejected match ${matchId}`);
        
        return { success: true, matchId, decision };
      }
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error handling driver decision:', error.message);
      return { success: false, error: error.message };
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
  
  async notifyMatchConfirmed(matchData, matchId, confirmingUserId, decision) {
    const driverNotification = {
      type: 'scheduled_match_confirmed',
      data: {
        matchId: matchId,
        confirmedBy: confirmingUserId,
        confirmedByType: 'driver',
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
    
    const passengerNotification = {
      type: 'scheduled_match_confirmed',
      data: {
        matchId: matchId,
        confirmedBy: confirmingUserId,
        confirmedByType: 'driver',
        driverPhone: matchData.driverPhone,
        driverName: matchData.driverName,
        driverDetails: {
          name: matchData.driverName,
          phone: matchData.driverPhone,
          photoUrl: matchData.driverDetails?.profilePhoto || matchData.driverData?.profilePhoto,
          rating: matchData.driverDetails?.rating || 5.0,
          availableSeats: matchData.matchDetails?.driverCapacity || 0,
          vehicleInfo: matchData.driverData?.vehicleInfo || {
            type: matchData.driverData?.vehicleType || 'Car',
            model: matchData.driverData?.vehicleModel || 'Standard',
            color: matchData.driverData?.vehicleColor || 'Not specified',
            plate: matchData.driverData?.licensePlate || 'Not specified'
          }
        },
        confirmedAt: new Date().toISOString(),
        timestamp: new Date().toISOString(),
        contactInfo: {
          driverPhone: matchData.driverPhone,
          driverName: matchData.driverName,
          vehicleInfo: matchData.driverData?.vehicleInfo,
          driverPhoto: matchData.driverDetails?.profilePhoto || matchData.driverData?.profilePhoto
        },
        matchDetails: matchData.matchDetails,
        pickupName: matchData.pickupName || 'Pickup location',
        destinationName: matchData.destinationName || 'Destination',
        scheduledTime: matchData.scheduledTime
      }
    };
    
    await Promise.all([
      this.sendNotification(matchData.driverPhone, driverNotification, { important: true }),
      this.sendNotification(matchData.passengerPhone, passengerNotification, { important: true })
    ]);
    
    console.log(`🎉 [SCHEDULED] Match ${matchId} confirmed notifications sent!`);
  }
  
  // ========== GET ACCEPTED PASSENGERS ==========
  
  async getDriverAcceptedPassengers(driverPhone) {
    try {
      const driverDoc = await this.getDocument('scheduled_searches_driver', driverPhone);
      
      if (!driverDoc || !(driverDoc.exists || driverDoc.data)) {
        return { success: false, error: 'Driver not found', passengers: [] };
      }
      
      const driverData = driverDoc.data ? driverDoc.data() : driverDoc;
      const acceptedPassengers = driverData.acceptedPassengers || [];
      
      const enhancedPassengers = acceptedPassengers.map(passenger => ({
        ...passenger,
        displayName: passenger.passengerName || passenger.name || 'Passenger',
        photoUrl: passenger.profilePhoto || passenger.photoUrl,
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
        totalPassengers: enhancedPassengers.length,
        availableSeats: driverData.availableSeats || 0,
        driverStatus: driverData.status,
        driverName: driverData.driverName,
        driverPhone: driverPhone,
        driverDoc: {
          id: driverData.id,
          driverName: driverData.driverName,
          availableSeats: driverData.availableSeats,
          initialSeats: driverData.initialSeats || 4,
          status: driverData.status,
          scheduledTime: driverData.scheduledTime,
          pickupName: driverData.pickupName,
          destinationName: driverData.destinationName,
          vehicleInfo: driverData.vehicleInfo
        }
      };
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error getting driver passengers:', error.message);
      return { success: false, error: error.message, passengers: [] };
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
  
  // ========== CLEANUP ==========
  
  async cleanup() {
    console.log('🧹 [SCHEDULED] Running cleanup...');
    
    const now = Date.now();
    let cleaned = 0;
    
    // Clean memory cache
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
    
    // Clean expired matches from Firestore (minimal reads)
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
