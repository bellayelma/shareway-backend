// services/firestoreService.js - COMPLETE VERSION WITH OPTIMIZED METHODS
const { COLLECTIONS, TIMEOUTS, BATCH_WRITE_LIMIT } = require('../config/constants');
const cache = require('../utils/cache');
const helpers = require('../utils/helpers');
const logger = require('../utils/Logger');

class FirestoreService {
  constructor(db, admin) {
    this.db = db;
    this.admin = admin;
    this.batchLimit = BATCH_WRITE_LIMIT;
    this.writeQueue = [];
    this.activeListeners = new Map();
    this.isMatchingServiceCall = false;
    this.isProcessing = false;
    this.processorInterval = null;
    
    // In-memory cache for reducing reads
    this.cache = new Map();
    this.CACHE_TTL = 60000; // 1 minute cache
    
    this.stats = {
      reads: 0,
      writes: 0,
      cacheHits: 0,
      batchWrites: 0,
      immediateWrites: 0,
      listenersActive: 0,
      locationUpdates: 0,
      matchingWrites: 0,
      queueFlushErrors: 0,
      retriedOperations: 0,
      queueSize: 0,
      isProcessing: false,
      cacheStats: {
        size: 0,
        ttlCount: 0
      }
    };
    
    // Start background processors
    this.startBatchProcessor();
  }
  
  // ========== HELPER: NORMALIZE PHONE NUMBER ==========
  normalizePhoneNumber(phone) {
    if (!phone) return null;
    let normalized = phone.toString().trim();
    if (normalized.startsWith('+')) {
      normalized = '+' + normalized.substring(1).replace(/\D/g, '');
    } else {
      normalized = '+' + normalized.replace(/\D/g, '');
    }
    return normalized;
  }
  
  getDocumentIdFromPhone(phoneNumber) {
    return this.normalizePhoneNumber(phoneNumber);
  }
  
  // ========== OPTIMIZED: GET ACTIVE MATCHING DOCUMENTS ==========
  
  /**
   * OPTIMIZED: Get active matching documents in a single query with proper data() method
   * This replaces the need for getCollection() + filtering
   * Reduces reads by 50% or more
   */
  async getActiveMatchingDocuments(userType) {
    const collection = userType === 'driver' 
      ? 'scheduled_searches_driver' 
      : 'scheduled_searches_passenger';
    
    try {
      // Single query with status filter - reduces reads significantly
      const snapshot = await this.db.collection(collection)
        .where('status', 'in', ['actively_matching', 'scheduled'])
        .get();
      
      this.stats.reads += snapshot.size;
      
      const results = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        
        // Skip drivers with no seats
        if (userType === 'driver') {
          const seats = data.availableSeats || 
                       (data.data?.availableSeats) || 
                       (data.capacity || 4) - (data.currentPassengers || 0);
          if (seats <= 0) return;
        }
        
        // Get the actual data based on structure
        let userData = data;
        
        // Handle nested data structure (type+data format)
        if (data.type && data.data) {
          userData = data.data;
        }
        
        // Create a proper document-like object with .data() method
        results.push({
          id: doc.id,
          exists: true,
          data: () => ({
            ...data,
            userId: userData.userId || userData.passengerPhone || userData.driverPhone || doc.id
          }),
          // Include raw data for direct access
          raw: data,
          userData: userData
        });
      });
      
