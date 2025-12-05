const { COLLECTIONS, TIMEOUTS, BATCH_WRITE_LIMIT } = require('../config/constants');
const cache = require('../utils/cache');
const helpers = require('../utils/helpers');

class FirestoreService {
  constructor(db, admin) {
    this.db = db;
    this.admin = admin;
    this.batchLimit = BATCH_WRITE_LIMIT;
    this.writeQueue = [];
    this.stats = {
      reads: 0,
      writes: 0,
      cacheHits: 0,
      batchWrites: 0
    };
  }
  
  // ========== BATCH WRITING ==========
  
  queueWrite(collection, docId, data, operation = 'set') {
    this.writeQueue.push({
      collection,
      docId,
      data,
      operation,
      timestamp: Date.now()
    });
    
    // Auto-flush when queue reaches limit
    if (this.writeQueue.length >= this.batchLimit / 2) {
      setImmediate(() => this.flushWrites());
    }
    
    this.stats.writes++;
    return true;
  }
  
  async flushWrites() {
    if (this.writeQueue.length === 0) return;
    
    try {
      const batch = this.db.batch();
      const operations = [];
      const toProcess = this.writeQueue.splice(0, this.batchLimit);
      
      for (const op of toProcess) {
        const docRef = this.db.collection(op.collection).doc(op.docId);
        
        if (op.operation === 'set') {
          batch.set(docRef, op.data);
        } else if (op.operation === 'update') {
          batch.update(docRef, op.data);
        } else if (op.operation === 'delete') {
          batch.delete(docRef);
        }
        
        operations.push(op);
      }
      
      await batch.commit();
      console.log(`✅ Batch write: ${operations.length} operations`);
      this.stats.batchWrites += operations.length;
      
    } catch (error) {
      console.error('❌ Batch write failed:', error);
      // Re-add failed operations to queue
      this.writeQueue.unshift(...toProcess);
    }
  }
  
  // ========== CACHED READS ==========
  
