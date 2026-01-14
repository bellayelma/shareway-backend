const { COLLECTIONS, TIMEOUTS, BATCH_WRITE_LIMIT } = require('../config/constants');
const cache = require('../utils/cache');
const helpers = require('../utils/helpers');

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
      retriedOperations: 0
    };
    
    // Start background processors
    this.startBatchProcessor();
  }
  
  // ========== HELPER: NORMALIZE PHONE NUMBER ==========
  normalizePhoneNumber(phone) {
    if (!phone) return null;
    if (phone.startsWith('+')) return phone;
    let normalized = phone.replace(/\D/g, '');
    if (normalized.startsWith('0')) normalized = normalized.substring(1);
    return `+${normalized}`;
  }
  
  getDocumentIdFromPhone(phoneNumber) {
    return this.normalizePhoneNumber(phoneNumber);
  }
  
  // ========== MULTI-PASSENGER FIELD HELPERS ==========
  
  // Get all passenger fields from driver data
  getPassengerFields(driverData) {
    const capacity = driverData.capacity || 4;
    const passengers = [];
    
    for (let i = 1; i <= capacity; i++) {
      const fieldName = `passenger${i}`;
      if (driverData[fieldName] && driverData[fieldName].passengerId) {
        passengers.push({
          field: fieldName,
          ...driverData[fieldName]
        });
      }
    }
    
    return passengers;
  }
  
  // Calculate current passengers from passenger fields
  calculateCurrentPassengers(driverData) {
    const capacity = driverData.capacity || 4;
    const passengerIds = new Set();
    let totalPassengerCount = 0;
    
    for (let i = 1; i <= capacity; i++) {
      const fieldName = `passenger${i}`;
      if (driverData[fieldName] && driverData[fieldName].passengerId) {
        const passengerId = driverData[fieldName].passengerId;
        if (!passengerIds.has(passengerId)) {
          passengerIds.add(passengerId);
          totalPassengerCount += driverData[fieldName].passengerCount || 1;
        }
      }
    }
    
    return {
      currentPassengers: totalPassengerCount,
      availableSeats: capacity - totalPassengerCount,
      uniquePassengerCount: passengerIds.size
    };
  }
  
  // Find next available passenger field
  findNextAvailableField(driverData) {
    const capacity = driverData.capacity || 4;
    
    for (let i = 1; i <= capacity; i++) {
      const fieldName = `passenger${i}`;
      if (!driverData[fieldName] || !driverData[fieldName].passengerId) {
        return fieldName;
      }
    }
    
    return null;
  }
  
  // ========== UPDATED DRIVER SEARCH SAVE ==========
  
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
        ...passengerFields, // Add empty passenger fields
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
      console.error('❌ Error saving driver:', error);
      throw error;
    }
  }
  
  // ========== UPDATED PASSENGER SEARCH SAVE ==========
  
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
        matchField: null, // NEW: Track which passenger field in driver
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
      console.error('❌ Error saving passenger:', error);
      throw error;
    }
  }
  
  // ========== UPDATED: ADD PASSENGER TO DRIVER FIELD ==========
  
  async addPassengerToDriverField(driverId, passengerData, passengerField, options = {}) {
    try {
      const driverDocId = this.getDocumentIdFromPhone(driverId);
      if (!driverDocId) throw new Error('Invalid driver phone');
      
      const passengerDocId = this.getDocumentIdFromPhone(passengerData.passengerPhone);
      if (!passengerDocId) throw new Error('Invalid passenger phone');
      
      console.log(`📝 Adding passenger ${passengerDocId} to driver ${driverDocId} in field ${passengerField}`);
      
      // Get current driver data
      const driverDoc = await this.db.collection(COLLECTIONS.ACTIVE_SEARCHES_DRIVER)
        .doc(driverDocId)
        .get();
      
      if (!driverDoc.exists) {
        throw new Error(`Driver ${driverDocId} not found`);
      }
      
      const driverData = driverDoc.data();
      const capacity = driverData.capacity || 4;
      
      // Validate passenger field
      const fieldNumber = parseInt(passengerField.replace('passenger', ''));
      if (fieldNumber < 1 || fieldNumber > capacity) {
        throw new Error(`Invalid passenger field: ${passengerField}`);
      }
      
      // Check if field is already occupied
      if (driverData[passengerField] && driverData[passengerField].passengerId) {
        console.log(`⚠️ Passenger field ${passengerField} already occupied`);
        return false;
      }
      
      // Prepare passenger data for the field
      const fieldPassengerData = {
        passengerId: passengerDocId,
        passengerName: passengerData.passengerName || 'Passenger',
        passengerPhone: passengerDocId,
        passengerPhotoUrl: passengerData.passengerPhotoUrl || '',
        passengerCount: passengerData.passengerCount || 1,
        pickupLocation: passengerData.pickupLocation,
        pickupName: passengerData.pickupName,
        destinationLocation: passengerData.destinationLocation,
        destinationName: passengerData.destinationName,
        estimatedFare: passengerData.estimatedFare || 0,
        routePoints: passengerData.routePoints || [],
        matchId: passengerData.matchId,
        matchStatus: 'proposed',
        addedAt: new Date().toISOString(),
        fieldName: passengerField
      };
      
      // Calculate new passenger counts
      const { currentPassengers, availableSeats } = this.calculateCurrentPassengers(driverData);
      const newCurrentPassengers = currentPassengers + (passengerData.passengerCount || 1);
      const newAvailableSeats = Math.max(0, capacity - newCurrentPassengers);
      
      const updateData = {
        [passengerField]: fieldPassengerData,
        currentPassengers: newCurrentPassengers,
        availableSeats: newAvailableSeats,
        status: 'matched',
        matchStatus: 'proposed',
        lastUpdated: Date.now(),
        updatedAt: new Date()
      };
      
      const forceImmediate = options.immediate || this.isMatchingServiceCall;
      
      if (forceImmediate) {
        this.stats.immediateWrites++;
        this.stats.matchingWrites++;
        
        await driverDoc.ref.update(updateData);
        console.log(`⚡ Added passenger to field ${passengerField} for driver ${driverDocId}`);
      } else {
        this.queueWrite(COLLECTIONS.ACTIVE_SEARCHES_DRIVER, driverDocId, updateData, 'update');
      }
      
      // Clear cache
      cache.del(`driver_${driverDocId}`);
      
      // Start tracking for this passenger
      setTimeout(async () => {
        try {
          await this.startPassengerTracking(passengerDocId, driverDocId, passengerField);
        } catch (error) {
          console.error(`⚠️ Could not start tracking:`, error.message);
        }
      }, 500);
      
      return { success: true, passengerField, driverDocId, passengerDocId };
      
    } catch (error) {
      console.error(`❌ Error adding passenger to driver field:`, error);
      return { success: false, error: error.message };
    }
  }
  
  // ========== UPDATED: UPDATE PASSENGER FIELD STATUS ==========
  
  async updatePassengerFieldStatus(driverId, passengerField, newStatus, passengerId = null, options = {}) {
    try {
      const driverDocId = this.getDocumentIdFromPhone(driverId);
      if (!driverDocId) throw new Error('Invalid driver phone');
      
      console.log(`🔄 Updating ${passengerField} status to ${newStatus} for driver ${driverDocId}`);
      
      const driverDoc = await this.db.collection(COLLECTIONS.ACTIVE_SEARCHES_DRIVER)
        .doc(driverDocId)
        .get();
      
      if (!driverDoc.exists) {
        throw new Error(`Driver ${driverDocId} not found`);
      }
      
      const driverData = driverDoc.data();
      const passengerData = driverData[passengerField];
      
      if (!passengerData || !passengerData.passengerId) {
        console.log(`⚠️ No passenger in field ${passengerField}`);
        return false;
      }
      
      // If passengerId is provided, verify it matches
      if (passengerId && passengerData.passengerId !== passengerId) {
        console.log(`⚠️ Passenger ID mismatch: ${passengerData.passengerId} != ${passengerId}`);
        return false;
      }
      
      // Update passenger field status
      const updatedPassengerData = {
        ...passengerData,
        matchStatus: newStatus
      };
      
      if (newStatus === 'accepted') {
        updatedPassengerData.acceptedAt = new Date().toISOString();
        updatedPassengerData.matchAcceptedAt = new Date().toISOString();
      } else if (newStatus === 'declined') {
        updatedPassengerData.declinedAt = new Date().toISOString();
      }
      
      const updateData = {
        [passengerField]: updatedPassengerData,
        lastUpdated: Date.now(),
        updatedAt: new Date()
      };
      
      // Update driver's match status if needed
      const passengerFields = this.getPassengerFields(driverData);
      const acceptedCount = passengerFields.filter(p => p.matchStatus === 'accepted').length;
      const totalPassengers = passengerFields.length;
      
      if (acceptedCount === totalPassengers) {
        updateData.matchStatus = 'accepted';
        updateData.status = 'accepted';
      } else if (acceptedCount > 0) {
        updateData.matchStatus = 'partially_accepted';
        updateData.status = 'matched';
      }
      
      const forceImmediate = options.immediate || this.isMatchingServiceCall;
      
      if (forceImmediate) {
        this.stats.immediateWrites++;
        this.stats.matchingWrites++;
        
        await driverDoc.ref.update(updateData);
        console.log(`⚡ Updated ${passengerField} status to ${newStatus}`);
      } else {
        this.queueWrite(COLLECTIONS.ACTIVE_SEARCHES_DRIVER, driverDocId, updateData, 'update');
      }
      
      // Also update passenger document
      await this.updatePassengerSearch(passengerData.passengerId, {
        matchStatus: newStatus,
        matchField: passengerField
      }, { immediate: true });
      
      cache.del(`driver_${driverDocId}`);
      cache.del(`passenger_${passengerData.passengerId}`);
      
      return true;
      
    } catch (error) {
      console.error(`❌ Error updating passenger field status:`, error);
      return false;
    }
  }
  
  // ========== UPDATED: REMOVE PASSENGER FROM FIELD ==========
  
  async removePassengerFromField(driverId, passengerField, options = {}) {
    try {
      const driverDocId = this.getDocumentIdFromPhone(driverId);
      if (!driverDocId) throw new Error('Invalid driver phone');
      
      console.log(`🗑️ Removing passenger from ${passengerField} for driver ${driverDocId}`);
      
      const driverDoc = await this.db.collection(COLLECTIONS.ACTIVE_SEARCHES_DRIVER)
        .doc(driverDocId)
        .get();
      
      if (!driverDoc.exists) {
        throw new Error(`Driver ${driverDocId} not found`);
      }
      
      const driverData = driverDoc.data();
      const passengerData = driverData[passengerField];
      const capacity = driverData.capacity || 4;
      
      if (!passengerData) {
        console.log(`⚠️ No passenger in field ${passengerField}`);
        return false;
      }
      
      // Recalculate passenger count after removal
      let totalPassengerCount = 0;
      const passengerIds = new Set();
      
      for (let i = 1; i <= capacity; i++) {
        const fieldName = `passenger${i}`;
        if (fieldName !== passengerField && driverData[fieldName] && driverData[fieldName].passengerId) {
          const passengerId = driverData[fieldName].passengerId;
          if (!passengerIds.has(passengerId)) {
            passengerIds.add(passengerId);
            totalPassengerCount += driverData[fieldName].passengerCount || 1;
          }
        }
      }
      
      const updateData = {
        [passengerField]: null,
        currentPassengers: totalPassengerCount,
        availableSeats: capacity - totalPassengerCount,
        lastUpdated: Date.now(),
        updatedAt: new Date()
      };
      
      // Update driver status if no passengers left
      if (totalPassengerCount === 0) {
        updateData.matchStatus = null;
        updateData.status = 'searching';
      }
      
      const forceImmediate = options.immediate || this.isMatchingServiceCall;
      
      if (forceImmediate) {
        this.stats.immediateWrites++;
        this.stats.matchingWrites++;
        
        await driverDoc.ref.update(updateData);
        console.log(`⚡ Removed passenger from ${passengerField}`);
      } else {
        this.queueWrite(COLLECTIONS.ACTIVE_SEARCHES_DRIVER, driverDocId, updateData, 'update');
      }
      
      // Update passenger document
      if (passengerData.passengerId) {
        await this.updatePassengerSearch(passengerData.passengerId, {
          matchId: null,
          matchedWith: null,
          matchStatus: null,
          matchField: null,
          status: 'searching'
        }, { immediate: true });
      }
      
      // Stop tracking for this passenger
      this.stopPassengerTracking(passengerData.passengerId, driverDocId);
      
      cache.del(`driver_${driverDocId}`);
      if (passengerData.passengerId) {
        cache.del(`passenger_${passengerData.passengerId}`);
      }
      
      return true;
      
    } catch (error) {
      console.error(`❌ Error removing passenger from field:`, error);
      return false;
    }
  }
  
  // ========== UPDATED REAL-TIME TRACKING SYSTEM ==========
  
  async startPassengerTracking(passengerPhone, driverPhone, passengerField = null) {
    try {
      const passengerDocId = this.getDocumentIdFromPhone(passengerPhone);
      const driverDocId = this.getDocumentIdFromPhone(driverPhone);
      
      if (!passengerDocId || !driverDocId) {
        throw new Error('Invalid phone numbers for tracking');
      }
      
      const listenerId = `${driverDocId}_${passengerDocId}`;
      
      // Stop existing listener if any
      if (this.activeListeners.has(listenerId)) {
        console.log(`🔄 Restarting tracking for ${listenerId}`);
        this.stopPassengerTracking(passengerPhone, driverPhone);
      }
      
      console.log(`🎯 Starting real-time tracking for passenger ${passengerDocId} by driver ${driverDocId}`);
      
      // Set up real-time listener
      const unsubscribe = this.db
        .collection(COLLECTIONS.ACTIVE_SEARCHES_PASSENGER)
        .doc(passengerDocId)
        .onSnapshot(async (snapshot) => {
          if (!snapshot.exists) {
            console.log(`⚠️ Passenger ${passengerDocId} document deleted`);
            this.stopPassengerTracking(passengerPhone, driverPhone);
            return;
          }
          
          const passengerData = snapshot.data();
          
          // Update driver's passenger field with location
          await this.updateDriverPassengerLocation(driverDocId, passengerDocId, passengerData, passengerField);
        }, (error) => {
          console.error(`❌ Listener error for ${passengerDocId}:`, error);
          this.stopPassengerTracking(passengerPhone, driverPhone);
        });
      
      // Store listener
      this.activeListeners.set(listenerId, {
        unsubscribe,
        passengerId: passengerDocId,
        driverId: driverDocId,
        passengerField: passengerField,
        startedAt: Date.now()
      });
      
      this.stats.listenersActive = this.activeListeners.size;
      
      console.log(`✅ Tracking started for ${listenerId}. Active listeners: ${this.activeListeners.size}`);
      
      return listenerId;
      
    } catch (error) {
      console.error(`❌ Error starting tracking:`, error);
      throw error;
    }
  }
  
  async updateDriverPassengerLocation(driverDocId, passengerDocId, passengerData, passengerField = null) {
    try {
      // Find which field contains this passenger
      if (!passengerField) {
        const driverDoc = await this.db.collection(COLLECTIONS.ACTIVE_SEARCHES_DRIVER)
          .doc(driverDocId)
          .get();
        
        if (driverDoc.exists) {
          const driverData = driverDoc.data();
          const capacity = driverData.capacity || 4;
          
          for (let i = 1; i <= capacity; i++) {
            const fieldName = `passenger${i}`;
            if (driverData[fieldName] && driverData[fieldName].passengerId === passengerDocId) {
              passengerField = fieldName;
              break;
            }
          }
        }
      }
      
      if (!passengerField) {
        console.log(`⚠️ Could not find passenger field for ${passengerDocId} in driver ${driverDocId}`);
        return false;
      }
      
      const updates = {
        [`${passengerField}.currentLocation`]: passengerData.currentLocation,
        [`${passengerField}.lastLocationUpdate`]: new Date(),
        [`${passengerField}.updatedAt`]: new Date(),
        lastUpdated: Date.now(),
        updatedAt: new Date()
      };
      
      await this.db.collection(COLLECTIONS.ACTIVE_SEARCHES_DRIVER)
        .doc(driverDocId)
        .update(updates);
      
      this.stats.locationUpdates++;
      cache.del(`driver_${driverDocId}`);
      
      return true;
      
    } catch (error) {
      console.error(`❌ Error updating driver passenger location:`, error);
      return false;
    }
  }
  
  // ========== NEW: UPDATE MATCH STATUS ==========
  
  async updateMatchStatus(matchId, status, userId = null) {
    try {
      const matchRef = this.db.collection('matches').doc(matchId);
      const updateData = {
        status: status,
        updatedAt: new Date().toISOString()
      };
      
      if (userId) {
        updateData[`${status.toLowerCase()}By`] = userId;
        updateData[`${status.toLowerCase()}At`] = new Date().toISOString();
      }
      
      await matchRef.update(updateData);
      console.log(`✅ Match ${matchId} status updated to ${status}`);
      return true;
    } catch (error) {
      console.error(`❌ Error updating match status ${matchId}:`, error);
      return false;
    }
  }
  
  // ========== FIXED BATCH WRITING ==========
  
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
    try {
      await this.flushWrites();
    } catch (error) {
      console.error('❌ Error in safeFlushWrites:', error);
    } finally {
      this.isProcessing = false;
    }
  }
  
  async flushWrites() {
    if (this.writeQueue.length === 0) return;
    
    let toProcess = [];
    
    try {
      const batch = this.db.batch();
      const operations = [];
      
      // Process in smaller batches to avoid timeouts
      const batchSize = Math.min(this.batchLimit, 200); // Max 200 ops per batch
      toProcess = this.writeQueue.splice(0, batchSize);
      
      console.log(`🔄 Flushing ${toProcess.length} write operations (queue: ${this.writeQueue.length} remaining)`);
      
      for (const op of toProcess) {
        try {
          const docRef = this.db.collection(op.collection).doc(op.docId);
          
          if (op.operation === 'set') {
            batch.set(docRef, op.data);
          } else if (op.operation === 'update') {
            batch.update(docRef, op.data);
          } else if (op.operation === 'delete') {
            batch.delete(docRef);
          }
          
          operations.push(op);
        } catch (opError) {
          console.error(`❌ Error processing operation for ${op.collection}/${op.docId}:`, opError.message);
          // Keep the operation in queue for retry
          this.writeQueue.unshift(op);
        }
      }
      
      // Only commit if there are operations
      if (operations.length > 0) {
        const commitPromise = batch.commit();
        
        // Add timeout to batch commit
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Batch commit timeout')), 10000); // 10 second timeout
        });
        
        await Promise.race([commitPromise, timeoutPromise]);
        this.stats.batchWrites += operations.length;
        console.log(`✅ Successfully committed ${operations.length} write operations`);
      }
      
    } catch (error) {
      console.error('❌ Batch write failed:', error.message);
      this.stats.queueFlushErrors++;
      
      // Requeue failed operations
      if (toProcess.length > 0) {
        // Filter out operations that had individual errors
        const failedOps = toProcess.filter(op => {
          // Check if this operation was already re-queued
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
            
            if (op.retryCount < 5) { // Max 5 retries
              this.stats.retriedOperations++;
              // Add delay based on retry count (exponential backoff)
              const delay = Math.min(60000, 1000 * Math.pow(2, op.retryCount));
              setTimeout(() => {
                this.writeQueue.unshift(op);
              }, delay);
            } else {
              console.error(`❌ Max retries exceeded for ${op.collection}/${op.docId}`);
            }
          }
        }
      }
      
      // Wait before retrying
      setTimeout(() => this.safeFlushWrites(), 5000);
    }
  }
  
  // ========== EXISTING METHODS ==========
  
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
      console.error(`❌ Error getting driver:`, error);
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
      console.error(`❌ Error getting passenger:`, error);
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
      console.error(`❌ Error updating driver:`, error.message);
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
      console.error(`❌ Error updating passenger:`, error.message);
      throw error;
    }
  }
  
  // ========== NEW: GET DRIVER PASSENGER SUMMARY ==========
  
  async getDriverPassengerSummary(driverId) {
    try {
      const driverDocId = this.getDocumentIdFromPhone(driverId);
      if (!driverDocId) return null;
      
      const driverDoc = await this.db.collection(COLLECTIONS.ACTIVE_SEARCHES_DRIVER)
        .doc(driverDocId)
        .get();
      
      if (!driverDoc.exists) return null;
      
      const driverData = driverDoc.data();
      const capacity = driverData.capacity || 4;
      
      const passengers = [];
      let totalPassengerCount = 0;
      let acceptedCount = 0;
      let proposedCount = 0;
      
      for (let i = 1; i <= capacity; i++) {
        const fieldName = `passenger${i}`;
        const passengerData = driverData[fieldName];
        
        if (passengerData && passengerData.passengerId) {
          passengers.push({
            field: fieldName,
            ...passengerData
          });
          
          totalPassengerCount += passengerData.passengerCount || 1;
          
          if (passengerData.matchStatus === 'accepted') {
            acceptedCount++;
          } else if (passengerData.matchStatus === 'proposed') {
            proposedCount++;
          }
        }
      }
      
      return {
        driverId: driverDocId,
        driverName: driverData.driverName,
        currentPassengers: totalPassengerCount,
        capacity: capacity,
        availableSeats: capacity - totalPassengerCount,
        acceptedPassengers: acceptedCount,
        proposedPassengers: proposedCount,
        totalPassengers: passengers.length,
        passengers: passengers,
        driverStatus: driverData.status,
        driverMatchStatus: driverData.matchStatus || 'none'
      };
      
    } catch (error) {
      console.error('❌ Error getting driver passenger summary:', error);
      return null;
    }
  }
  
  // ========== TRACKING METHODS ==========
  
  stopPassengerTracking(passengerPhone, driverPhone) {
    try {
      const passengerDocId = this.getDocumentIdFromPhone(passengerPhone);
      const driverDocId = this.getDocumentIdFromPhone(driverPhone);
      
      if (!passengerDocId || !driverDocId) return false;
      
      const listenerId = `${driverDocId}_${passengerDocId}`;
      const listener = this.activeListeners.get(listenerId);
      
      if (listener) {
        listener.unsubscribe();
        this.activeListeners.delete(listenerId);
        this.stats.listenersActive = this.activeListeners.size;
        
        console.log(`🛑 Stopped tracking ${passengerDocId}. Active: ${this.activeListeners.size}`);
        return true;
      }
      
      return false;
      
    } catch (error) {
      console.error(`❌ Error stopping tracking:`, error);
      return false;
    }
  }
  
  stopAllTrackingForDriver(driverPhone) {
    try {
      const driverDocId = this.getDocumentIdFromPhone(driverPhone);
      if (!driverDocId) return 0;
      
      let stoppedCount = 0;
      
      for (const [listenerId, listener] of this.activeListeners.entries()) {
        if (listener.driverId === driverDocId) {
          listener.unsubscribe();
          this.activeListeners.delete(listenerId);
          stoppedCount++;
        }
      }
      
      this.stats.listenersActive = this.activeListeners.size;
      console.log(`🛑 Stopped ${stoppedCount} trackers for ${driverDocId}`);
      
      return stoppedCount;
      
    } catch (error) {
      console.error(`❌ Error stopping all tracking:`, error);
      return 0;
    }
  }
  
  stopAllTracking() {
    let stoppedCount = 0;
    
    for (const [listenerId, listener] of this.activeListeners.entries()) {
      listener.unsubscribe();
      this.activeListeners.delete(listenerId);
      stoppedCount++;
    }
    
    this.stats.listenersActive = 0;
    console.log(`🛑 Stopped all ${stoppedCount} trackers`);
    
    return stoppedCount;
  }
  
  // ========== UPDATED BATCH PROCESSOR ==========
  
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
        }
      }
    }, 60000);
    
    // Stats logging
    setInterval(() => {
      console.log('📊 Firestore Service Stats:', JSON.stringify(this.getStats(), null, 2));
    }, 60000);
    
    // Cleanup stale listeners
    setInterval(() => {
      this.cleanupStaleListeners();
    }, 1800000);
    
    console.log('✅ Firestore Service started with multi-passenger support');
    return this;
  }
  
  cleanupStaleListeners() {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [listenerId, listener] of this.activeListeners.entries()) {
      if (now - listener.startedAt > 7200000) { // 2 hours
        listener.unsubscribe();
        this.activeListeners.delete(listenerId);
        cleanedCount++;
      }
    }
    
    this.stats.listenersActive = this.activeListeners.size;
    
    if (cleanedCount > 0) {
      console.log(`🧹 Cleaned up ${cleanedCount} stale listeners`);
    }
    
    return cleanedCount;
  }
  
  getStats() {
    return {
      ...this.stats,
      queueSize: this.writeQueue.length,
      activeListeners: this.activeListeners.size,
      isProcessing: this.isProcessing,
      cacheStats: cache.stats ? cache.stats() : { size: 'N/A' }
    };
  }
  
  // ========== ADDITIONAL UTILITY METHODS ==========
  
  async deleteDriverSearch(phoneNumber, options = {}) {
    try {
      const driverDocId = this.getDocumentIdFromPhone(phoneNumber);
      if (!driverDocId) throw new Error('Invalid phone for deletion');
      
      cache.del(`driver_${driverDocId}`);
      cache.del('active_searches_all');
      cache.del('active_drivers');
      
      if (options.immediate) {
        await this.db.collection(COLLECTIONS.ACTIVE_SEARCHES_DRIVER)
          .doc(driverDocId)
          .delete();
      } else {
        this.queueWrite(COLLECTIONS.ACTIVE_SEARCHES_DRIVER, driverDocId, null, 'delete');
      }
      
      // Stop all tracking for this driver
      this.stopAllTrackingForDriver(phoneNumber);
      
      return true;
      
    } catch (error) {
      console.error(`❌ Error deleting driver:`, error);
      return false;
    }
  }
  
  async deletePassengerSearch(phoneNumber, options = {}) {
    try {
      const passengerDocId = this.getDocumentIdFromPhone(phoneNumber);
      if (!passengerDocId) throw new Error('Invalid phone for deletion');
      
      cache.del(`passenger_${passengerDocId}`);
      cache.del('active_searches_all');
      cache.del('active_passengers');
      
      if (options.immediate) {
        await this.db.collection(COLLECTIONS.ACTIVE_SEARCHES_PASSENGER)
          .doc(passengerDocId)
          .delete();
      } else {
        this.queueWrite(COLLECTIONS.ACTIVE_SEARCHES_PASSENGER, passengerDocId, null, 'delete');
      }
      
      return true;
      
    } catch (error) {
      console.error(`❌ Error deleting passenger:`, error);
      return false;
    }
  }
  
  async searchDriversByLocation(pickupLocation, maxDistance = 5000, limit = 50) {
    try {
      // Note: This is a simplified version. In production, you'd use geohashes or a geospatial service
      const cacheKey = `drivers_near_${pickupLocation.latitude}_${pickupLocation.longitude}_${maxDistance}`;
      const cached = cache.get(cacheKey);
      
      if (cached) {
        this.stats.cacheHits++;
        return cached;
      }
      
      const driversRef = this.db.collection(COLLECTIONS.ACTIVE_SEARCHES_DRIVER);
      const snapshot = await driversRef
        .where('isSearching', '==', true)
        .where('status', '==', 'searching')
        .limit(limit)
        .get();
      
      const drivers = [];
      snapshot.forEach(doc => {
        const driver = { id: doc.id, ...doc.data() };
        // Simple distance calculation (you'd implement proper geospatial query in production)
        if (driver.pickupLocation) {
          const distance = helpers.calculateDistance(
            pickupLocation,
            driver.pickupLocation
          );
          
          if (distance <= maxDistance) {
            driver.distance = distance;
            drivers.push(driver);
          }
        }
      });
      
      // Sort by distance
      drivers.sort((a, b) => a.distance - b.distance);
      
      cache.set(cacheKey, drivers, 30000); // Cache for 30 seconds
      return drivers;
      
    } catch (error) {
      console.error('❌ Error searching drivers by location:', error);
      return [];
    }
  }
  
  async getAllActiveSearches() {
    try {
      const cacheKey = 'active_searches_all';
      const cached = cache.get(cacheKey);
      
      if (cached) {
        this.stats.cacheHits++;
        return cached;
      }
      
      const [driversSnapshot, passengersSnapshot] = await Promise.all([
        this.db.collection(COLLECTIONS.ACTIVE_SEARCHES_DRIVER)
          .where('isSearching', '==', true)
          .get(),
        this.db.collection(COLLECTIONS.ACTIVE_SEARCHES_PASSENGER)
          .where('status', '==', 'searching')
          .get()
      ]);
      
      const drivers = [];
      const passengers = [];
      
      driversSnapshot.forEach(doc => {
        drivers.push({ id: doc.id, ...doc.data() });
      });
      
      passengersSnapshot.forEach(doc => {
        passengers.push({ id: doc.id, ...doc.data() });
      });
      
      const result = {
        drivers,
        passengers,
        totalDrivers: drivers.length,
        totalPassengers: passengers.length,
        timestamp: Date.now()
      };
      
      cache.set(cacheKey, result, 15000); // Cache for 15 seconds
      return result;
      
    } catch (error) {
      console.error('❌ Error getting all active searches:', error);
      return { drivers: [], passengers: [], totalDrivers: 0, totalPassengers: 0 };
    }
  }
  
  // ========== CLEANUP METHOD ==========
  
  cleanup() {
    if (this.processorInterval) {
      clearInterval(this.processorInterval);
      this.processorInterval = null;
    }
    
    this.stopAllTracking();
    this.writeQueue = [];
    this.isProcessing = false;
    
    console.log('🧹 Firestore Service cleaned up');
  }
  
  // ========== EMERGENCY QUEUE CLEAR ==========
  
  emergencyClearQueue() {
    const queueSize = this.writeQueue.length;
    this.writeQueue = [];
    console.log(`🚨 Emergency queue clear: ${queueSize} operations removed`);
    return queueSize;
  }
}

module.exports = FirestoreService;