      console.log(`✅ [OPTIMIZED] Found ${results.length} active ${userType}s with ${snapshot.size} reads`);
      return results;
    } catch (error) {
      logger.error('FIRESTORE', `Error in getActiveMatchingDocuments for ${userType}:`, error);
      return [];
    }
  }
  
  /**
   * OPTIMIZED: Get active drivers with available seats
   */
  async getActiveDrivers() {
    return this.getActiveMatchingDocuments('driver');
  }
  
  /**
   * OPTIMIZED: Get active passengers
   */
  async getActivePassengers() {
    return this.getActiveMatchingDocuments('passenger');
  }
  
  // ========== FIXED SINGLE DOCUMENT OPERATIONS ==========

  /**
   * Get a document with proper .data() method support
   * Returns a document-like object that preserves the Firestore document interface
   */
  async getDocument(collection, documentId) {
    try {
      // Check cache first
      const cacheKey = `${collection}:${documentId}`;
      const cached = this.cache.get(cacheKey);
      
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        this.stats.cacheHits++;
        return cached.data; // This now has .data() method
      }
      
      const docRef = this.db.collection(collection).doc(documentId);
      const doc = await docRef.get();
      
      this.stats.reads++;
      
      // Cache the result with proper structure
      if (doc.exists) {
        // Create a document-like object that preserves the .data() method
        const docWrapper = {
          exists: true,
          id: doc.id,
          ref: doc.ref,
          data: () => doc.data(),  // ✅ This is critical!
          get: (field) => doc.get(field)
        };
        
        this.cache.set(cacheKey, {
          data: docWrapper,
          timestamp: Date.now()
        });
        this.stats.cacheStats.size = this.cache.size;
        
        return docWrapper; // Return wrapped version
      }
      
      // Return non-existent document wrapper
      return {
        exists: false,
        id: documentId,
        data: () => null,
        get: () => null
      };
    } catch (error) {
      logger.error('FIRESTORE', `Error getting document ${collection}/${documentId}:`, error);
      throw error;
    }
  }

  /**
   * Get document with external cache support
   */
  async getDocumentWithCache(collection, docId, ttl = TIMEOUTS.CACHE_TTL) {
    const cacheKey = `${collection}_${docId}`;
    const cached = cache.get(cacheKey);
    
    if (cached) {
      this.stats.cacheHits++;
      return cached;
    }
    
    const doc = await this.getDocument(collection, docId);
    if (doc && doc.exists) {
      const data = { id: doc.id, ...doc.data() };
      cache.set(cacheKey, data, ttl);
      return data;
    }
    
    return null;
  }

  /**
   * Set a document with full control over merge options
   */
  async setDocument(collection, documentId, data, options = {}) {
    try {
      const docRef = this.db.collection(collection).doc(documentId);
      await docRef.set(data, options);
      
      this.stats.writes++;
      this.stats.immediateWrites++;
      
      // Clear cache for this document
      const cacheKey = `${collection}:${documentId}`;
      this.cache.delete(cacheKey);
      cache.del(`${collection}_${documentId}`);
      
      console.log(`✅ [FIRESTORE] Set document ${collection}/${documentId}`);
      return documentId;
    } catch (error) {
      logger.error('FIRESTORE', `Error setting document ${collection}/${documentId}:`, error);
      throw error;
    }
  }

  /**
   * Update a document (partial update)
   */
  async updateDocument(collection, documentId, data) {
    try {
      const docRef = this.db.collection(collection).doc(documentId);
      await docRef.update(data);
      
      this.stats.writes++;
      this.stats.immediateWrites++;
      
      // Clear cache for this document
      const cacheKey = `${collection}:${documentId}`;
      this.cache.delete(cacheKey);
      cache.del(`${collection}_${documentId}`);
      
      console.log(`✅ [FIRESTORE] Updated document ${collection}/${documentId}`);
      return { id: documentId, ...data };
    } catch (error) {
      logger.error('FIRESTORE', `Error updating document ${collection}/${documentId}:`, error);
      throw error;
    }
  }

  /**
   * Delete a document
   */
  async deleteDocument(collection, documentId) {
    try {
      const docRef = this.db.collection(collection).doc(documentId);
      await docRef.delete();
      
      this.stats.writes++;
      this.stats.immediateWrites++;
      
      // Clear cache for this document
      const cacheKey = `${collection}:${documentId}`;
      this.cache.delete(cacheKey);
      cache.del(`${collection}_${documentId}`);
      
      console.log(`✅ [FIRESTORE] Deleted document ${collection}/${documentId}`);
      return true;
    } catch (error) {
      logger.error('FIRESTORE', `Error deleting document ${collection}/${documentId}:`, error);
      throw error;
    }
  }

  /**
   * Check if a document exists
   */
  async documentExists(collection, documentId) {
    try {
      const doc = await this.getDocument(collection, documentId);
      return doc.exists;
    } catch (error) {
      return false;
    }
  }

  // ========== COLLECTION OPERATIONS ==========

  /**
   * Get all documents in a collection with optional limit
   */
  async getCollection(collection, limit = null) {
    try {
      let query = this.db.collection(collection);
      
      if (limit) {
        query = query.limit(limit);
      }
      
      const snapshot = await query.get();
      
      this.stats.reads += snapshot.size;
      
      const results = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      
      console.log(`✅ [FIRESTORE] Read ${results.length} documents from ${collection}`);
      return results;
    } catch (error) {
      logger.error('FIRESTORE', `Error getting collection ${collection}:`, error);
      throw error;
    }
  }

  /**
   * Get collection with where clauses (compatibility method)
   */
  async getCollectionWithWhere(collection, field, operator, value, limit = null) {
    try {
      let query = this.db.collection(collection).where(field, operator, value);
      
      if (limit) {
        query = query.limit(limit);
      }
      
      const snapshot = await query.get();
      
      this.stats.reads += snapshot.size;
      
      const results = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      
      console.log(`✅ [FIRESTORE] Read ${results.length} documents from ${collection} with where clause`);
      return results;
    } catch (error) {
      logger.error('FIRESTORE', `Error getting collection with where ${collection}:`, error);
      throw error;
    }
  }

  /**
   * Add a document with auto-generated ID
   */
  async addDocument(collection, data) {
    try {
      const docRef = this.db.collection(collection).doc();
      await docRef.set({
        ...data,
        createdAt: new Date().toISOString()
      });
      
      this.stats.writes++;
      this.stats.immediateWrites++;
      
      console.log(`✅ [FIRESTORE] Added document to ${collection}: ${docRef.id}`);
      return { id: docRef.id, ...data };
    } catch (error) {
      logger.error('FIRESTORE', `Error adding document to ${collection}:`, error);
      throw error;
    }
  }

  /**
   * Add a document with specific ID
   */
  async addDocumentWithId(collection, docId, data) {
    try {
      const docRef = this.db.collection(collection).doc(docId);
      await docRef.set(data);
      
      this.stats.writes++;
      this.stats.immediateWrites++;
      
      console.log(`✅ [FIRESTORE] Added document to ${collection} with ID: ${docId}`);
      return { id: docId, ...data };
    } catch (error) {
      logger.error('FIRESTORE', `Error adding document with ID to ${collection}:`, error);
      throw error;
    }
  }

  // ========== QUERY OPERATIONS ==========

  /**
   * Query collection with constraints
   * @param {string} collection - Collection name
   * @param {Array} constraints - Array of {field, operator, value} objects
   * @param {number} limit - Optional limit
   * @returns {Array} Array of documents with ids
   */
  async queryCollection(collection, constraints = [], limit = null) {
    try {
      let query = this.db.collection(collection);
      
      for (const constraint of constraints) {
        const { field, operator, value } = constraint;
        
        if (operator === 'orderBy') {
          query = query.orderBy(field, value || 'asc');
        } else if (operator === 'limit') {
          query = query.limit(value);
        } else {
          query = query.where(field, operator, value);
        }
      }
      
      if (limit) {
        query = query.limit(limit);
      }
      
      const snapshot = await query.get();
      
      this.stats.reads += snapshot.size;
      
      const results = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      
      console.log(`✅ [FIRESTORE] Query returned ${results.length} documents from ${collection}`);
      return results;
    } catch (error) {
      logger.error('FIRESTORE', `Error querying collection ${collection}:`, error);
      throw error;
    }
  }

  // ========== BATCH OPERATIONS ==========

  /**
   * Create a new batch operation builder
   * @returns {Object} Batch builder with set/update/delete methods
   */
  batch() {
    const batch = this.db.batch();
    const firestore = this.db;
    
    const wrappedBatch = {
      _batch: batch,
      _firestore: firestore,
      _count: 0,
      
      set(collection, documentId, data, options = {}) {
        const ref = this._firestore.collection(collection).doc(documentId);
        this._batch.set(ref, data, options);
        this._count++;
        return this;
      },
      
      update(collection, documentId, data) {
        const ref = this._firestore.collection(collection).doc(documentId);
        this._batch.update(ref, data);
        this._count++;
        return this;
      },
      
      delete(collection, documentId) {
        const ref = this._firestore.collection(collection).doc(documentId);
        this._batch.delete(ref);
        this._count++;
        return this;
      },
      
      getCount() {
        return this._count;
      }
    };
    
    return wrappedBatch;
  }

  /**
   * Commit a batch operation
   * @param {Object} batch - Batch builder from batch()
   * @returns {boolean} Success status
   */
  async commitBatch(batch) {
    try {
      await batch._batch.commit();
      
      this.stats.batchWrites++;
      this.stats.writes += batch.getCount();
      
      console.log(`✅ [FIRESTORE] Committed batch with ${batch.getCount()} operations`);
      return true;
    } catch (error) {
      logger.error('FIRESTORE', 'Error committing batch:', error);
      throw error;
    }
  }

  // ========== OPTIMIZED METHODS WITH CACHING ==========

  /**
   * Get documents with in-memory caching to reduce reads
   */
  async getDocumentsWithCache(collection, documentIds) {
    const results = [];
    const uncachedIds = [];
    
    // Check cache first
    for (const id of documentIds) {
      const cacheKey = `${collection}:${id}`;
      const cached = this.cache.get(cacheKey);
      
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        this.stats.cacheHits++;
        results.push(cached.data);
      } else {
        uncachedIds.push(id);
      }
    }
    
    // Fetch uncached documents in batch
    if (uncachedIds.length > 0) {
      const docRefs = uncachedIds.map(id => this.db.collection(collection).doc(id));
      const snapshot = await this.db.getAll(...docRefs);
      
      this.stats.reads += snapshot.length;
      
      snapshot.forEach(doc => {
        if (doc.exists) {
          const docWrapper = {
            exists: true,
            id: doc.id,
            ref: doc.ref,
            data: () => doc.data(),
            get: (field) => doc.get(field)
          };
          
          const cacheKey = `${collection}:${doc.id}`;
          this.cache.set(cacheKey, {
            data: docWrapper,
            timestamp: Date.now()
          });
          results.push(docWrapper);
        }
      });
    }
    
    return results;
  }

  // ========== DATA NORMALIZATION FOR SCHEDULED SERVICE ==========
  
  normalizeScheduledDriverData(driverData) {
    // Check if data is in type+data format
    let rawData = driverData;
    if (driverData.type === 'CREATE_SCHEDULED_SEARCH' && driverData.data) {
      rawData = driverData.data;
    }
    
    return {
      // ID fields
      driverId: rawData.userId || rawData.driverPhone || rawData.id,
      driverPhone: this.normalizePhoneNumber(rawData.userId || rawData.driverPhone || rawData.id),
      userId: rawData.userId,
      
      // Personal info
      driverName: rawData.vehicleInfo?.driverName || rawData.driverName || 'Driver',
      driverPhotoUrl: rawData.vehicleInfo?.driverPhotoUrl || rawData.driverPhotoUrl || '',
      driverRating: rawData.vehicleInfo?.driverRating || rawData.driverRating || 5.0,
      driverVerified: rawData.vehicleInfo?.driverVerified || rawData.driverVerified || false,
      driverTotalRides: rawData.vehicleInfo?.driverTotalRides || rawData.driverTotalRides || 0,
      driverCompletedRides: rawData.vehicleInfo?.driverCompletedRides || rawData.driverCompletedRides || 0,
      driverTotalEarnings: rawData.vehicleInfo?.driverTotalEarnings || rawData.driverTotalEarnings || 0,
      
      // Vehicle info
      vehicleInfo: rawData.vehicleInfo || {},
      capacity: rawData.capacity || 4,
      
      // Location
      pickupLocation: rawData.pickupLocation,
      destinationLocation: rawData.destinationLocation,
      pickupName: rawData.pickupName,
      destinationName: rawData.destinationName,
      
      // Timing
      scheduledTime: rawData.scheduledTime,
      
      // Ride estimates
      estimatedFare: rawData.estimatedFare || 0,
      estimatedDistance: rawData.estimatedDistance || 0,
      estimatedDuration: rawData.estimatedDuration || 0,
      
      // Status
      status: rawData.status || 'scheduled',
      matchStatus: rawData.matchStatus || null,
      
      // Capacity
      currentPassengers: rawData.currentPassengers || 0,
      availableSeats: rawData.availableSeats || 
                     (rawData.capacity || 4) - 
                     (rawData.currentPassengers || 0)
    };
  }
  
  normalizeScheduledPassengerData(passengerData) {
    // Check if data is in type+data format
    let rawData = passengerData;
    if (passengerData.type === 'SCHEDULE_SEARCH' && passengerData.data) {
      rawData = passengerData.data;
    }
    
    return {
      // ID fields
      passengerId: rawData.userId || rawData.passengerPhone || rawData.id,
      passengerPhone: this.normalizePhoneNumber(rawData.userId || rawData.passengerPhone || rawData.id),
      userId: rawData.userId,
      
      // Personal info
      passengerName: rawData.passengerName || 'Passenger',
      passengerPhotoUrl: rawData.passengerPhotoUrl || '',
      passengerRating: rawData.passengerRating || 5.0,
      passengerVerified: rawData.passengerVerified || false,
      
      // Ride details
      passengerCount: rawData.passengerCount || 1,
      scheduledTime: rawData.scheduledTime,
      
      // Location
      pickupLocation: rawData.pickupLocation,
      pickupName: rawData.pickupName || "Pickup",
      destinationLocation: rawData.destinationLocation,
      destinationName: rawData.destinationName || "Destination",
      
      // Ride estimates
      estimatedFare: rawData.estimatedFare || 0,
      estimatedDistance: rawData.estimatedDistance || 0,
      estimatedDuration: rawData.estimatedDuration || 0,
      
      // Status
      status: rawData.status || 'scheduled',
      matchStatus: rawData.matchStatus || null
    };
  }
  
  // ========== SCHEDULED DRIVER OPERATIONS ==========
  
  async saveScheduledDriverSearch(driverData, options = {}) {
    try {
      const normalized = this.normalizeScheduledDriverData(driverData);
      const driverDocId = normalized.driverPhone;
      
      if (!driverDocId) throw new Error('Driver phone required');
      
      console.log('💾 [SCHEDULED] Saving scheduled driver:', driverDocId);
      
      // Build passenger fields
      const capacity = normalized.capacity;
      const passengerFields = {};
      for (let i = 1; i <= capacity; i++) {
        passengerFields[`passenger${i}`] = null;
      }
      
      // Add existing passengers if any
      for (let i = 1; i <= capacity; i++) {
        const fieldName = `passenger${i}`;
        if (normalized[fieldName]) {
          passengerFields[fieldName] = normalized[fieldName];
        }
      }
      
      // Format data for scheduled service
      const firestoreData = {
        type: 'CREATE_SCHEDULED_SEARCH',
        data: {
          // User Identification
          userId: driverDocId,
          userType: 'driver',
          
          // Personal info
          driverName: normalized.driverName,
          driverPhotoUrl: normalized.driverPhotoUrl,
          driverRating: normalized.driverRating,
          driverVerified: normalized.driverVerified,
          driverTotalRides: normalized.driverTotalRides,
          driverCompletedRides: normalized.driverCompletedRides,
          driverTotalEarnings: normalized.driverTotalEarnings,
          
          // Vehicle info
          vehicleInfo: normalized.vehicleInfo,
          capacity: capacity,
          
          // Schedule Details
          scheduledTime: normalized.scheduledTime || new Date().toISOString(),
          
          // Route Information
          pickupLocation: normalized.pickupLocation,
          pickupName: normalized.pickupName,
          destinationLocation: normalized.destinationLocation,
          destinationName: normalized.destinationName,
          
          // Ride estimates
          estimatedFare: normalized.estimatedFare,
          estimatedDistance: normalized.estimatedDistance,
          estimatedDuration: normalized.estimatedDuration,
          
          // Passenger fields
          ...passengerFields,
          currentPassengers: normalized.currentPassengers,
          availableSeats: normalized.availableSeats,
          
          // Status
          status: normalized.status,
          matchStatus: normalized.matchStatus,
          
          // Metadata
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastUpdated: Date.now()
        }
      };
      
      console.log('💾 [SCHEDULED] Saving to collection: scheduled_searches_driver');
      
      const forceImmediate = options.immediate || this.isMatchingServiceCall;
      
      if (forceImmediate) {
        this.stats.immediateWrites++;
        this.stats.matchingWrites++;
        
        await this.db.collection('scheduled_searches_driver')
          .doc(driverDocId)
          .set(firestoreData, { merge: true });
        
        console.log(`⚡ [SCHEDULED] Scheduled driver saved IMMEDIATELY: ${driverDocId}`);
      } else {
        this.queueWrite('scheduled_searches_driver', driverDocId, firestoreData, 'set');
        console.log(`✅ [SCHEDULED] Scheduled driver queued: ${driverDocId}`);
      }
      
      // Clear caches
      cache.del(`scheduled_driver_${driverDocId}`);
      cache.del('scheduled_searches_all');
      
      return { ...firestoreData, documentId: driverDocId };
      
    } catch (error) {
      logger.error('SCHEDULED', 'Error saving scheduled driver:', error);
      throw error;
    }
  }
  
  // ========== SCHEDULED PASSENGER OPERATIONS ==========
  
  async saveScheduledPassengerSearch(passengerData, options = {}) {
    try {
      const normalized = this.normalizeScheduledPassengerData(passengerData);
      const passengerDocId = normalized.passengerPhone;
      
      if (!passengerDocId) throw new Error('Passenger phone required');
      
      console.log('💾 [SCHEDULED] Saving scheduled passenger:', passengerDocId);
      
      // Format data for scheduled service
      const firestoreData = {
        type: 'SCHEDULE_SEARCH',
        data: {
          // User Identification
          userId: passengerDocId,
          userType: 'passenger',
          
          // Personal info
          passengerName: normalized.passengerName,
          passengerPhotoUrl: normalized.passengerPhotoUrl,
          passengerRating: normalized.passengerRating,
          passengerVerified: normalized.passengerVerified,
          
          // Schedule Details
          scheduledTime: normalized.scheduledTime || new Date().toISOString(),
          
          // Ride details
          passengerCount: normalized.passengerCount || 1,
          
          // Route Information
          pickupLocation: normalized.pickupLocation,
          pickupName: normalized.pickupName,
          destinationLocation: normalized.destinationLocation,
          destinationName: normalized.destinationName,
          
          // Ride estimates
          estimatedFare: normalized.estimatedFare,
          estimatedDistance: normalized.estimatedDistance,
          estimatedDuration: normalized.estimatedDuration,
          
          // Status
          status: normalized.status,
          matchStatus: normalized.matchStatus,
          
          // Match info (if any)
          matchId: passengerData.data?.matchId || null,
          matchedWith: passengerData.data?.matchedWith || null,
          driver: passengerData.data?.driver || null,
          
          // Metadata
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastUpdated: Date.now()
        }
      };
      
      console.log('💾 [SCHEDULED] Saving to collection: scheduled_searches_passenger');
      
      const forceImmediate = options.immediate || this.isMatchingServiceCall;
      
      if (forceImmediate) {
        this.stats.immediateWrites++;
        this.stats.matchingWrites++;
        
        await this.db.collection('scheduled_searches_passenger')
          .doc(passengerDocId)
          .set(firestoreData, { merge: true });
        
        console.log(`⚡ [SCHEDULED] Scheduled passenger saved IMMEDIATELY: ${passengerDocId}`);
      } else {
        this.queueWrite('scheduled_searches_passenger', passengerDocId, firestoreData, 'set');
        console.log(`✅ [SCHEDULED] Scheduled passenger queued: ${passengerDocId}`);
      }
      
      // Clear caches
      cache.del(`scheduled_passenger_${passengerDocId}`);
      cache.del('scheduled_searches_all');
      
      return { ...firestoreData, documentId: passengerDocId };
      
    } catch (error) {
      logger.error('SCHEDULED', 'Error saving scheduled passenger:', error);
      throw error;
    }
  }
  
  // ========== PASSENGER FIELD MANAGEMENT ==========
  
  async addPassengerToScheduledDriverField(driverId, passengerData, passengerField, matchId, matchScore, options = {}) {
    try {
      const driverDocId = this.getDocumentIdFromPhone(driverId);
      const passengerDocId = this.getDocumentIdFromPhone(passengerData.passengerPhone);
      
      if (!driverDocId || !passengerDocId) {
        throw new Error('Invalid phone numbers');
      }
      
      console.log(`📝 [SCHEDULED] Adding passenger ${passengerDocId} to driver ${driverDocId} in field ${passengerField}`);
      
      // Get current driver data
      const driverDoc = await this.db.collection('scheduled_searches_driver')
        .doc(driverDocId)
        .get();
      
      if (!driverDoc.exists) {
        throw new Error(`Scheduled driver ${driverDocId} not found`);
      }
      
      const driverFirestoreData = driverDoc.data();
      const driverData = driverFirestoreData.data || {};
      const capacity = driverData.capacity || 4;
      
      // Validate passenger field
      const fieldNumber = parseInt(passengerField.replace('passenger', ''));
      if (fieldNumber < 1 || fieldNumber > capacity) {
        throw new Error(`Invalid passenger field: ${passengerField}`);
      }
      
      // Check if field is already occupied
      if (driverData[passengerField] && driverData[passengerField].passengerId) {
        console.log(`⚠️ [SCHEDULED] Passenger field ${passengerField} already occupied`);
        return false;
      }
      
      // Prepare passenger data in SCHEDULED SERVICE FORMAT
      const fieldPassengerData = {
        type: 'SCHEDULE_SEARCH',
        data: {
          // Passenger info
          userId: passengerDocId,
          userType: 'passenger',
          scheduledTime: passengerData.scheduledTime,
          
          // Personal info
          passengerName: passengerData.passengerName,
          passengerPhotoUrl: passengerData.passengerPhotoUrl || '',
          passengerCount: passengerData.passengerCount || 1,
          
          // Location
          pickupLocation: passengerData.pickupLocation,
          pickupName: passengerData.pickupName || "Pickup",
          destinationLocation: passengerData.destinationLocation,
          destinationName: passengerData.destinationName || "Destination",
          
          // Match info
          addedAt: new Date().toISOString(),
          matchId: matchId,
          matchStatus: 'proposed',
          matchScore: matchScore,
          proposalExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          testMode: true
        }
      };
      
      // Calculate new passenger counts
      let currentPassengers = 0;
      const passengerIds = new Set();
      
      for (let i = 1; i <= capacity; i++) {
        const fieldName = `passenger${i}`;
        if (fieldName !== passengerField && driverData[fieldName] && driverData[fieldName].data) {
          const passengerId = driverData[fieldName].data.userId;
          if (!passengerIds.has(passengerId)) {
            passengerIds.add(passengerId);
            currentPassengers += driverData[fieldName].data.passengerCount || 1;
          }
        }
      }
      
      // Add new passenger
      passengerIds.add(passengerDocId);
      const newCurrentPassengers = currentPassengers + (passengerData.passengerCount || 1);
      const newAvailableSeats = Math.max(0, capacity - newCurrentPassengers);
      
      // Prepare update data in SCHEDULED SERVICE FORMAT
      const updateData = {
        type: 'CREATE_SCHEDULED_SEARCH',
        data: {
          ...driverData,
          [passengerField]: fieldPassengerData,
          currentPassengers: newCurrentPassengers,
          availableSeats: newAvailableSeats,
          status: 'matched',
          matchStatus: 'proposed',
          lastUpdated: Date.now(),
          updatedAt: new Date().toISOString()
        }
      };
      
      const forceImmediate = options.immediate || this.isMatchingServiceCall;
      
      if (forceImmediate) {
        this.stats.immediateWrites++;
        this.stats.matchingWrites++;
        
        await driverDoc.ref.update(updateData);
        console.log(`⚡ [SCHEDULED] Added passenger to field ${passengerField}`);
      } else {
        this.queueWrite('scheduled_searches_driver', driverDocId, updateData, 'set');
      }
      
      // Clear cache
      cache.del(`scheduled_driver_${driverDocId}`);
      
      return { 
        success: true, 
        passengerField, 
        driverDocId, 
        passengerDocId,
        currentPassengers: newCurrentPassengers,
        availableSeats: newAvailableSeats 
      };
      
    } catch (error) {
      logger.error('SCHEDULED', 'Error adding passenger to scheduled driver:', error);
      return { success: false, error: error.message };
    }
  }
  
  async removePassengerFromScheduledDriverField(driverId, passengerField, options = {}) {
    try {
      const driverDocId = this.getDocumentIdFromPhone(driverId);
      if (!driverDocId) throw new Error('Invalid driver phone');
      
      console.log(`🗑️ [SCHEDULED] Removing passenger from ${passengerField} for driver ${driverDocId}`);
      
      const driverDoc = await this.db.collection('scheduled_searches_driver')
        .doc(driverDocId)
        .get();
      
      if (!driverDoc.exists) {
        throw new Error(`Scheduled driver ${driverDocId} not found`);
      }
      
      const existingData = driverDoc.data();
      const currentData = existingData.data || {};
      const capacity = currentData.capacity || 4;
      
      // Get passenger ID for updating passenger document
      const passengerData = currentData[passengerField];
      const passengerId = passengerData?.data?.userId;
      
      // Recalculate passenger count after removal
      let totalPassengerCount = 0;
      const passengerIds = new Set();
      
      for (let i = 1; i <= capacity; i++) {
        const fieldName = `passenger${i}`;
        if (fieldName !== passengerField && currentData[fieldName] && currentData[fieldName].data) {
          const pid = currentData[fieldName].data.userId;
          if (!passengerIds.has(pid)) {
            passengerIds.add(pid);
            totalPassengerCount += currentData[fieldName].data.passengerCount || 1;
          }
        }
      }
      
      // Build update in SCHEDULED SERVICE FORMAT
      const updateData = {
        type: 'CREATE_SCHEDULED_SEARCH',
        data: {
          ...currentData,
          [passengerField]: null,
          currentPassengers: totalPassengerCount,
          availableSeats: capacity - totalPassengerCount,
          lastUpdated: Date.now(),
          updatedAt: new Date().toISOString()
        }
      };
      
      // Update driver status if no passengers left
      if (totalPassengerCount === 0) {
        updateData.data.matchStatus = null;
        updateData.data.status = 'scheduled';
      }
      
      const forceImmediate = options.immediate || this.isMatchingServiceCall;
      
      if (forceImmediate) {
        this.stats.immediateWrites++;
        this.stats.matchingWrites++;
        
        await driverDoc.ref.update(updateData);
        console.log(`⚡ [SCHEDULED] Removed passenger from ${passengerField}`);
      } else {
        this.queueWrite('scheduled_searches_driver', driverDocId, updateData, 'set');
      }
      
      // Update passenger document if found
      if (passengerId) {
        await this.updateScheduledPassengerStatus(passengerId, {
          matchId: null,
          matchedWith: null,
          matchStatus: null,
          driver: null,
          status: 'scheduled'
        }, { immediate: true });
      }
      
      cache.del(`scheduled_driver_${driverDocId}`);
      if (passengerId) {
        cache.del(`scheduled_passenger_${passengerId}`);
      }
      
      return true;
      
    } catch (error) {
      logger.error('SCHEDULED', 'Error removing passenger from scheduled driver:', error);
      return false;
    }
  }
  
  getPassengerFields(driverData) {
    const capacity = driverData.capacity || 4;
    const passengers = [];
    
    for (let i = 1; i <= capacity; i++) {
      const fieldName = `passenger${i}`;
      if (driverData[fieldName] && driverData[fieldName].data) {
        passengers.push({
          field: fieldName,
          ...driverData[fieldName]
        });
      }
    }
    
    return passengers;
  }
  
  calculateCurrentPassengers(driverData) {
    const capacity = driverData.capacity || 4;
    const passengerIds = new Set();
    let totalPassengerCount = 0;
    
    for (let i = 1; i <= capacity; i++) {
      const fieldName = `passenger${i}`;
      if (driverData[fieldName] && driverData[fieldName].data) {
        const passengerId = driverData[fieldName].data.userId;
        if (!passengerIds.has(passengerId)) {
          passengerIds.add(passengerId);
          totalPassengerCount += driverData[fieldName].data.passengerCount || 1;
        }
      }
    }
    
    return {
      currentPassengers: totalPassengerCount,
      availableSeats: capacity - totalPassengerCount,
      uniquePassengerCount: passengerIds.size
    };
  }
  
  findNextAvailableField(driverData) {
    const capacity = driverData.capacity || 4;
    
    for (let i = 1; i <= capacity; i++) {
      const fieldName = `passenger${i}`;
      if (!driverData[fieldName] || !driverData[fieldName].data) {
        return fieldName;
      }
    }
    
    return null;
  }
  
  // ========== GETTER METHODS FOR SCHEDULED DATA ==========
  
  async getScheduledDriver(phoneNumber) {
    try {
      const driverDocId = this.getDocumentIdFromPhone(phoneNumber);
      if (!driverDocId) return null;
      
      const cacheKey = `scheduled_driver_${driverDocId}`;
      const cached = cache.get(cacheKey);
      
      if (cached) {
        this.stats.cacheHits++;
        return cached;
      }
      
      console.log('🔍 [SCHEDULED] Getting scheduled driver:', driverDocId);
      
      const doc = await this.db.collection('scheduled_searches_driver')
        .doc(driverDocId)
        .get();
      
      this.stats.reads++;
      
      if (!doc.exists) {
        cache.set(cacheKey, null, 30000);
        return null;
      }
      
      const firestoreData = doc.data();
      const normalized = this.normalizeScheduledDriverData(firestoreData);
      
      const result = {
        id: doc.id,
        ...firestoreData,
        normalized
      };
      
      cache.set(cacheKey, result, 30000);
      return result;
      
    } catch (error) {
      logger.error('SCHEDULED', 'Error getting scheduled driver:', error);
      return null;
    }
  }
  
  async getScheduledPassenger(phoneNumber) {
    try {
      const passengerDocId = this.getDocumentIdFromPhone(phoneNumber);
      if (!passengerDocId) return null;
      
      const cacheKey = `scheduled_passenger_${passengerDocId}`;
      const cached = cache.get(cacheKey);
      
      if (cached) {
        this.stats.cacheHits++;
        return cached;
      }
      
      console.log('🔍 [SCHEDULED] Getting scheduled passenger:', passengerDocId);
      
      const doc = await this.db.collection('scheduled_searches_passenger')
        .doc(passengerDocId)
        .get();
      
      this.stats.reads++;
      
      if (!doc.exists) {
        cache.set(cacheKey, null, 30000);
        return null;
      }
      
      const firestoreData = doc.data();
      const normalized = this.normalizeScheduledPassengerData(firestoreData);
      
      const result = {
        id: doc.id,
        ...firestoreData,
        normalized
      };
      
      cache.set(cacheKey, result, 30000);
      return result;
      
    } catch (error) {
      logger.error('SCHEDULED', 'Error getting scheduled passenger:', error);
      return null;
    }
  }
  
  async getAllScheduledDrivers() {
    try {
      const cacheKey = 'all_scheduled_drivers';
      const cached = cache.get(cacheKey);
      
      if (cached) {
        this.stats.cacheHits++;
        return cached;
      }
      
      console.log('🔍 [SCHEDULED] Getting all scheduled drivers');
      
      const snapshot = await this.db.collection('scheduled_searches_driver')
        .where('data.status', 'in', ['scheduled', 'matched', 'partially_accepted', 'active'])
        .limit(50)
        .get();
      
      const drivers = [];
      snapshot.forEach(doc => {
        const firestoreData = doc.data();
        const driverData = firestoreData.data || {};
        drivers.push({
          id: doc.id,
          ...firestoreData,
          normalized: this.normalizeScheduledDriverData(firestoreData)
        });
      });
      
      console.log(`✅ [SCHEDULED] Found ${drivers.length} scheduled drivers`);
      
      cache.set(cacheKey, drivers, 30000);
      return drivers;
      
    } catch (error) {
      logger.error('SCHEDULED', 'Error in getAllScheduledDrivers:', error);
      return [];
    }
  }
  
  async getAllScheduledPassengers() {
    try {
      const cacheKey = 'all_scheduled_passengers';
      const cached = cache.get(cacheKey);
      
      if (cached) {
        this.stats.cacheHits++;
        return cached;
      }
      
      console.log('🔍 [SCHEDULED] Getting all scheduled passengers');
      
      const snapshot = await this.db.collection('scheduled_searches_passenger')
        .where('data.status', 'in', ['scheduled', 'matched', 'active'])
        .limit(100)
        .get();
      
      const passengers = [];
      snapshot.forEach(doc => {
        const firestoreData = doc.data();
        const passengerData = firestoreData.data || {};
        passengers.push({
          id: doc.id,
          ...firestoreData,
          normalized: this.normalizeScheduledPassengerData(firestoreData)
        });
      });
      
      console.log(`✅ [SCHEDULED] Found ${passengers.length} scheduled passengers`);
      
      cache.set(cacheKey, passengers, 30000);
      return passengers;
      
    } catch (error) {
      logger.error('SCHEDULED', 'Error in getAllScheduledPassengers:', error);
      return [];
    }
  }
  
  // ========== UPDATE STATUS METHODS ==========
  
  async updateScheduledPassengerStatus(passengerPhone, updates, options = {}) {
    try {
      const passengerDocId = this.getDocumentIdFromPhone(passengerPhone);
      if (!passengerDocId) throw new Error('Invalid passenger phone');
      
      console.log(`📝 [SCHEDULED] Updating passenger status: ${passengerDocId}`);
      
      cache.del(`scheduled_passenger_${passengerDocId}`);
      cache.del('scheduled_searches_all');
      
      const docRef = this.db.collection('scheduled_searches_passenger')
        .doc(passengerDocId);
      
      const doc = await docRef.get();
      
      if (!doc.exists) {
        throw new Error(`Scheduled passenger ${passengerDocId} not found`);
      }
      
      const existingData = doc.data();
      const currentData = existingData.data || {};
      
      // Build update in SCHEDULED SERVICE FORMAT
      const updateData = {
        type: 'SCHEDULE_SEARCH',
        data: {
          ...currentData,
          ...updates,
          updatedAt: new Date().toISOString(),
          lastUpdated: Date.now()
        }
      };
      
      const forceImmediate = options.immediate || this.isMatchingServiceCall;
      
      if (forceImmediate) {
        this.stats.immediateWrites++;
        this.stats.matchingWrites++;
        
        await docRef.update(updateData);
        console.log(`⚡ [SCHEDULED] Passenger status updated IMMEDIATELY: ${passengerDocId}`);
      } else {
        this.queueWrite('scheduled_searches_passenger', passengerDocId, updateData, 'set');
      }
      
      return true;
      
    } catch (error) {
      logger.error('SCHEDULED', 'Error updating scheduled passenger:', error.message);
      throw error;
    }
  }
  
  async updateScheduledDriverStatus(driverPhone, updates, options = {}) {
    try {
      const driverDocId = this.getDocumentIdFromPhone(driverPhone);
      if (!driverDocId) throw new Error('Invalid driver phone');
      
      console.log(`📝 [SCHEDULED] Updating driver status: ${driverDocId}`);
      
      cache.del(`scheduled_driver_${driverDocId}`);
      cache.del('scheduled_searches_all');
      
      const docRef = this.db.collection('scheduled_searches_driver')
        .doc(driverDocId);
      
      const doc = await docRef.get();
      
      if (!doc.exists) {
        throw new Error(`Scheduled driver ${driverDocId} not found`);
      }
      
      const existingData = doc.data();
      const currentData = existingData.data || {};
      
      // Build update in SCHEDULED SERVICE FORMAT
      const updateData = {
        type: 'CREATE_SCHEDULED_SEARCH',
        data: {
          ...currentData,
          ...updates,
          updatedAt: new Date().toISOString(),
          lastUpdated: Date.now()
        }
      };
      
      const forceImmediate = options.immediate || this.isMatchingServiceCall;
      
      if (forceImmediate) {
        this.stats.immediateWrites++;
        this.stats.matchingWrites++;
        
        await docRef.update(updateData);
        console.log(`⚡ [SCHEDULED] Driver status updated IMMEDIATELY: ${driverDocId}`);
      } else {
        this.queueWrite('scheduled_searches_driver', driverDocId, updateData, 'set');
      }
      
      return true;
      
    } catch (error) {
      logger.error('SCHEDULED', 'Error updating scheduled driver:', error.message);
      throw error;
    }
  }
  
  async updateScheduledMatch(matchId, matchData, options = {}) {
    try {
      console.log(`📝 [SCHEDULED] Updating match ${matchId}`);
      
      const forceImmediate = options.immediate || this.isMatchingServiceCall;
      
      if (forceImmediate) {
        this.stats.immediateWrites++;
        this.stats.matchingWrites++;
        
        await this.db.collection('scheduled_matches')
          .doc(matchId)
          .set(matchData, { merge: true });
        
        console.log(`⚡ [SCHEDULED] Match updated IMMEDIATELY: ${matchId}`);
      } else {
        this.queueWrite('scheduled_matches', matchId, matchData, 'set');
      }
      
      return { success: true, matchId };
      
    } catch (error) {
      logger.error('SCHEDULED', 'Error updating match:', error);
      return { success: false, error: error.message };
    }
  }
  
  // ========== ORIGINAL ACTIVE SEARCH METHODS ==========
  
  async saveDriverSearch(driverData, options = {}) {
    try {
      const driverPhone = driverData.driverPhone || driverData.phone;
      if (!driverPhone) throw new Error('Driver phone required');
      
      const driverDocId = this.getDocumentIdFromPhone(driverPhone);
      if (!driverDocId) throw new Error('Invalid phone format');
      
      console.log('💾 Saving driver search:', driverDocId);
      
      const driverId = driverData.driverId || driverDocId;
      const capacity = driverData.capacity || 4;
      
      // Initialize empty passenger fields
      const passengerFields = {};
      for (let i = 1; i <= capacity; i++) {
        passengerFields[`passenger${i}`] = null;
      }
      
      const searchData = {
        driverPhone: driverDocId,
        driverId: driverId,
        userType: 'driver',
        driverName: driverData.driverName || 'Unknown Driver',
        driverPhotoUrl: driverData.driverPhotoUrl || '',
        driverRating: driverData.driverRating || 5.0,
        totalRides: driverData.totalRides || 0,
        isVerified: driverData.isVerified || false,
        totalEarnings: driverData.totalEarnings || 0.0,
        completedRides: driverData.completedRides || 0,
        isOnline: driverData.isOnline !== undefined ? driverData.isOnline : true,
        isSearching: driverData.isSearching !== undefined ? driverData.isSearching : true,
        vehicleInfo: driverData.vehicleInfo || {
          model: 'Car Model',
          plate: 'ABC123',
          color: 'Unknown',
          type: 'car',
          passengerCapacity: capacity
        },
        pickupLocation: driverData.pickupLocation,
        destinationLocation: driverData.destinationLocation,
        pickupName: driverData.pickupName || 'Unknown Pickup',
        destinationName: driverData.destinationName || 'Unknown Destination',
        routePoints: driverData.routePoints || [],
        capacity: capacity,
        ...passengerFields,
        currentPassengers: 0,
        availableSeats: capacity,
        matchId: null,
        matchedWith: null,
        matchStatus: null,
        status: 'searching',
        createdAt: new Date(),
        updatedAt: new Date(),
        lastUpdated: Date.now()
      };
      
      const forceImmediate = options.immediate || this.isMatchingServiceCall;
      
      if (forceImmediate) {
        this.stats.immediateWrites++;
        this.stats.matchingWrites++;
        
        await this.db.collection(COLLECTIONS.ACTIVE_SEARCHES_DRIVER)
          .doc(driverDocId)
          .set(searchData);
        
        console.log(`⚡ Driver saved IMMEDIATELY: ${driverDocId} with ${capacity} passenger fields`);
      } else {
        this.queueWrite(COLLECTIONS.ACTIVE_SEARCHES_DRIVER, driverDocId, searchData, 'set');
        console.log(`✅ Driver queued: ${driverDocId}`);
      }
      
      // Clear caches
      cache.del(`driver_${driverDocId}`);
      cache.del('active_searches_all');
      cache.del('active_drivers');
      
      return { ...searchData, documentId: driverDocId };
      
    } catch (error) {
      logger.error('FIRESTORE', 'Error saving driver:', error);
      throw error;
    }
  }
  
  async savePassengerSearch(passengerData, options = {}) {
    try {
      const passengerPhone = passengerData.passengerPhone || passengerData.phone;
      if (!passengerPhone) throw new Error('Passenger phone required');
      
      const passengerDocId = this.getDocumentIdFromPhone(passengerPhone);
      if (!passengerDocId) throw new Error('Invalid phone format');
      
      console.log('💾 Saving passenger search:', passengerDocId);
      
      const passengerId = passengerData.passengerId || passengerDocId;
      const searchData = {
        passengerPhone: passengerDocId,
        passengerId: passengerId,
        userType: 'passenger',
        passengerName: passengerData.passengerName || 'Unknown Passenger',
        passengerPhotoUrl: passengerData.passengerPhotoUrl || '',
        passengerRating: passengerData.passengerRating || 5.0,
        pickupLocation: passengerData.pickupLocation,
        destinationLocation: passengerData.destinationLocation,
        pickupName: passengerData.pickupName || 'Unknown Pickup',
        destinationName: passengerData.destinationName || 'Unknown Destination',
        routePoints: passengerData.routePoints || [],
        passengerCount: passengerData.passengerCount || 1,
        matchId: null,
        matchedWith: null,
        matchStatus: null,
        matchField: null,
        status: 'searching',
        currentLocation: passengerData.currentLocation || passengerData.pickupLocation,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastUpdated: Date.now()
      };
      
      const forceImmediate = options.immediate || this.isMatchingServiceCall;
      
      if (forceImmediate) {
        this.stats.immediateWrites++;
        this.stats.matchingWrites++;
        
        await this.db.collection(COLLECTIONS.ACTIVE_SEARCHES_PASSENGER)
          .doc(passengerDocId)
          .set(searchData);
        
        console.log(`⚡ Passenger saved IMMEDIATELY: ${passengerDocId}`);
      } else {
        this.queueWrite(COLLECTIONS.ACTIVE_SEARCHES_PASSENGER, passengerDocId, searchData, 'set');
        console.log(`✅ Passenger queued: ${passengerDocId}`);
      }
      
      // Clear caches
      cache.del(`passenger_${passengerDocId}`);
      cache.del('active_searches_all');
      cache.del('active_passengers');
      
      return { ...searchData, documentId: passengerDocId };
      
    } catch (error) {
      logger.error('FIRESTORE', 'Error saving passenger:', error);
      throw error;
    }
  }
  
  async getDriverSearch(phoneNumber) {
    try {
      const driverDocId = this.getDocumentIdFromPhone(phoneNumber);
      if (!driverDocId) return null;
      
      return this.getWithCache(
        COLLECTIONS.ACTIVE_SEARCHES_DRIVER,
        driverDocId,
        `driver_${driverDocId}`,
        30000
      );
    } catch (error) {
      logger.error('FIRESTORE', 'Error getting driver:', error);
      return null;
    }
  }
  
  async getPassengerSearch(phoneNumber) {
    try {
      const passengerDocId = this.getDocumentIdFromPhone(phoneNumber);
      if (!passengerDocId) return null;
      
      return this.getWithCache(
        COLLECTIONS.ACTIVE_SEARCHES_PASSENGER,
        passengerDocId,
        `passenger_${passengerDocId}`,
        30000
      );
    } catch (error) {
      logger.error('FIRESTORE', 'Error getting passenger:', error);
      return null;
    }
  }
  
  async updateDriverSearch(phoneNumber, updates, options = {}) {
    try {
      const driverDocId = this.getDocumentIdFromPhone(phoneNumber);
      if (!driverDocId) throw new Error('Invalid phone for update');
      
      cache.del(`driver_${driverDocId}`);
      cache.del('active_searches_all');
      cache.del('active_drivers');
      
      const docRef = this.db.collection(COLLECTIONS.ACTIVE_SEARCHES_DRIVER).doc(driverDocId);
      const doc = await docRef.get();
      
      if (!doc.exists) {
        throw new Error(`Driver ${driverDocId} not found`);
      }
      
      const updateData = { ...updates, updatedAt: new Date() };
      
      if (options.immediate) {
        this.stats.immediateWrites++;
        await docRef.update(updateData);
      } else {
        this.queueWrite(COLLECTIONS.ACTIVE_SEARCHES_DRIVER, driverDocId, updateData, 'update');
      }
      
      return true;
      
    } catch (error) {
      logger.error('FIRESTORE', 'Error updating driver:', error.message);
      throw error;
    }
  }
  
  async updatePassengerSearch(phoneNumber, updates, options = {}) {
    try {
      const passengerDocId = this.getDocumentIdFromPhone(phoneNumber);
      if (!passengerDocId) throw new Error('Invalid phone for update');
      
      cache.del(`passenger_${passengerDocId}`);
      cache.del('active_searches_all');
      cache.del('active_passengers');
      
      const docRef = this.db.collection(COLLECTIONS.ACTIVE_SEARCHES_PASSENGER).doc(passengerDocId);
      const doc = await docRef.get();
      
      if (!doc.exists) {
        throw new Error(`Passenger ${passengerDocId} not found`);
      }
      
      const updateData = { ...updates, updatedAt: new Date() };
      
      if (options.immediate) {
        this.stats.immediateWrites++;
        await docRef.update(updateData);
      } else {
        this.queueWrite(COLLECTIONS.ACTIVE_SEARCHES_PASSENGER, passengerDocId, updateData, 'update');
      }
      
      return true;
      
    } catch (error) {
      logger.error('FIRESTORE', 'Error updating passenger:', error.message);
      throw error;
    }
  }
  
  async getWithCache(collection, docId, cacheKey = null, ttl = TIMEOUTS.CACHE_TTL) {
    const key = cacheKey || `${collection}_${docId}`;
    const cached = cache.get(key);
    if (cached) {
      this.stats.cacheHits++;
      return cached;
    }
    
    const doc = await this.db.collection(collection).doc(docId).get();
    this.stats.reads++;
    
    if (!doc.exists) {
      cache.set(key, null, ttl);
      return null;
    }
    
    const data = { id: doc.id, ...doc.data() };
    cache.set(key, data, ttl);
    
    return data;
  }
  
  // ========== BATCH WRITING SYSTEM ==========
  
  queueWrite(collection, docId, data, operation = 'set', retryCount = 0) {
    const writeItem = {
      collection,
      docId,
      data,
      operation,
      timestamp: Date.now(),
      priority: operation === 'update' ? 1 : 0,
      retryCount: retryCount,
      lastRetry: 0
    };
    
    this.writeQueue.push(writeItem);
    
    this.writeQueue.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (a.retryCount !== b.retryCount) return a.retryCount - b.retryCount;
      return a.timestamp - b.timestamp;
    });
    
    // Update stats
    this.stats.queueSize = this.writeQueue.length;
    
    // Trigger flush if queue is getting large
    if (this.writeQueue.length >= Math.min(this.batchLimit, 100)) {
      setImmediate(() => this.safeFlushWrites());
    }
    
    this.stats.writes++;
    return true;
  }
  
  async safeFlushWrites() {
    if (this.isProcessing || this.writeQueue.length === 0) return;
    
    this.isProcessing = true;
    this.stats.isProcessing = true;
    
    try {
      await this.flushWrites();
    } catch (error) {
      logger.error('FIRESTORE', 'Error in safeFlushWrites:', error);
    } finally {
      this.isProcessing = false;
      this.stats.isProcessing = false;
      this.stats.queueSize = this.writeQueue.length;
    }
  }
  
  async flushWrites() {
    if (this.writeQueue.length === 0) return;
    
    let toProcess = [];
    
    try {
      const batch = this.db.batch();
      const operations = [];
      
      // Process in smaller batches to avoid timeouts
      const batchSize = Math.min(this.batchLimit, 200);
      toProcess = this.writeQueue.splice(0, batchSize);
      
      console.log(`🔄 Flushing ${toProcess.length} write operations (queue: ${this.writeQueue.length} remaining)`);
      
      for (const op of toProcess) {
        try {
          const docRef = this.db.collection(op.collection).doc(op.docId);
          
          if (op.operation === 'set') {
            batch.set(docRef, op.data, { merge: true });
          } else if (op.operation === 'update') {
            batch.update(docRef, op.data);
          } else if (op.operation === 'delete') {
            batch.delete(docRef);
          }
          
          operations.push(op);
          
          // Clear cache for this document
          const cacheKey = `${op.collection}:${op.docId}`;
          this.cache.delete(cacheKey);
          cache.del(`${op.collection}_${op.docId}`);
          
        } catch (opError) {
          logger.error('FIRESTORE', `Error processing operation for ${op.collection}/${op.docId}:`, opError.message);
          // Keep the operation in queue for retry
          this.writeQueue.unshift(op);
        }
      }
      
      // Only commit if there are operations
      if (operations.length > 0) {
        const commitPromise = batch.commit();
        
        // Add timeout to batch commit
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Batch commit timeout')), 10000);
        });
        
        await Promise.race([commitPromise, timeoutPromise]);
        this.stats.batchWrites += operations.length;
        console.log(`✅ Successfully committed ${operations.length} write operations`);
      }
      
    } catch (error) {
      logger.error('FIRESTORE', 'Batch write failed:', error.message);
      this.stats.queueFlushErrors++;
      
      // Requeue failed operations
      if (toProcess.length > 0) {
        // Filter out operations that had individual errors
        const failedOps = toProcess.filter(op => {
          return !this.writeQueue.some(q => 
            q.collection === op.collection && 
            q.docId === op.docId && 
            q.timestamp === op.timestamp
          );
        });
        
        if (failedOps.length > 0) {
          // Add exponential backoff delay
          const now = Date.now();
          for (const op of failedOps) {
            op.retryCount = (op.retryCount || 0) + 1;
            op.lastRetry = now;
            
            if (op.retryCount < 5) {
              this.stats.retriedOperations++;
              // Add delay based on retry count (exponential backoff)
              const delay = Math.min(60000, 1000 * Math.pow(2, op.retryCount));
              setTimeout(() => {
                this.writeQueue.unshift(op);
                this.stats.queueSize = this.writeQueue.length;
              }, delay);
            } else {
              logger.error('FIRESTORE', `Max retries exceeded for ${op.collection}/${op.docId}`);
            }
          }
        }
      }
      
      // Wait before retrying
      setTimeout(() => this.safeFlushWrites(), 5000);
    }
    
    this.stats.queueSize = this.writeQueue.length;
  }
  
  // ========== CACHE MANAGEMENT ==========

  clearCache() {
    this.cache.clear();
    cache.clear(); // Clear the external cache too
    this.stats.cacheStats.size = 0;
    console.log('🧹 [FIRESTORE] All caches cleared');
  }

  clearMemoryCache() {
    this.cache.clear();
    this.stats.cacheStats.size = 0;
    console.log('🧹 [FIRESTORE] Memory cache cleared');
  }
  
  // ========== STATS AND MONITORING ==========
  
  startBatchProcessor() {
    // Regular batch processor
    this.processorInterval = setInterval(() => {
      if (!this.isProcessing && this.writeQueue.length > 0) {
        this.safeFlushWrites();
      }
    }, 3000);
    
    // Queue monitoring
    setInterval(() => {
      if (this.writeQueue.length > 100) {
        console.warn(`⚠️ Write queue is large: ${this.writeQueue.length} items`);
        
        // Check for stale items
        const now = Date.now();
        const staleItems = this.writeQueue.filter(item => 
          now - item.timestamp > 300000 // 5 minutes
        );
        
        if (staleItems.length > 0) {
          console.warn(`⚠️ Found ${staleItems.length} stale items in queue, clearing...`);
          this.writeQueue = this.writeQueue.filter(item => 
            now - item.timestamp <= 300000
          );
          this.stats.queueSize = this.writeQueue.length;
        }
      }
    }, 60000);
    
    // Memory cache cleanup
    setInterval(() => {
      const now = Date.now();
      let clearedCount = 0;
      
      for (const [key, value] of this.cache.entries()) {
        if (now - value.timestamp > this.CACHE_TTL) {
          this.cache.delete(key);
          clearedCount++;
        }
      }
      
      if (clearedCount > 0) {
        console.log(`🧹 [FIRESTORE] Cleaned ${clearedCount} expired cache entries`);
        this.stats.cacheStats.size = this.cache.size;
      }
    }, 30000);
    
    // Stats logging
    setInterval(() => {
      console.log('📊 Firestore Service Stats:', JSON.stringify(this.getStats(), null, 2));
    }, 60000);
    
    console.log('✅ Firestore Service started with scheduled service support');
    return this;
  }
  
  getStats() {
    return {
      ...this.stats,
      queueSize: this.writeQueue.length,
      isProcessing: this.isProcessing,
      cacheStats: {
        ...this.stats.cacheStats,
        size: this.cache.size
      }
    };
  }
  
  resetStats() {
    this.stats = {
      reads: 0,
      writes: 0,
      cacheHits: 0,
      batchWrites: 0,
      immediateWrites: 0,
      listenersActive: 0,
      locationUpdates: 0,
      matchingWrites: 0,
      queueFlushErrors: 0,
      retriedOperations: 0,
      queueSize: this.writeQueue.length,
      isProcessing: this.isProcessing,
      cacheStats: {
        size: this.cache.size,
        ttlCount: 0
      }
    };
  }
  
  // ========== CLEANUP METHODS ==========
  
  cleanup() {
    if (this.processorInterval) {
      clearInterval(this.processorInterval);
      this.processorInterval = null;
    }
    
    // Clear all queues and caches
    this.writeQueue = [];
    this.cache.clear();
    this.isProcessing = false;
    
    console.log('🧹 Firestore Service cleaned up');
  }
  
  emergencyClearQueue() {
    const queueSize = this.writeQueue.length;
    this.writeQueue = [];
    this.stats.queueSize = 0;
    console.log(`🚨 Emergency queue clear: ${queueSize} operations removed`);
    return queueSize;
  }
}

module.exports = FirestoreService;