  async getWithCache(collection, docId, cacheKey = null, ttl = TIMEOUTS.CACHE_TTL) {
    const key = cacheKey || `${collection}_${docId}`;
    
    // Check cache first
    const cached = cache.get(key);
    if (cached) {
      this.stats.cacheHits++;
      return cached;
    }
    
    // Fetch from Firestore
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
  
  async queryWithCache(collection, queryConditions, cacheKey, ttl = TIMEOUTS.CACHE_TTL) {
    // Check cache
    const cached = cache.get(cacheKey);
    if (cached) {
      this.stats.cacheHits++;
      return cached;
    }
    
    // Build query
    let query = this.db.collection(collection);
    
    queryConditions.forEach(condition => {
      query = query.where(...condition);
    });
    
    const snapshot = await query.get();
    this.stats.reads++;
    
    const results = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    
    cache.set(cacheKey, results, ttl);
    
    return results;
  }
  
  // ========== OPTIMIZED BULK OPERATIONS ==========
  
  async getAllActiveSearches() {
    const cacheKey = 'active_searches_all';
    const cached = cache.get(cacheKey);
    
    if (cached) {
      this.stats.cacheHits++;
      return cached;
    }
    
    // Get drivers and passengers in parallel
    const [drivers, passengers] = await Promise.all([
      this.queryWithCache(
        COLLECTIONS.ACTIVE_SEARCHES_DRIVER,
        [['status', '==', 'searching']],
        'active_drivers',
        10000 // 10 second cache for active searches
      ),
      this.queryWithCache(
        COLLECTIONS.ACTIVE_SEARCHES_PASSENGER,
        [['status', '==', 'searching']],
        'active_passengers',
        10000
      )
    ]);
    
    const result = { drivers, passengers };
    cache.set(cacheKey, result, 10000);
    
    return result;
  }
  
  async getDriverSearch(driverId) {
    return this.getWithCache(
      COLLECTIONS.ACTIVE_SEARCHES_DRIVER,
      driverId,
      `driver_${driverId}`,
      30000 // 30 second cache for driver searches
    );
  }
  
  async getPassengerSearch(passengerId) {
    return this.getWithCache(
      COLLECTIONS.ACTIVE_SEARCHES_PASSENGER,
      passengerId,
      `passenger_${passengerId}`,
      30000
    );
  }
  
  // ========== OPTIMIZED UPDATE OPERATIONS ==========
  
  async updateDriverSearch(driverId, updates, options = {}) {
    const cacheKey = `driver_${driverId}`;
    
    // Clear cache
    cache.del(cacheKey);
    cache.del('active_searches_all');
    
    if (options.immediate) {
      await this.db.collection(COLLECTIONS.ACTIVE_SEARCHES_DRIVER).doc(driverId).update({
        ...updates,
        updatedAt: this.admin.firestore.FieldValue.serverTimestamp()
      });
      return true;
    } else {
      this.queueWrite(COLLECTIONS.ACTIVE_SEARCHES_DRIVER, driverId, updates, 'update');
      return true;
    }
  }
  
  async updatePassengerSearch(passengerId, updates, options = {}) {
    const cacheKey = `passenger_${passengerId}`;
    
    // Clear cache
    cache.del(cacheKey);
    cache.del('active_searches_all');
    
    if (options.immediate) {
      await this.db.collection(COLLECTIONS.ACTIVE_SEARCHES_PASSENGER).doc(passengerId).update({
        ...updates,
        updatedAt: this.admin.firestore.FieldValue.serverTimestamp()
      });
      return true;
    } else {
      this.queueWrite(COLLECTIONS.ACTIVE_SEARCHES_PASSENGER, passengerId, updates, 'update');
      return true;
    }
  }
  
  // ========== SEARCH MANAGEMENT ==========
  
  async saveDriverSearch(driverData) {
    const driverId = driverData.userId || driverData.driverId;
    if (!driverId) {
      throw new Error('driverId is required for saving driver search');
    }
    
    const searchData = {
      // Basic identification
      driverId: driverId,
      userType: 'driver',
      
      // Driver profile data
      driverName: driverData.driverName || 'Unknown Driver',
      driverPhone: driverData.driverPhone || 'Not provided',
      driverPhotoUrl: driverData.driverPhotoUrl || '',
      driverRating: driverData.driverRating || 5.0,
      
      // Vehicle information
      vehicleInfo: driverData.vehicleInfo || {
        model: driverData.vehicleModel || 'Unknown Model',
        plate: driverData.vehiclePlate || 'Unknown Plate',
        color: driverData.vehicleColor || 'Unknown Color',
        type: driverData.vehicleType || 'car'
      },
      
      // Location data
      pickupLocation: driverData.pickupLocation,
      destinationLocation: driverData.destinationLocation,
      pickupName: driverData.pickupName || 'Unknown Pickup',
      destinationName: driverData.destinationName || 'Unknown Destination',
      
      // Route geometry
      routePoints: driverData.routePoints || [],
      
      // Vehicle & capacity data
      passengerCount: driverData.passengerCount || 0,
      capacity: driverData.capacity || 4,
      vehicleType: driverData.vehicleType || 'car',
      availableSeats: driverData.capacity || 4,
      currentPassengers: 0,
      
      // Match acceptance fields
      matchId: null,
      matchedWith: null,
      matchStatus: null,
      tripStatus: null,
      rideId: null,
      passenger: null,
      
      // Route information
      distance: driverData.distance || 0,
      duration: driverData.duration || 0,
      fare: driverData.fare || 0,
      estimatedFare: driverData.estimatedFare || 0,
      
      // Search metadata
      rideType: driverData.rideType || 'immediate',
      scheduledTime: driverData.scheduledTime ? 
        this.admin.firestore.Timestamp.fromDate(new Date(driverData.scheduledTime)) : null,
      searchId: driverData.searchId || `driver_search_${driverId}_${Date.now()}`,
      status: 'searching',
      
      // System data
      createdAt: this.admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: this.admin.firestore.FieldValue.serverTimestamp()
    };
    
    this.queueWrite(COLLECTIONS.ACTIVE_SEARCHES_DRIVER, driverId, searchData, 'set');
    
    // Clear cache
    cache.del(`driver_${driverId}`);
    cache.del('active_searches_all');
    
    console.log(`✅ Driver search queued: ${searchData.driverName}`);
    return searchData;
  }
  
  async savePassengerSearch(passengerData) {
    const passengerId = passengerData.userId || passengerData.passengerId;
    if (!passengerId) {
      throw new Error('passengerId is required for saving passenger search');
    }
    
    const searchData = {
      // Basic identification
      passengerId: passengerId,
      userType: 'passenger',
      
      // Passenger profile data
      passengerName: passengerData.passengerName || 'Unknown Passenger',
      passengerPhone: passengerData.passengerPhone || 'Not provided',
      passengerPhotoUrl: passengerData.passengerPhotoUrl || '',
      passengerRating: passengerData.passengerRating || 5.0,
      
      // Location data
      pickupLocation: passengerData.pickupLocation,
      destinationLocation: passengerData.destinationLocation,
      pickupName: passengerData.pickupName || 'Unknown Pickup',
      destinationName: passengerData.destinationName || 'Unknown Destination',
      
      // Route geometry
      routePoints: passengerData.routePoints || [],
      
      // Passenger data
      passengerCount: passengerData.passengerCount || 1,
      
      // Match acceptance fields
      matchId: null,
      matchedWith: null,
      matchStatus: null,
      tripStatus: null,
      rideId: null,
      driver: null,
      
      // Route information
      distance: passengerData.distance || 0,
      duration: passengerData.duration || 0,
      fare: passengerData.fare || 0,
      estimatedFare: passengerData.estimatedFare || 0,
      
      // Search metadata
      rideType: passengerData.rideType || 'immediate',
      scheduledTime: passengerData.scheduledTime ? 
        this.admin.firestore.Timestamp.fromDate(new Date(passengerData.scheduledTime)) : null,
      searchId: passengerData.searchId || `passenger_search_${passengerId}_${Date.now()}`,
      status: 'searching',
      
      // System data
      createdAt: this.admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: this.admin.firestore.FieldValue.serverTimestamp()
    };
    
    this.queueWrite(COLLECTIONS.ACTIVE_SEARCHES_PASSENGER, passengerId, searchData, 'set');
    
    // Clear cache
    cache.del(`passenger_${passengerId}`);
    cache.del('active_searches_all');
    
    console.log(`✅ Passenger search queued: ${searchData.passengerName}`);
    return searchData;
  }
  
  // ========== MATCH MANAGEMENT ==========
  
  async saveMatch(matchData) {
    this.queueWrite(COLLECTIONS.ACTIVE_MATCHES, matchData.matchId, {
      ...matchData,
      createdAt: this.admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: this.admin.firestore.FieldValue.serverTimestamp()
    }, 'set');
    
    console.log(`✅ Match queued: ${matchData.matchId}`);
    return true;
  }
  
  async getMatch(matchId) {
    return this.getWithCache(
      COLLECTIONS.ACTIVE_MATCHES,
      matchId,
      `match_${matchId}`,
      60000
    );
  }
  
  // ========== RIDE MANAGEMENT ==========
  
  async createActiveRide(driverData, passengerData) {
    const rideId = helpers.generateId('ride_');
    
    const rideData = {
      rideId: rideId,
      driverId: driverData.driverId || driverData.userId,
      driverName: driverData.driverName,
      driverPhone: driverData.driverPhone,
      driverPhotoUrl: driverData.driverPhotoUrl,
      driverRating: driverData.driverRating,
      vehicleInfo: driverData.vehicleInfo,
      passengerId: passengerData.passengerId || passengerData.userId,
      passengerName: passengerData.passengerName,
      passengerPhone: passengerData.passengerPhone,
      passengerPhotoUrl: passengerData.passengerPhotoUrl,
      pickupLocation: passengerData.pickupLocation || driverData.pickupLocation,
      pickupName: passengerData.pickupName || driverData.pickupName,
      destinationLocation: passengerData.destinationLocation || driverData.destinationLocation,
      destinationName: passengerData.destinationName || driverData.destinationName,
      distance: passengerData.distance || driverData.distance,
      duration: passengerData.duration || driverData.duration,
      estimatedFare: passengerData.estimatedFare || driverData.estimatedFare,
      rideType: driverData.rideType || passengerData.rideType || 'immediate',
      scheduledTime: driverData.scheduledTime || passengerData.scheduledTime,
      status: 'driver_accepted',
      matchId: driverData.matchId,
      tripStatus: 'driver_accepted',
      acceptedAt: this.admin.firestore.FieldValue.serverTimestamp(),
      createdAt: this.admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: this.admin.firestore.FieldValue.serverTimestamp()
    };
    
    this.queueWrite(COLLECTIONS.ACTIVE_RIDES, rideId, rideData, 'set');
    
    console.log(`✅ Ride created: ${rideId}`);
    return rideData;
  }
  
  // ========== STATISTICS ==========
  
  getStats() {
    return {
      ...this.stats,
      queueSize: this.writeQueue.length,
      cacheStats: cache.stats()
    };
  }
  
  resetStats() {
    this.stats = {
      reads: 0,
      writes: 0,
      cacheHits: 0,
      batchWrites: 0
    };
  }
  
  // ========== START BATCH PROCESSOR ==========
  
  startBatchProcessor() {
    // Flush writes every 5 seconds
    setInterval(() => {
      this.flushWrites();
    }, 5000);
    
    // Log stats every 5 minutes
    setInterval(() => {
      console.log('📊 Firestore Service Stats:', this.getStats());
    }, 300000);
    
    console.log('✅ Firestore Service batch processor started');
  }
}

module.exports = FirestoreService;
