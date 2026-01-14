// MatchingService.js - Phone Number Based Querying
const { TIMEOUTS } = require('../config/constants');
const RealtimeLocationService = require('./realtimeLocationService');
const { matchingConfigManager } = require('../config/matchingConfig');
const GlobalLocationService = require('./GlobalLocationService');

class MatchingService {
  constructor(firestoreService, searchService, websocketServer, notificationService, admin) {
    this.firestoreService = firestoreService;
    this.searchService = searchService;
    this.websocketServer = websocketServer;
    this.notificationService = notificationService;
    this.admin = admin;
    
    this.config = matchingConfigManager;
    this.config.logConfiguration();
    
    const config = this.config.activeConfig;
    this.matchAttempts = 0;
    this.successfulMatches = 0;
    this.failedMatches = 0;
    this.cycleCount = 0;
    this.FORCE_TEST_MODE = config.FORCE_TEST_MODE;
    this.AUTO_REPAIR_MATCHES = config.AUTO_REPAIR_MATCHES;
    this.activeMatchIds = new Set();
    this.isInitialized = false;
    
    this.cancelledDriverBlacklist = new Map();
    this.BLACKLIST_DURATION = config.DRIVER_CONTROL.BLACKLIST_DURATION;
    this.driverStopTimestamps = new Map();
    
    this.initializedSearches = new Map();
    this.fullDrivers = new Set();
    
    const strategy = config.MATCHING_STRATEGY || {};
    this.ONE_PASSENGER_AT_A_TIME = strategy.ONE_PASSENGER_AT_A_TIME ?? true;
    this.WAIT_FOR_ACCEPTANCE_BEFORE_NEXT = strategy.WAIT_FOR_ACCEPTANCE_BEFORE_NEXT ?? true;
    
    console.log(`🔥 ${this.config.currentProfile} MODE | 🔄 ${TIMEOUTS.MATCHING_INTERVAL}ms`);
    console.log(`🚫 ONE-PASSENGER-AT-A-TIME: ${this.ONE_PASSENGER_AT_A_TIME ? 'ENABLED' : 'DISABLED'}`);
    
    this.locationService = new RealtimeLocationService(firestoreService, admin);
    if (this.locationService) this.locationService.websocketServer = websocketServer;
    
    this.globalLocationService = new GlobalLocationService();
    
    this.initializeFirestoreHelpers();
    
    setInterval(() => {
      if (this.locationService?.cleanupExpiredSessions) this.locationService.cleanupExpiredSessions();
    }, 300000);
    
    setTimeout(() => this.setupDriverStatusMonitor(), 5000);
    this.autoStopCheckIntervalId = setInterval(() => this.checkAllDriverAutoStops(), 10000);
    this.cleanupFullDriversIntervalId = setInterval(() => this.cleanupFullDriversTracking(), 30000);
    this.rideCleanupIntervalId = setInterval(() => this.cleanupOldRides(), 3600000);
    
    this.setupWebSocketHandlers();
  }
  
  setupWebSocketHandlers() {
    if (!this.websocketServer) return;
    
    const originalHandleMessage = this.websocketServer.handleMessage;
    
    this.websocketServer.handleMessage = async (ws, message) => {
      try {
        const data = JSON.parse(message);
        
        switch(data.type) {
          case 'LOCATION_UPDATE':
            await this.handleLocationUpdate(ws, data);
            return;
            
          case 'GET_NEARBY_USERS':
            await this.handleGetNearbyUsers(ws, data);
            return;
            
          case 'GET_ALL_USERS':
            await this.handleGetAllUsers(ws, data);
            return;
            
          case 'HEARTBEAT':
            await this.handleHeartbeat(ws, data);
            return;
        }
        
        if (originalHandleMessage) {
          return originalHandleMessage.call(this.websocketServer, ws, message);
        }
      } catch (error) {
        console.error('❌ WebSocket message error:', error);
      }
    };
    
    this.websocketServer.onConnection = (ws, userId, userType, userInfo) => {
      this.globalLocationService.addConnection(userId, ws, userType, userInfo);
    };
    
    this.websocketServer.onDisconnection = (userId) => {
      this.globalLocationService.removeConnection(userId);
    };
    
    console.log('✅ WebSocket handlers setup for global location sharing');
  }
  
  // MODIFIED: When driver starts searching
  async startDriverSearch(searchData) {
    try {
      const driverId = this.normalizePhone(searchData.driverId);
      
      // 1. Add driver to global location service (ALWAYS VISIBLE)
      if (this.globalLocationService) {
        this.globalLocationService.addConnection(
          driverId,
          null, // WebSocket will be added by connection handler
          'driver',
          {
            name: searchData.driverName,
            vehicle: searchData.vehicleInfo,
            rating: searchData.driverRating
          },
          {
            isSearching: true,
            trip: {
              destinationName: searchData.destinationName,
              pickupName: searchData.pickupName,
              estimatedFare: searchData.estimatedFare,
              passengerCount: searchData.passengerCount || 0,
              vehicleInfo: searchData.vehicleInfo
            }
          }
        );
        
        console.log(`📍 Driver ${driverId} added to global map (ALWAYS VISIBLE)`);
      }
      
      // 2. Continue with existing search logic
      const searchId = searchData.searchId || `search_${driverId}_${Date.now()}`;
      const driverData = {
        ...searchData,
        driverId,
        searchId,
        status: 'searching',
        searchStartedAt: this.getServerTimestamp(),
        lastUpdated: Date.now(),
        matchStatus: null,
        currentPassengers: 0,
        availableSeats: searchData.capacity || 4
      };
      
      await this.firestoreService.db.collection('active_searches_driver').doc(driverId).set(driverData, { merge: true });
      
      await this.sendSearchScreenInitialization(driverId, 'driver', driverData);
      
      return {
        success: true,
        searchId,
        driverId,
        message: 'Driver search started',
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      console.error('❌ Error starting driver search:', error);
      return { success: false, error: error.message };
    }
  }
  
  // MODIFIED: When passenger starts searching
  async startPassengerSearch(searchData) {
    try {
      const passengerId = this.normalizePhone(searchData.passengerId);
      
      // 1. Add passenger to global location service (VISIBLE WHILE SEARCHING)
      if (this.globalLocationService) {
        this.globalLocationService.addConnection(
          passengerId,
          null,
          'passenger',
          {
            name: searchData.passengerName,
            rating: searchData.passengerRating
          },
          {
            isSearching: true,
            trip: {
              destinationName: searchData.destinationName,
              pickupName: searchData.pickupName,
              estimatedFare: searchData.estimatedFare,
              passengerCount: searchData.passengerCount || 1
            }
          }
        );
        
        console.log(`📍 Passenger ${passengerId} added to global map (SEARCHING ONLY)`);
      }
      
      // 2. Continue with existing search logic
      const searchId = searchData.searchId || `search_${passengerId}_${Date.now()}`;
      const passengerData = {
        ...searchData,
        passengerId,
        searchId,
        status: 'searching',
        searchStartedAt: this.getServerTimestamp(),
        lastUpdated: Date.now(),
        matchStatus: null,
        matchId: null,
        matchedWith: null,
        driver: null
      };
      
      await this.firestoreService.db.collection('active_searches_passenger').doc(passengerId).set(passengerData, { merge: true });
      
      await this.sendSearchScreenInitialization(passengerId, 'passenger', passengerData);
      
      return {
        success: true,
        searchId,
        passengerId,
        message: 'Passenger search started',
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      console.error('❌ Error starting passenger search:', error);
      return { success: false, error: error.message };
    }
  }
  
  async handleLocationUpdate(ws, data) {
    try {
      const { userId, userType, location, trip } = data;
      
      const normalizedUserId = this.normalizePhone(userId);
      
      const success = this.globalLocationService.updateUserLocation(
        normalizedUserId, 
        location, 
        userType,
        trip
      );
      
      if (success) {
        await this.updateUserLocation(normalizedUserId, location, userType);
        
        await this.updateMatchLocationIfInMatch(normalizedUserId, userType, location);
      }
      
      ws.send(JSON.stringify({
        type: 'LOCATION_UPDATE_CONFIRMED',
        success,
        timestamp: Date.now()
      }));
      
    } catch (error) {
      console.error('❌ Error handling location update:', error);
      ws.send(JSON.stringify({
        type: 'ERROR',
        error: 'Location update failed',
        message: error.message
      }));
    }
  }
  
  async updateMatchLocationIfInMatch(userId, userType, location) {
    try {
      const collection = userType === 'driver' 
        ? 'active_searches_driver' 
        : 'active_searches_passenger';
      
      const userDoc = await this.firestoreService.db.collection(collection).doc(userId).get();
      if (!userDoc.exists) return;
      
      const userData = userDoc.data();
      
      if (userData.matchId && userData.matchStatus === 'accepted') {
        this.globalLocationService.updateMatchLocation(
          userData.matchId,
          userId,
          location
        );
      }
    } catch (error) {
      console.error('❌ Error updating match location:', error);
    }
  }
  
  initializeFirestoreHelpers() {
    try {
      this.FieldValue = this.admin?.firestore?.FieldValue || 
                       (this.admin?.firestore && this.admin.firestore.FieldValue) ||
                       require('firebase-admin').firestore.FieldValue;
    } catch (error) {
      console.error('Failed to initialize FieldValue:', error.message);
      this.FieldValue = null;
    }
  }
  
  getServerTimestamp() {
    return this.FieldValue ? this.FieldValue.serverTimestamp() : new Date().toISOString();
  }
  
  getUserId(data, type) {
    if (type === 'driver') {
      return data.driverPhone || data.driverId || data.userId || data.id;
    }
    return data.passengerPhone || data.passengerId || data.userId || data.id;
  }
  
  normalizePhone(phone) {
    if (!phone) return null;
    let normalized = phone.toString().trim();
    if (normalized.startsWith('+')) {
      normalized = '+' + normalized.substring(1).replace(/\D/g, '');
    } else {
      normalized = '+' + normalized.replace(/\D/g, '');
    }
    return normalized;
  }
  
  parseTimestamp(timestamp) {
    if (!timestamp) return null;
    if (timestamp.toDate) return timestamp.toDate();
    if (timestamp._seconds) return new Date(timestamp._seconds * 1000);
    if (timestamp instanceof Date) return timestamp;
    if (typeof timestamp === 'string') return new Date(timestamp);
    if (typeof timestamp === 'number') return new Date(timestamp);
    return null;
  }
  
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) * 
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return (R * c).toFixed(2);
  }
  
  toRad(degrees) {
    return degrees * (Math.PI/180);
  }
  
  extractLocation(data, type) {
    const defaultPickup = { lat: 8.550023, lng: 39.266712 };
    const defaultDest = { lat: 9.589549, lng: 41.866169 };
    
    if (type === 'pickup') {
      if (data.pickup?.location) return { loc: data.pickup.location, name: data.pickup.address || "Pickup" };
      if (data.pickupLocation) return { loc: data.pickupLocation, name: data.pickupName || "Pickup" };
      if (data.currentLocation) return { 
        loc: { 
          lat: data.currentLocation.latitude || data.currentLocation.lat || 8.550023, 
          lng: data.currentLocation.longitude || data.currentLocation.lng || 39.266712 
        }, 
        name: "Current Location" 
      };
      if (data.location) return { loc: data.location, name: data.pickupName || "Pickup" };
      return { loc: defaultPickup, name: data.pickupName || "Adama, Ethiopia" };
    } else {
      if (data.dropoff?.location) return { loc: data.dropoff.location, name: data.dropoff.address || "Destination" };
      if (data.destinationLocation) return { loc: data.destinationLocation, name: data.destinationName || "Destination" };
      if (data.dropoffLocation) return { loc: data.dropoffLocation, name: data.destinationName || "Destination" };
      return { loc: defaultDest, name: data.destinationName || "Dire Dawa, Ethiopia" };
    }
  }
  
  isPhoneNumber(str) {
    return /^\+?[\d\s\-()]+$/.test(str);
  }
  
  calculateRouteCompatibility(driverRoute, passengerRoute) {
    try {
      if (!driverRoute || !passengerRoute || 
          !driverRoute.pickup || !driverRoute.destination ||
          !passengerRoute.pickup || !passengerRoute.destination) {
        return { score: 0, reason: 'Missing route data' };
      }

      const dp = driverRoute.pickup, dd = driverRoute.destination;
      const pp = passengerRoute.pickup, pd = passengerRoute.destination;

      const pickupDistance = parseFloat(this.calculateDistance(pp.lat, pp.lng, dp.lat, dp.lng));
      const destDistance = parseFloat(this.calculateDistance(pd.lat, pd.lng, dd.lat, dd.lng));
      const directionScore = this.calculateDirectionSimilarity(dp, dd, pp, pd);

      const directDistance = parseFloat(this.calculateDistance(dp.lat, dp.lng, dd.lat, dd.lng));
      const distanceWithPickup = parseFloat(this.calculateDistance(dp.lat, dp.lng, pp.lat, pp.lng)) + 
                                 parseFloat(this.calculateDistance(pp.lat, pp.lng, dd.lat, dd.lng));
      const detourDistance = Math.abs(distanceWithPickup - directDistance);

      let score = 100;
      if (pickupDistance > 2) score -= pickupDistance > 5 ? 30 : 20;
      if (destDistance > 2) score -= destDistance > 5 ? 30 : 20;
      if (directionScore < 0.7) score -= directionScore < 0.4 ? 25 : 15;
      if (detourDistance > 5) score -= detourDistance > 10 ? 20 : 10;

      return {
        score: Math.max(0, Math.min(100, Math.round(score))),
        pickupDistance, destDistance,
        directionSimilarity: directionScore,
        detourDistance,
        totalDistance: pickupDistance + destDistance
      };
    } catch (error) {
      console.error('Error calculating route compatibility:', error);
      return { score: 0, reason: 'Calculation error' };
    }
  }
  
  calculateDirectionSimilarity(start1, end1, start2, end2) {
    const vec1 = { x: end1.lng - start1.lng, y: end1.lat - start1.lat };
    const vec2 = { x: end2.lng - start2.lng, y: end2.lat - start2.lat };
    const dotProduct = vec1.x * vec2.x + vec1.y * vec2.y;
    const mag1 = Math.sqrt(vec1.x * vec1.x + vec1.y * vec1.y);
    const mag2 = Math.sqrt(vec2.x * vec2.x + vec2.y * vec2.y);
    if (mag1 === 0 || mag2 === 0) return 0;
    return (dotProduct / (mag1 * mag2) + 1) / 2;
  }
  
  async sendSearchScreenInitialization(userId, userType, searchData) {
    try {
      const normalizedUserId = this.normalizePhone(userId);
      
      if (userType === 'passenger') {
        const passengerDoc = await this.firestoreService.db.collection('active_searches_passenger').doc(normalizedUserId).get();
        if (passengerDoc.exists) {
          const passengerData = passengerDoc.data();
          if (passengerData.matchStatus === 'accepted' || passengerData.status === 'accepted') {
            console.log(`⏭️ Skipping SEARCH_STARTED for ${normalizedUserId} - already accepted`);
            return;
          }
        }
      }
      
      console.log(`📤 Sending SEARCH_STARTED to ${userType} ${normalizedUserId}`);
      if (!this.websocketServer?.sendToUser) return;
      
      const message = {
        type: 'SEARCH_STARTED',
        data: {
          userId: normalizedUserId, 
          userType, 
          searchId: searchData.searchId, 
          searchData,
          timestamp: Date.now(), 
          status: 'searching',
          message: `Search started - looking for ${userType === 'driver' ? 'passengers' : 'drivers'}...`,
          screen: 'search', 
          shouldInitializeSearchScreen: true,
          location: searchData.currentLocation || { lat: 8.550023, lng: 39.266712 },
          destination: searchData.destinationLocation || { lat: 9.589549, lng: 41.866169 },
          capacity: searchData.capacity || 4, 
          routePoints: searchData.routePoints || [],
          searchScreenData: {
            searchId: searchData.searchId,
            pickupName: searchData.pickupName || "Pickup Location",
            destinationName: searchData.destinationName || "Destination",
            distance: searchData.distance || 0, 
            fare: searchData.fare || 0,
            duration: searchData.duration || 0,
            pickupLatLng: searchData.pickupLocation || searchData.currentLocation,
            destinationLatLng: searchData.destinationLocation,
            routePoints: searchData.routePoints || [],
            passengerCapacity: searchData.capacity || 4,
            driverId: userType === 'driver' ? normalizedUserId : undefined,
            driverName: searchData.driverName,
            driverPhone: searchData.driverPhone,
            vehicleInfo: searchData.vehicleInfo || {},
            estimatedDuration: searchData.estimatedDuration || 0,
            estimatedDistance: searchData.estimatedDistance || 0,
            estimatedFare: searchData.estimatedFare || 0
          }
        }
      };
      
      await this.websocketServer.sendToUser(normalizedUserId, message);
      console.log(`✅ Sent SEARCH_STARTED to ${userType} ${normalizedUserId}`);
    } catch (error) {
      console.error('❌ Error sending search started notification:', error);
    }
  }
  
  async checkAndInitializeNewSearches(drivers, passengers) {
    try {
      for (const driver of drivers) {
        const driverId = this.normalizePhone(this.getUserId(driver, 'driver'));
        if (this.fullDrivers.has(driverId)) {
          console.log(`⏭️ Skipping SEARCH_STARTED for ${driverId} - driver is full`);
          continue;
        }
        if (!this.initializedSearches.has(`driver_${driverId}`)) {
          await this.sendSearchScreenInitialization(driverId, 'driver', driver);
          this.initializedSearches.set(`driver_${driverId}`, Date.now());
          setTimeout(() => this.initializedSearches.delete(`driver_${driverId}`), 300000);
        }
      }
      
      for (const passenger of passengers) {
        const passengerId = this.normalizePhone(this.getUserId(passenger, 'passenger'));
        if (passenger.matchStatus === 'accepted' || passenger.status === 'accepted') {
          console.log(`⏭️ Skipping SEARCH_STARTED for ${passengerId} - already accepted`);
          continue;
        }
        if (!this.initializedSearches.has(`passenger_${passengerId}`)) {
          await this.sendSearchScreenInitialization(passengerId, 'passenger', passenger);
          this.initializedSearches.set(`passenger_${passengerId}`, Date.now());
          setTimeout(() => this.initializedSearches.delete(`passenger_${passengerId}`), 300000);
        }
      }
    } catch (error) {
      console.error('❌ Error initializing new searches:', error);
    }
  }
  
  async checkAndAutoStopDriverIfNeeded(driverId, currentLocation = null) {
    try {
      const normalizedDriverId = this.normalizePhone(driverId);
      const driverDoc = await this.firestoreService.db.collection('active_searches_driver').doc(normalizedDriverId).get();
      if (!driverDoc.exists) return false;
      
      const driverData = driverDoc.data();
      const driverPhone = normalizedDriverId;
      const searchId = driverData.searchId || `search_${normalizedDriverId}_${Date.now()}`;
      
      if (driverData.status === 'cancelled' || driverData.status === 'completed') return false;
      
      let hasArrived = false, distance = null;
      if (currentLocation && driverData.destinationLocation) {
        distance = this.calculateDistance(
          currentLocation.lat, currentLocation.lng,
          driverData.destinationLocation.lat, driverData.destinationLocation.lng
        );
        hasArrived = parseFloat(distance) <= 1.0;
      }
      
      const capacity = driverData.capacity || 4;
      const passengerIds = new Set();
      let currentPassengerCount = 0;
      
      for (let i = 1; i <= capacity; i++) {
        const fieldName = `passenger${i}`;
        if (driverData[fieldName] && driverData[fieldName].passengerId) {
          const passengerId = this.normalizePhone(driverData[fieldName].passengerId);
          if (!passengerIds.has(passengerId)) {
            passengerIds.add(passengerId);
            currentPassengerCount += driverData[fieldName].passengerCount || 1;
          }
        }
      }
      
      const areSeatsFull = currentPassengerCount >= capacity;
      if (areSeatsFull) this.fullDrivers.add(normalizedDriverId);
      
      if (hasArrived || areSeatsFull) {
        const reason = hasArrived ? 'arrived_at_destination' : 'seats_full';
        await this.stopDriverSearch(searchId, driverPhone, reason);
        
        if (this.websocketServer?.sendToUser) {
          await this.websocketServer.sendToUser(normalizedDriverId, {
            type: 'SEARCH_AUTO_STOPPED',
            data: {
              driverId: normalizedDriverId, 
              searchId, 
              reason, 
              hasArrived, 
              areSeatsFull,
              distanceToDestination: distance || null,
              currentPassengers: currentPassengerCount, 
              capacity,
              timestamp: Date.now(),
              message: hasArrived ? 'Search stopped - arrived near destination!' : 'Search stopped - vehicle is full!'
            }
          });
        }
        return true;
      }
      return false;
    } catch (error) {
      console.error('❌ Error in auto-stop check:', error);
      return false;
    }
  }
  
  async checkAllDriverAutoStops() {
    try {
      const driversSnapshot = await this.firestoreService.db
        .collection('active_searches_driver')
        .where('status', 'in', ['searching', 'matched', 'proposed'])
        .get({ source: 'server' });
      
      let stoppedCount = 0, continueCount = 0;
      for (const driverDoc of driversSnapshot.docs) {
        const driverData = driverDoc.data();
        const driverId = driverDoc.id;
        if (this.isDriverBlacklisted(driverId)) continue;
        const stopped = await this.checkAndAutoStopDriverIfNeeded(driverId, driverData.currentLocation);
        stopped ? stoppedCount++ : continueCount++;
      }
      if (stoppedCount > 0) console.log(`✅ Auto-stopped ${stoppedCount} drivers, ${continueCount} continue searching`);
    } catch (error) {
      console.error('❌ Error in auto-stop checks:', error);
    }
  }
  
  cleanupFullDriversTracking() {
    console.log(`🧹 Full drivers tracked: ${this.fullDrivers.size}`);
  }
  
  async stopPassengerSearch(passengerId, reason = 'passenger_stopped') {
    try {
      const normalizedPassengerId = this.normalizePhone(passengerId);
      const passengerRef = this.firestoreService.db.collection('active_searches_passenger').doc(normalizedPassengerId);
      const passengerDoc = await passengerRef.get();
      if (!passengerDoc.exists) return { success: false, error: 'Passenger not found' };
      
      await passengerRef.update({
        status: 'cancelled', 
        cancelledAt: this.getServerTimestamp(),
        endReason: reason, 
        cancelledBy: 'passenger', 
        lastUpdated: Date.now()
      });
      
      const passengerData = passengerDoc.data();
      if (passengerData.matchId) {
        const matchDoc = await this.firestoreService.db.collection('active_matches').doc(passengerData.matchId).get();
        if (matchDoc.exists) {
          const match = matchDoc.data();
          await matchDoc.ref.update({
            status: 'cancelled', 
            cancelledAt: this.getServerTimestamp(),
            cancelledBy: 'passenger', 
            cancellationReason: reason, 
            updatedAt: this.getServerTimestamp()
          });
          
          await this.updateActiveRideForMatch(matchDoc.id, 'cancelled', 'passenger', reason);
          
          if (match.driverId && match.passengerField) {
            const normalizedDriverId = this.normalizePhone(match.driverId);
            const driverDoc = await this.firestoreService.db.collection('active_searches_driver').doc(normalizedDriverId).get();
            if (driverDoc.exists) {
              await driverDoc.ref.update({
                [match.passengerField]: null, 
                lastUpdated: Date.now()
              });
              await this.updateDriverOverallStatus(normalizedDriverId);
            }
          }
        }
      }
      
      // NEW: Handle passenger cancellation in global location service
      await this.handlePassengerCancelledSearch(normalizedPassengerId);
      
      console.log(`✅ Successfully stopped passenger search for ${normalizedPassengerId}`);
      return { 
        success: true, 
        passengerId: normalizedPassengerId, 
        reason, 
        timestamp: new Date().toISOString() 
      };
    } catch (error) {
      console.error('❌ Error stopping passenger search:', error);
      return { success: false, error: error.message };
    }
  }
  
  async stopDriverSearch(searchId, driverId, reason) {
    try {
      console.log(`🛑 [MatchingService] STOPPING search for ${driverId}, reason: ${reason}`);
      
      let driverPhone = this.normalizePhone(driverId);
      if (!this.isPhoneNumber(driverPhone)) {
        try {
          const driverDoc = await this.firestoreService.db.collection('drivers').doc(driverPhone).get();
          if (driverDoc.exists && driverDoc.data().phone) {
            driverPhone = this.normalizePhone(driverDoc.data().phone);
          }
        } catch (e) {}
      }
      
      const driverRef = this.firestoreService.db.collection('active_searches_driver').doc(driverPhone);
      const driverDoc = await driverRef.get();
      if (!driverDoc.exists) return { success: false, error: 'Driver not found' };
      
      const shouldCancel = reason === 'seats_full' || reason === 'arrived_at_destination' || reason === 'manual_stop';
      
      if (shouldCancel) {
        if (reason === 'seats_full' || reason === 'arrived_at_destination') {
          this.addToBlacklist(driverPhone);
          this.driverStopTimestamps.set(driverPhone, Date.now());
          if (reason === 'seats_full') this.fullDrivers.add(driverPhone);
        }
        
        const preservedPassengers = await this.preserveAcceptedPassengers(driverPhone);
        
        await driverRef.update({
          status: 'searching', 
          searchStoppedAt: this.getServerTimestamp(),
          stopReason: reason, 
          lastUpdated: Date.now()
        });
        
        await this.cancelOnlyProposedMatches(driverPhone, searchId);
        await this.removeDriverFromMatchingPool(driverPhone);
        
        this.initializedSearches.delete(`driver_${driverId}`);
        this.initializedSearches.delete(`driver_${driverPhone}`);
        
        console.log(`✅ [MatchingService] Search stopped for ${driverId} (${reason}), preserved ${preservedPassengers.length} accepted passengers`);
        
        return { 
          success: true, 
          message: 'Search stopped, accepted passengers preserved',
          reason, 
          preservedPassengers: preservedPassengers.length,
          cancelled: true, 
          timestamp: new Date().toISOString()
        };
      } else {
        return { 
          success: true, 
          message: 'Search not cancelled',
          reason, 
          cancelled: false, 
          timestamp: new Date().toISOString()
        };
      }
    } catch (error) {
      console.error('❌ [MatchingService] Error stopping driver search:', error);
      return { success: false, error: error.message };
    }
  }
  
  async extendDriverSearchTime(searchId, driverId, additionalSeconds, newExpiresAt) {
    try {
      console.log(`⏰ [MatchingService] Extending time for search ${searchId}, driver ${driverId} +${additionalSeconds}s`);
      return { 
        success: true, 
        message: 'Search time extension processed', 
        searchId, 
        driverId, 
        additionalSeconds, 
        newExpiresAt, 
        timestamp: new Date().toISOString() 
      };
    } catch (error) {
      console.error('❌ [MatchingService] Error extending search time:', error);
      return { success: false, error: error.message };
    }
  }
  
  async removeDriverFromMatchingPool(driverId, searchId) {
    try {
      const normalizedDriverId = this.normalizePhone(driverId);
      await this.firestoreService.db.collection('active_drivers_matching').doc(normalizedDriverId).delete();
      console.log(`✅ Removed driver ${normalizedDriverId} from matching pool`);
    } catch (error) {
      console.error('Error removing driver from pool:', error);
    }
  }
  
  checkIfDriverHasProposedPassenger(driver) {
    const driverId = this.normalizePhone(this.getUserId(driver, 'driver'));
    const capacity = driver.capacity || 4;
    
    for (let i = 1; i <= capacity; i++) {
      const fieldName = `passenger${i}`;
      const passengerData = driver[fieldName];
      if (passengerData && passengerData.passengerId && passengerData.matchStatus === 'proposed') {
        console.log(`   ⚠️ Driver ${driverId} already has proposed passenger ${passengerData.passengerId} in ${fieldName}`);
        return true;
      }
    }
    return false;
  }
  
  async setupDriverStatusMonitor() {
    console.log('👁️ Setting up real-time driver status monitor...');
    try {
      this.firestoreService.db.collection('active_searches_driver').onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'modified') {
            const driverData = change.doc.data();
            const driverId = change.doc.id;
            if (driverData.status === 'cancelled' || driverData.status === 'stopped') {
              console.log(`🚫 Real-time monitor: Driver ${driverId} status changed to ${driverData.status}`);
              this.addToBlacklist(driverId);
              this.driverStopTimestamps.set(driverId, Date.now());
              this.initializedSearches.delete(`driver_${driverId}`);
            }
          }
        });
      });
      console.log('✅ Real-time driver monitoring active');
    } catch (error) {
      console.error('❌ Error setting up driver monitor:', error);
    }
  }
  
  isDriverBlacklisted(driverId) {
    const normalizedDriverId = this.normalizePhone(driverId);
    
    if (this.cancelledDriverBlacklist.has(normalizedDriverId)) {
      const blacklistedAt = this.cancelledDriverBlacklist.get(normalizedDriverId);
      const timeSinceBlacklist = Date.now() - blacklistedAt;
      if (timeSinceBlacklist < this.BLACKLIST_DURATION) return true;
      this.cancelledDriverBlacklist.delete(normalizedDriverId);
      this.driverStopTimestamps.delete(normalizedDriverId);
    }
    return false;
  }
  
  addToBlacklist(driverId) {
    const normalizedDriverId = this.normalizePhone(driverId);
    this.cancelledDriverBlacklist.set(normalizedDriverId, Date.now());
    console.log(`📛 Added ${normalizedDriverId} to matching blacklist`);
    
    setTimeout(() => {
      if (this.cancelledDriverBlacklist.has(normalizedDriverId)) {
        this.cancelledDriverBlacklist.delete(normalizedDriverId);
        this.driverStopTimestamps.delete(normalizedDriverId);
        console.log(`✅ Auto-removed ${normalizedDriverId} from blacklist`);
      }
    }, this.BLACKLIST_DURATION + 5000);
  }
  
  async cancelOnlyProposedMatches(driverPhone, searchId) {
    try {
      const normalizedDriverPhone = this.normalizePhone(driverPhone);
      console.log(`🗑️ Cancelling only PROPOSED matches for ${normalizedDriverPhone}...`);
      
      const matchesQuery = this.firestoreService.db.collection('active_matches')
        .where('driverPhone', '==', normalizedDriverPhone)
        .where('status', '==', 'proposed');
      
      const matchesSnapshot = await matchesQuery.get();
      const batch = this.firestoreService.db.batch();
      
      matchesSnapshot.docs.forEach(doc => {
        const match = doc.data();
        if (searchId && match.searchId !== searchId) return;
        
        batch.update(doc.ref, {
          status: 'cancelled', 
          cancelledAt: this.getServerTimestamp(),
          cancellationReason: 'driver_stopped_search', 
          updatedAt: this.getServerTimestamp()
        });
        
        this.updateActiveRideForMatch(doc.id, 'cancelled', 'driver', 'driver_stopped_search');
        
        if (match.passengerId) {
          const normalizedPassengerId = this.normalizePhone(match.passengerId);
          const passengerRef = this.firestoreService.db.collection('active_searches_passenger').doc(normalizedPassengerId);
          batch.update(passengerRef, {
            matchId: null, 
            matchedWith: null, 
            matchStatus: null, 
            driver: null,
            status: 'searching', 
            lastUpdated: Date.now(), 
            cancellationReason: 'Driver stopped search'
          });
          this.initializedSearches.delete(`passenger_${normalizedPassengerId}`);
        }
      });
      
      if (matchesSnapshot.docs.length > 0) {
        await batch.commit();
        console.log(`✅ Cancelled ${matchesSnapshot.docs.length} proposed matches for ${normalizedDriverPhone}`);
      } else {
        console.log(`✅ No proposed matches to cancel for ${normalizedDriverPhone}`);
      }
    } catch (error) {
      console.error('❌ Error cancelling proposed matches:', error);
    }
  }
  
  async preserveAcceptedPassengers(driverPhone) {
    try {
      const normalizedDriverPhone = this.normalizePhone(driverPhone);
      console.log(`💾 Preserving accepted passengers for ${normalizedDriverPhone}...`);
      const driverRef = this.firestoreService.db.collection('active_searches_driver').doc(normalizedDriverPhone);
      const driverDoc = await driverRef.get();
      if (!driverDoc.exists) return [];
      
      const driverData = driverDoc.data();
      const capacity = driverData.capacity || 4;
      const preservedPassengers = [];
      
      for (let i = 1; i <= capacity; i++) {
        const fieldName = `passenger${i}`;
        if (driverData[fieldName] && driverData[fieldName].passengerId) {
          const passengerData = driverData[fieldName];
          if (passengerData.matchStatus === 'accepted') {
            preservedPassengers.push({ fieldName, passengerId: passengerData.passengerId, passengerData });
            console.log(`💾 Preserving accepted passenger ${passengerData.passengerId} in ${fieldName}`);
            
            const normalizedPassengerId = this.normalizePhone(passengerData.passengerId);
            const passengerRef = this.firestoreService.db.collection('active_searches_passenger').doc(normalizedPassengerId);
            await passengerRef.update({
              'driver.driverSearchStatus': 'searching',
              'driver.driverLastSearchStop': Date.now(),
              status: 'accepted', 
              lastUpdated: Date.now()
            });
            
            if (passengerData.matchId) {
              const matchRef = this.firestoreService.db.collection('active_matches').doc(passengerData.matchId);
              await matchRef.update({
                driverSearchStatus: 'searching',
                driverLastSearchStop: Date.now(),
                status: 'accepted', 
                updatedAt: this.getServerTimestamp()
              });
            }
          }
        }
      }
      
      console.log(`✅ Preserved ${preservedPassengers.length} accepted passengers for ${normalizedDriverPhone}`);
      return preservedPassengers;
    } catch (error) {
      console.error('❌ Error preserving accepted passengers:', error);
      return [];
    }
  }
  
  async cancelAllDriverMatches(driverPhone, searchId) {
    try {
      const normalizedDriverPhone = this.normalizePhone(driverPhone);
      console.log(`🗑️ Cancelling ALL matches for ${normalizedDriverPhone}...`);
      
      const matchesQuery = this.firestoreService.db.collection('active_matches')
        .where('driverPhone', '==', normalizedDriverPhone)
        .where('status', 'in', ['proposed', 'pending', 'accepted']);
      
      const matchesSnapshot = await matchesQuery.get();
      const batch = this.firestoreService.db.batch();
      
      matchesSnapshot.docs.forEach(doc => {
        const match = doc.data();
        if (searchId && match.searchId !== searchId) return;
        
        batch.update(doc.ref, {
          status: 'cancelled', 
          cancelledAt: this.getServerTimestamp(),
          cancellationReason: 'driver_stopped_search', 
          updatedAt: this.getServerTimestamp()
        });
        
        this.updateActiveRideForMatch(doc.id, 'cancelled', 'driver', 'driver_stopped_search');
        
        if (match.passengerId) {
          const normalizedPassengerId = this.normalizePhone(match.passengerId);
          const passengerRef = this.firestoreService.db.collection('active_searches_passenger').doc(normalizedPassengerId);
          batch.update(passengerRef, {
            matchId: null, 
            matchedWith: null, 
            matchStatus: null, 
            driver: null,
            status: 'searching', 
            lastUpdated: Date.now(), 
            cancellationReason: 'Driver stopped search'
          });
          this.initializedSearches.delete(`passenger_${normalizedPassengerId}`);
        }
      });
      
      if (matchesSnapshot.docs.length > 0) {
        await batch.commit();
        console.log(`✅ Cancelled ${matchesSnapshot.docs.length} active matches for ${normalizedDriverPhone}`);
      }
    } catch (error) {
      console.error('❌ Error cancelling driver matches:', error);
    }
  }
  
  async completeRide(matchId, driverId, passengerId) {
    try {
      const batch = this.firestoreService.db.batch();
      const now = this.getServerTimestamp();
      const matchRef = this.firestoreService.db.collection('active_matches').doc(matchId);
      
      const matchDoc = await matchRef.get();
      if (!matchDoc.exists) throw new Error('Match not found');
      const matchData = matchDoc.data();
      
      const normalizedDriverId = this.normalizePhone(driverId);
      const normalizedPassengerId = this.normalizePhone(passengerId);
      
      batch.update(matchRef, {
        status: 'completed', 
        completedAt: now, 
        updatedAt: now, 
        completedBy: 'driver',
      });
      
      await this.updateActiveRideForMatch(matchId, 'completed', 'driver', 'ride_completed', {
        paymentStatus: 'paid',
        actualFare: matchData.fare
      });
      
      const rideHistoryRef = this.firestoreService.db.collection('ride_history').doc();
      batch.set(rideHistoryRef, {
        matchId, 
        driverId: normalizedDriverId,
        passengerId: normalizedPassengerId,
        driverName: matchData.driverName,
        passengerName: matchData.passengerName, 
        pickupLocation: matchData.pickupLocation,
        destinationLocation: matchData.destinationLocation, 
        fare: matchData.fare,
        distance: matchData.distance, 
        duration: matchData.duration,
        passengerCount: matchData.passengerCount || 1, 
        vehicleInfo: matchData.vehicleInfo,
        startedAt: matchData.createdAt, 
        completedAt: now, 
        createdAt: now,
      });
      
      const driverStatsRef = this.firestoreService.db.collection('driver_stats').doc(normalizedDriverId);
      batch.set(driverStatsRef, {
        completedRides: this.FieldValue.increment(1),
        totalEarnings: this.FieldValue.increment(matchData.fare || 0),
        lastUpdated: now,
      }, { merge: true });
      
      const passengerStatsRef = this.firestoreService.db.collection('passenger_stats').doc(normalizedPassengerId);
      batch.set(passengerStatsRef, {
        completedRides: this.FieldValue.increment(1),
        lastRideAt: now, 
        lastUpdated: now,
      }, { merge: true });
      
      if (this.notificationService) {
        await this.notificationService.sendPushNotification(normalizedPassengerId, {
          title: 'Ride Completed',
          body: 'Your ride has been completed. Thank you for using our service!',
          type: 'ride_completed', 
          data: { matchId, driverId: normalizedDriverId, fare: matchData.fare },
        });
      }
      
      await batch.commit();
      
      return { 
        success: true, 
        message: 'Ride completed successfully', 
        matchId, 
        fare: matchData.fare 
      };
    } catch (error) {
      console.error('Error completing ride:', error);
      throw error;
    }
  }
  
  async handleCompleteRide(data) {
    const { matchId, driverId, passengerId, searchId } = data;
    try {
      const result = await this.completeRide(matchId, driverId, passengerId);
      await this.stopTracking(passengerId, 'ride_completed');
      await this.checkAndUpdateSearchStatus(searchId, driverId);
      return result;
    } catch (error) {
      throw new Error(`Complete ride failed: ${error.message}`);
    }
  }
  
  async checkAndUpdateSearchStatus(searchId, driverId) {
    const normalizedDriverId = this.normalizePhone(driverId);
    const searchRef = this.firestoreService.db.collection('driver_searches').doc(searchId);
    const searchDoc = await searchRef.get();
    if (searchDoc.exists) {
      const searchData = searchDoc.data();
      const capacity = searchData.capacity || 4;
      const completed = searchData.completedPassengers || 0;
      if (completed >= capacity) {
        await searchRef.update({
          status: 'completed', 
          endedAt: this.getServerTimestamp(), 
          allPassengersCompleted: true,
        });
        if (this.notificationService) {
          await this.notificationService.sendPushNotification(normalizedDriverId, {
            title: 'Search Complete', 
            body: 'All passengers have completed their rides!', 
            type: 'search_completed',
          });
        }
      }
    }
  }
  
  async stopTracking(userId, reason) {
    try {
      const normalizedUserId = this.normalizePhone(userId);
      console.log(`🛑 Stopping tracking for ${normalizedUserId} - reason: ${reason}`);
      if (this.locationService) await this.locationService.stopAllSessionsForUser(normalizedUserId);
      return { success: true, message: `Tracking stopped: ${reason}` };
    } catch (error) {
      console.error('Error stopping tracking:', error);
      return { success: false, error: error.message };
    }
  }
  
  async handleWebSocketMessage(userId, message) {
    try {
      const normalizedUserId = this.normalizePhone(userId);
      console.log(`📨 ${normalizedUserId}: ${message.type}`);
      const data = message.data;
      
      switch (message.type) {
        case 'ACCEPT_MATCH':
          if (normalizedUserId !== this.normalizePhone(data.passengerId) && 
              normalizedUserId !== this.normalizePhone(data.driverId)) {
            return { success: false, error: 'Unauthorized' };
          }
          const userType = normalizedUserId === this.normalizePhone(data.driverId) ? 'driver' : 'passenger';
          const result = await this.acceptIndividualMatch(data.matchId, normalizedUserId, userType);
          return { 
            success: true, 
            matchId: data.matchId, 
            status: 'accepted', 
            acceptedBy: userType, 
            ...result 
          };
          
        case 'DECLINE_MATCH':
          if (normalizedUserId !== this.normalizePhone(data.passengerId) && 
              normalizedUserId !== this.normalizePhone(data.driverId)) {
            return { success: false, error: 'Unauthorized' };
          }
          const uType = normalizedUserId === this.normalizePhone(data.driverId) ? 'driver' : 'passenger';
          await this.declineIndividualMatch(data.matchId, normalizedUserId, uType, data.reason || 'declined');
          return { 
            success: true, 
            matchId: data.matchId, 
            status: 'declined', 
            declinedBy: uType, 
            reason: data.reason 
          };
          
        case 'CANCEL_MATCH':
          if (normalizedUserId !== this.normalizePhone(data.passengerId) && 
              normalizedUserId !== this.normalizePhone(data.driverId)) {
            return { success: false, error: 'Unauthorized' };
          }
          const cancelUserType = normalizedUserId === this.normalizePhone(data.driverId) ? 'driver' : 'passenger';
          const cancelResult = await this.cancelAcceptedMatch(
            data.matchId, 
            normalizedUserId, 
            cancelUserType, 
            data.reason || 'cancelled'
          );
          return { 
            success: true, 
            matchId: data.matchId, 
            status: 'cancelled', 
            cancelledBy: cancelUserType, 
            ...cancelResult 
          };
          
        case 'COMPLETE_RIDE':
          if (normalizedUserId !== this.normalizePhone(data.driverId)) {
            return { success: false, error: 'Unauthorized' };
          }
          const completeResult = await this.handleCompleteRide(data);
          return { success: true, ...completeResult };
          
        case 'GET_MATCH_STATUS':
          const matchDoc = await this.firestoreService.db.collection('active_matches').doc(data.matchId).get();
          if (!matchDoc.exists) return { success: false, error: 'Match not found' };
          const match = matchDoc.data();
          
          if (normalizedUserId !== this.normalizePhone(match.driverPhone) && 
              normalizedUserId !== this.normalizePhone(match.passengerPhone)) {
            return { success: false, error: 'Unauthorized' };
          }
          
          let driverInfo = null, passengerInfo = null;
          if (match.driverPhone) {
            const driverDoc = await this.firestoreService.db.collection('active_searches_driver').doc(match.driverPhone).get();
            if (driverDoc.exists) driverInfo = driverDoc.data();
          }
          if (match.passengerPhone) {
            const passengerDoc = await this.firestoreService.db.collection('active_searches_passenger').doc(match.passengerPhone).get();
            if (passengerDoc.exists) passengerInfo = passengerDoc.data();
          }
          
          return { 
            success: true, 
            match: { 
              ...match, 
              driverInfo, 
              passengerInfo, 
              serverTime: new Date().toISOString() 
            } 
          };
          
        case 'GET_ACTIVE_RIDE':
          const rideUserType = data.userType || 'passenger';
          if (rideUserType === 'driver') {
            return await this.getActiveRideForDriver(normalizedUserId);
          } else {
            return await this.getActiveRideForPassenger(normalizedUserId);
          }
          
        case 'GET_ALL_ACTIVE_PASSENGERS':
          if (data.userType !== 'driver') {
            return { success: false, error: 'Only drivers can get active passengers' };
          }
          return await this.getAllActivePassengersForDriver(normalizedUserId);
          
        case 'UPDATE_RIDE_STATUS':
          const { rideId, status, additionalData } = data;
          const statusUserType = this.normalizePhone(userId) === this.normalizePhone(data.driverPhone) ? 'driver' : 'passenger';
          return await this.updateRideStatus(rideId, status, statusUserType, additionalData);
          
        case 'UPDATE_RIDE_LOCATION':
          const locationData = data.location;
          const locationUserType = data.userType;
          if (locationUserType === 'driver') {
            return await this.updateDriverLocationInRide(userId, locationData);
          } else {
            return await this.updatePassengerLocationInRide(userId, locationData);
          }
          
        default:
          return { success: false, error: 'Unhandled message type' };
      }
    } catch (error) {
      console.error('❌ WebSocket error:', error);
      return { success: false, error: error.message };
    }
  }
  
  async initialize() {
    if (this.isInitialized) return;
    console.log('🔧 Initializing Matching Service...');
    if (this.firestoreService.startBatchProcessor) this.firestoreService.startBatchProcessor();
    if (this.firestoreService.flushWrites) await this.firestoreService.flushWrites();
    await new Promise(resolve => setTimeout(resolve, 2000));
    this.isInitialized = true;
    console.log('✅ Matching Service initialized');
  }
  
  async start() {
    console.log('\n🚀 Starting MATCHING SERVICE...');
    await this.initialize();
    
    console.log('🧹 Cleaning duplicate passengers...');
    const driversSnapshot = await this.firestoreService.db.collection('active_searches_driver').get();
    for (const driverDoc of driversSnapshot.docs) await this.fixDriverDuplicatePassengers(driverDoc.id);
    
    setTimeout(() => {
      console.log('⚡ First matching cycle in 3 seconds...');
      this.performMatchingCycle();
    }, 3000);
    
    this.matchingIntervalId = setInterval(() => this.performMatchingCycle(), TIMEOUTS.MATCHING_INTERVAL);
    this.cleanupIntervalId = setInterval(() => this.cleanupExpiredSearches(), 300000);
    if (this.AUTO_REPAIR_MATCHES) this.repairIntervalId = setInterval(() => this.repairBrokenMatches(), 30000);
    
    this.logStatsPeriodically();
    console.log(`✅ Service started with ${TIMEOUTS.MATCHING_INTERVAL/1000}s cycles`);
    
    setInterval(() => {
      const cleaned = this.globalLocationService.cleanupStaleConnections();
      if (cleaned > 0) {
        console.log(`🧹 Cleaned ${cleaned} stale connections`);
      }
      
      const stats = this.globalLocationService.getStats();
      console.log('🌍 Location Service Stats:', {
        connections: stats.totalConnections,
        drivers: stats.totalDrivers,
        passengers: stats.totalPassengers,
        matches: stats.activeMatchSessions
      });
    }, 60000);
    
    console.log('✅ Global location service started');
  }
  
  stop() {
    console.log('\n🛑 Stopping Matching Service...');
    ['matchingIntervalId', 'cleanupIntervalId', 'repairIntervalId', 'statsIntervalId', 'autoStopCheckIntervalId', 'cleanupFullDriversIntervalId', 'rideCleanupIntervalId'].forEach(id => {
      if (this[id]) clearInterval(this[id]);
    });
    if (this.locationService?.cleanupAll) this.locationService.cleanupAll();
  }
  
  async performMatchingCycle() {
    this.cycleCount++;
    const cycleStart = Date.now();
    console.log(`\n📊 CYCLE #${this.cycleCount} at ${new Date().toLocaleTimeString()}`);
    
    try {
      const clearedCount = await this.clearExpiredMatchProposals();
      if (clearedCount > 0) console.log(`🗑️ Freed ${clearedCount} users`);
      
      if (this.firestoreService.flushWrites) await this.firestoreService.flushWrites();
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const drivers = await this.getActiveDriversDirect();
      const passengers = await this.getActivePassengersDirect();
      
      console.log(`📊 Pool: ${drivers.length} drivers vs ${passengers.length} passengers`);
      
      await this.checkAndInitializeNewSearches(drivers, passengers);
      
      if (drivers.length === 0 || passengers.length === 0) {
        console.log('⚠️ No matches possible');
        console.log(`⏱️ Cycle ${Date.now() - cycleStart}ms`);
        return;
      }
      
      let totalMatchesCreated = 0;
      
      if (this.config.activeConfig.ALGORITHM.USE_BATCH_MATCHING) {
        totalMatchesCreated = await this.batchMatchWithConfig(drivers, passengers);
      } else {
        totalMatchesCreated = await this.individualMatchWithConfig(drivers, passengers);
      }
      
      this.matchAttempts += totalMatchesCreated;
      console.log(`📈 Created ${totalMatchesCreated} matches`);
      console.log(`⏱️ Cycle ${Date.now() - cycleStart}ms`);
    } catch (error) {
      console.error('❌ Matching cycle error:', error.message);
      this.failedMatches++;
    }
  }
  
  async batchMatchWithConfig(drivers, passengers) {
    console.log('🚀 Using BATCH matching strategy');
    
    const unavailablePassengerIds = new Set();
    let totalMatches = 0;
    
    const eligibleDrivers = drivers.filter(driver => this.isDriverEligibleForMatching(driver));
    const eligiblePassengers = passengers.filter(passenger =>
      !unavailablePassengerIds.has(this.normalizePhone(this.getUserId(passenger, 'passenger'))) &&
      passenger.matchStatus !== 'accepted' && passenger.matchStatus !== 'proposed'
    );
    
    console.log(`✅ Eligible: ${eligibleDrivers.length} drivers, ${eligiblePassengers.length} passengers`);
    
    if (this.config.shouldForceMatch()) {
      console.log('🔥 FORCE MATCHING MODE: Matching everyone possible');
      return await this.forceMatchAll(eligibleDrivers, eligiblePassengers, unavailablePassengerIds);
    }
    
    const driversWithoutProposals = eligibleDrivers.filter(driver => !this.checkIfDriverHasProposedPassenger(driver));
    console.log(`🎯 Drivers without proposals: ${driversWithoutProposals.length}/${eligibleDrivers.length}`);
    
    for (const driver of driversWithoutProposals) {
      const driverId = this.normalizePhone(this.getUserId(driver, 'driver'));
      if (this.fullDrivers.has(driverId)) {
        console.log(`⏭️ Skipping ${driverId} - driver is full`);
        continue;
      }
      
      if (await this.shouldStopDriverSearch(driverId, driver)) continue;
      
      const matches = await this.findBestPassengersForDriver(driver, eligiblePassengers, unavailablePassengerIds);
      
      if (matches.length > 0) {
        const bestMatch = matches[0];
        if (await this.createConfigBasedMatch(driver, bestMatch.passenger, bestMatch.field)) {
          totalMatches++;
          unavailablePassengerIds.add(this.normalizePhone(bestMatch.passengerId));
          console.log(`🚫 Stopped matching for ${driverId} - waiting for acceptance`);
        }
      }
      
      if (totalMatches >= this.config.activeConfig.MATCHING_STRATEGY.MAX_MATCHES_PER_CYCLE) {
        console.log(`⏹️ Reached max matches per cycle: ${totalMatches}`);
        break;
      }
    }
    
    return totalMatches;
  }
  
  async individualMatchWithConfig(drivers, passengers) {
    console.log('🚀 Using INDIVIDUAL matching strategy');
    
    const unavailablePassengerIds = new Set();
    let totalMatches = 0;
    
    for (const passenger of passengers) {
      const passengerId = this.normalizePhone(this.getUserId(passenger, 'passenger'));
      if (passenger.matchStatus === 'accepted' || passenger.matchStatus === 'proposed') {
        unavailablePassengerIds.add(passengerId);
      }
    }
    
    const driversWithoutProposals = drivers.filter(driver => !this.checkIfDriverHasProposedPassenger(driver));
    console.log(`📊 ${drivers.length} total drivers, ${driversWithoutProposals.length} without existing proposals`);
    
    for (const driver of driversWithoutProposals) {
      const driverId = this.normalizePhone(this.getUserId(driver, 'driver'));
      if (this.fullDrivers.has(driverId)) {
        console.log(`⏭️ Skipping ${driverId} - driver is full`);
        continue;
      }
      
      if (await this.shouldStopDriverSearch(driverId, driver)) {
        console.log(`⏭️ Skipping ${driverId} - search stopped`);
        continue;
      }
      
      if (['completed', 'cancelled', 'expired'].includes(driver.status)) {
        console.log(`🚫 Skipping ${driverId} - ${driver.status}`);
        continue;
      }
      
      const matchesForThisDriver = await this.fillDriverWithPassengers(driver, passengers, unavailablePassengerIds);
      totalMatches += matchesForThisDriver;
      
      if (matchesForThisDriver > 0) {
        console.log(`🚗 ${driverId}: +${matchesForThisDriver} passenger(s)`);
        await this.checkAndAutoStopDriverIfNeeded(driverId, driver.currentLocation);
        
        if (matchesForThisDriver > 0 && this.ONE_PASSENGER_AT_A_TIME) {
          console.log(`🚫 Pausing further matches for ${driverId} - waiting for acceptance`);
        }
      }
    }
    
    return totalMatches;
  }
  
  isDriverEligibleForMatching(driver) {
    const driverId = this.normalizePhone(this.getUserId(driver, 'driver'));
    
    if (this.isDriverBlacklisted(driverId)) return false;
    if (this.fullDrivers.has(driverId)) return false;
    if (['completed', 'cancelled', 'expired'].includes(driver.status)) return false;
    
    const capacity = driver.capacity || this.config.activeConfig.CAPACITY.DEFAULT_CAPACITY;
    const currentPassengers = driver.currentPassengers || 0;
    if (currentPassengers >= capacity) return false;
    
    return true;
  }
  
  async shouldStopDriverSearch(driverId, driver) {
    const autoStopConditions = this.config.getAutoStopConditions();
    
    if (autoStopConditions.ARRIVED_AT_DESTINATION) {
      const hasArrived = await this.checkAndAutoStopDriverIfNeeded(driverId, driver.currentLocation);
      if (hasArrived) return true;
    }
    
    if (autoStopConditions.SEATS_FULL) {
      const capacity = driver.capacity || this.config.activeConfig.CAPACITY.DEFAULT_CAPACITY;
      const currentPassengers = driver.currentPassengers || 0;
      if (currentPassengers >= capacity) return true;
    }
    
    return false;
  }
  
  async findBestPassengersForDriver(driver, passengers, unavailablePassengerIds) {
    const driverId = this.normalizePhone(this.getUserId(driver, 'driver'));
    const capacity = driver.capacity || this.config.activeConfig.CAPACITY.DEFAULT_CAPACITY;
    
    const occupiedFields = [], passengerIdsInDriver = new Set();
    let currentPassengerCount = 0;
    
    for (let i = 1; i <= capacity; i++) {
      const fieldName = `passenger${i}`;
      if (driver[fieldName] && driver[fieldName].passengerId) {
        const passengerId = this.normalizePhone(driver[fieldName].passengerId);
        if (!passengerIdsInDriver.has(passengerId)) {
          passengerIdsInDriver.add(passengerId);
          occupiedFields.push(fieldName);
          currentPassengerCount += driver[fieldName].passengerCount || 1;
        }
      }
    }
    
    const availableSeats = capacity - currentPassengerCount;
    const availableFields = [];
    for (let i = 1; i <= capacity; i++) {
      const fieldName = `passenger${i}`;
      if (!occupiedFields.includes(fieldName)) availableFields.push(fieldName);
    }
    
    if (availableSeats <= 0 || availableFields.length === 0) return [];
    
    const scoredPassengers = [];
    for (const passenger of passengers) {
      const passengerId = this.normalizePhone(this.getUserId(passenger, 'passenger'));
      if (unavailablePassengerIds.has(passengerId) || passengerIdsInDriver.has(passengerId)) continue;
      
      const score = await this.calculateMatchScore(driver, passenger);
      if (score.totalScore >= this.config.activeConfig.ROUTE_THRESHOLDS.MIN_COMPATIBILITY_SCORE) {
        scoredPassengers.push({ 
          passenger, 
          passengerId, 
          passengerCount: passenger.passengerCount || 1, 
          score: score.totalScore, 
          details: score 
        });
      }
    }
    
    scoredPassengers.sort((a, b) => b.score - a.score);
    
    if (scoredPassengers.length > 0 && availableFields.length > 0) {
      const bestPassenger = scoredPassengers[0];
      return [{ 
        passenger: bestPassenger.passenger, 
        passengerId: bestPassenger.passengerId, 
        field: availableFields[0], 
        score: bestPassenger.score, 
        details: bestPassenger.details 
      }];
    }
    
    return [];
  }
  
  async calculateMatchScore(driver, passenger) {
    const config = this.config.getScoringConfig();
    const driverId = this.normalizePhone(this.getUserId(driver, 'driver'));
    const passengerId = this.normalizePhone(this.getUserId(passenger, 'passenger'));
    
    const driverRoute = { 
      pickup: driver.pickupLocation || driver.currentLocation, 
      destination: driver.destinationLocation 
    };
    const passengerRoute = { 
      pickup: passenger.pickupLocation || passenger.currentLocation, 
      destination: passenger.destinationLocation 
    };
    const routeCompatibility = this.calculateRouteCompatibility(driverRoute, passengerRoute);
    const routeScore = routeCompatibility.score;
    
    const passengerCount = passenger.passengerCount || 1;
    const driverCapacity = driver.capacity || config.capacity.DEFAULT_CAPACITY;
    const currentPassengers = driver.currentPassengers || 0;
    const availableSeats = driverCapacity - currentPassengers;
    const seatFitScore = passengerCount <= availableSeats ? 100 : 0;
    
    const pickupDistance = driver.currentLocation ? parseFloat(this.calculateDistance(
      driver.currentLocation.lat, driver.currentLocation.lng,
      passengerRoute.pickup.lat, passengerRoute.pickup.lng
    )) : 0;
    const proximityScore = this.config.calculateProximityScore(pickupDistance);
    
    const waitingTime = passenger.searchStartTime ? Date.now() - passenger.searchStartTime : 0;
    const waitingScore = this.config.calculateWaitingTimeScore(waitingTime);
    
    const totalScore = Math.round(
      routeScore * config.weights.ROUTE_COMPATIBILITY +
      seatFitScore * config.weights.SEAT_FIT +
      proximityScore * config.weights.PROXIMITY_TO_DRIVER +
      waitingScore * config.weights.WAITING_TIME
    );
    
    return {
      totalScore,
      breakdown: { routeScore, seatFitScore, proximityScore, waitingScore, pickupDistance },
      compatibility: routeCompatibility,
      isCompatible: this.config.isRouteCompatible(routeCompatibility),
    };
  }
  
  async createConfigBasedMatch(driver, passenger, passengerField) {
    try {
      const score = await this.calculateMatchScore(driver, passenger);
      console.log(`🤝 Creating match with score: ${score.totalScore}`);
      console.log(`   Route: ${score.breakdown.routeScore}, Proximity: ${score.breakdown.proximityScore}`);
      console.log(`   Pickup distance: ${score.breakdown.pickupDistance}km`);
      return await this.createIndividualPassengerMatch(driver, passenger, passengerField);
    } catch (error) {
      console.error('❌ Error in config-based match:', error);
      return false;
    }
  }
  
  async forceMatchAll(drivers, passengers, unavailablePassengerIds) {
    let totalMatches = 0;
    
    for (const driver of drivers) {
      const driverId = this.normalizePhone(this.getUserId(driver, 'driver'));
      const capacity = driver.capacity || this.config.activeConfig.CAPACITY.DEFAULT_CAPACITY;
      
      const currentPassengerIds = new Set();
      for (let i = 1; i <= capacity; i++) {
        const fieldName = `passenger${i}`;
        if (driver[fieldName] && driver[fieldName].passengerId) {
          currentPassengerIds.add(this.normalizePhone(driver[fieldName].passengerId));
        }
      }
      
      const currentPassengerCount = currentPassengerIds.size;
      const availableSeats = capacity - currentPassengerCount;
      if (availableSeats <= 0) continue;
      
      const availableFields = [];
      for (let i = 1; i <= capacity; i++) {
        const fieldName = `passenger${i}`;
        if (!driver[fieldName] || !driver[fieldName].passengerId) availableFields.push(fieldName);
      }
      
      let fieldIndex = 0;
      for (const passenger of passengers) {
        if (fieldIndex >= availableFields.length) break;
        const passengerId = this.normalizePhone(this.getUserId(passenger, 'passenger'));
        if (unavailablePassengerIds.has(passengerId) || currentPassengerIds.has(passengerId)) continue;
        
        if (await this.createIndividualPassengerMatch(driver, passenger, availableFields[fieldIndex])) {
          totalMatches++;
          unavailablePassengerIds.add(passengerId);
          fieldIndex++;
          
          if (this.ONE_PASSENGER_AT_A_TIME && fieldIndex >= 1) break;
        }
      }
    }
    
    return totalMatches;
  }
  
  async fillDriverWithPassengers(driver, allPassengers, unavailablePassengerIds) {
    const driverId = this.normalizePhone(this.getUserId(driver, 'driver'));
    const capacity = driver.capacity || 4;
    
    console.log(`\n🚗 Processing ${driverId}`);
    
    if (this.ONE_PASSENGER_AT_A_TIME && this.checkIfDriverHasProposedPassenger(driver)) {
      console.log(`   ⏭️ Skipping ${driverId} - already has a proposed passenger waiting for acceptance`);
      return 0;
    }
    
    const occupiedFields = [], passengerIdsInDriver = new Set();
    let currentPassengerCount = 0;
    
    for (let i = 1; i <= capacity; i++) {
      const fieldName = `passenger${i}`;
      if (driver[fieldName] && driver[fieldName].passengerId) {
        const passengerId = this.normalizePhone(driver[fieldName].passengerId);
        if (!passengerIdsInDriver.has(passengerId)) {
          passengerIdsInDriver.add(passengerId);
          occupiedFields.push(fieldName);
          currentPassengerCount += driver[fieldName].passengerCount || 1;
          console.log(`   - ${fieldName}: ${passengerId} (${driver[fieldName].matchStatus || 'none'})`);
        } else {
          console.log(`   ⚠️ Duplicate ${passengerId} in ${fieldName}`);
        }
      }
    }
    
    const availableSeats = capacity - currentPassengerCount;
    console.log(`   Current: ${currentPassengerCount}/${capacity} | Available: ${availableSeats}`);
    
    if (availableSeats <= 0) {
      console.log(`   ⏭️ ${driverId} is full`);
      this.fullDrivers.add(driverId);
      return 0;
    }
    
    let matchesCreated = 0, remainingSeats = availableSeats;
    const availableFields = [];
    for (let i = 1; i <= capacity; i++) {
      const fieldName = `passenger${i}`;
      if (!occupiedFields.includes(fieldName)) availableFields.push(fieldName);
    }
    
    console.log(`   Available fields: ${availableFields.join(', ')}`);
    if (availableFields.length === 0) {
      console.log(`   ⚠️ No available fields for ${driverId}`);
      return 0;
    }
    
    const MAX_PASSENGERS_TO_PROPOSE = this.ONE_PASSENGER_AT_A_TIME ? 1 : availableFields.length;
    
    for (const passenger of allPassengers) {
      if (matchesCreated >= MAX_PASSENGERS_TO_PROPOSE || remainingSeats <= 0) break;
      
      const passengerId = this.normalizePhone(this.getUserId(passenger, 'passenger'));
      if (unavailablePassengerIds.has(passengerId) || passengerIdsInDriver.has(passengerId)) {
        console.log(`   ⏭️ Skipping ${passengerId} - already matched/in driver`);
        continue;
      }
      
      if (passenger.matchStatus === 'accepted' || passenger.matchStatus === 'proposed') {
        console.log(`   ⏭️ Skipping ${passengerId} - ${passenger.matchStatus}`);
        continue;
      }
      
      const passengerCount = passenger.passengerCount || passenger.numberOfPassengers || 1;
      
      if (remainingSeats >= passengerCount) {
        const nextField = availableFields[matchesCreated];
        console.log(`   ✅ Matching ${passengerId} to ${nextField} (${passengerCount} seats)`);
        
        if (await this.createIndividualPassengerMatch(driver, passenger, nextField)) {
          matchesCreated++;
          remainingSeats -= passengerCount;
          passengerIdsInDriver.add(passengerId);
          unavailablePassengerIds.add(passengerId);
          console.log(`   ✅ Added ${passengerId} to ${nextField}, Remaining seats: ${remainingSeats}`);
          
          if (this.ONE_PASSENGER_AT_A_TIME) {
            console.log(`   🚫 Stopping further matches for ${driverId} - waiting for acceptance`);
            break;
          }
        }
      } else {
        console.log(`   ❌ Not enough seats for ${passengerId}: needs ${passengerCount}, only ${remainingSeats} left`);
      }
    }
    
    console.log(`   📊 Added ${matchesCreated} passenger(s) to ${driverId}`);
    
    if (remainingSeats <= 0) {
      this.fullDrivers.add(driverId);
      console.log(`   📝 Added ${driverId} to full drivers list`);
    }
    
    return matchesCreated;
  }
  
  async getActiveDriversDirect() {
    try {
      console.log('🔍 Fetching ACTIVE drivers (with blacklist check)...');
      
      const driversSnapshot = await this.firestoreService.db.collection('active_searches_driver')
        .where('status', 'in', ['searching', 'matched', 'accepted', 'proposed']).get({ source: 'server' });
      
      const drivers = [], now = Date.now();
      
      driversSnapshot.forEach(doc => {
        const driverData = doc.data();
        const driverId = doc.id;
        
        if (this.isDriverBlacklisted(driverId)) {
          console.log(`   🚫 Skipping ${driverId} - BLACKLISTED`);
          return;
        }
        
        const stopTime = this.driverStopTimestamps.get(driverId);
        if (stopTime && (now - stopTime < 30000)) {
          console.log(`   🚫 Skipping ${driverId} - recently stopped (${Math.round((now - stopTime)/1000)}s ago)`);
          return;
        }
        
        if (driverData.status === 'cancelled' || driverData.status === 'stopped') {
          console.log(`   🚫 Skipping ${driverId} - status: ${driverData.status}`);
          this.addToBlacklist(driverId);
          return;
        }
        
        const passengerIds = new Set();
        let totalPassengerCount = 0;
        const capacity = driverData.capacity || 4;
        
        for (let i = 1; i <= capacity; i++) {
          const fieldName = `passenger${i}`;
          if (driverData[fieldName] && driverData[fieldName].passengerId) {
            const passengerId = this.normalizePhone(driverData[fieldName].passengerId);
            if (!passengerIds.has(passengerId)) {
              passengerIds.add(passengerId);
              totalPassengerCount += driverData[fieldName].passengerCount || 1;
            }
          }
        }
        
        drivers.push({
          ...driverData, 
          id: doc.id, 
          driverId: doc.id,
          userId: this.normalizePhone(this.getUserId(driverData, 'driver')),
          currentPassengers: totalPassengerCount, 
          capacity,
          availableSeats: capacity - totalPassengerCount
        });
      });
      
      console.log(`✅ Loaded ${drivers.length} active drivers (${this.cancelledDriverBlacklist.size} blacklisted, ${this.fullDrivers.size} full)`);
      return drivers;
    } catch (error) {
      console.error('❌ Error loading drivers:', error.message);
      return [];
    }
  }
  
  async getActivePassengersDirect() {
    try {
      console.log('🔍 Fetching active passengers...');
      
      const passengersSnapshot = await this.firestoreService.db.collection('active_searches_passenger')
        .where('status', 'in', ['searching', 'matched', 'accepted', 'proposed']).get();
      
      const passengers = [];
      passengersSnapshot.forEach(doc => {
        const passengerData = doc.data();
        if (['completed', 'cancelled', 'expired'].includes(passengerData.status)) return;
        
        passengers.push({
          ...passengerData, 
          id: doc.id, 
          passengerId: doc.id,
          userId: this.normalizePhone(this.getUserId(passengerData, 'passenger')),
          passengerCount: passengerData.passengerCount || passengerData.numberOfPassengers || 1
        });
      });
      
      console.log(`✅ Loaded ${passengers.length} passengers`);
      return passengers;
    } catch (error) {
      console.error('❌ Error loading passengers:', error.message);
      return [];
    }
  }
  
  async createIndividualPassengerMatch(driver, passenger, passengerField) {
    try {
      const matchId = `match_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const driverPhone = this.normalizePhone(this.getUserId(driver, 'driver'));
      const passengerPhone = this.normalizePhone(this.getUserId(passenger, 'passenger'));
      
      if (!driverPhone || !passengerPhone) {
        console.error('❌ Missing driverPhone or passengerPhone');
        return false;
      }
      
      const capacity = driver.capacity || 4;
      const passengerIdsInDriver = new Set();
      for (let i = 1; i <= capacity; i++) {
        const fieldName = `passenger${i}`;
        if (driver[fieldName] && driver[fieldName].passengerId) {
          passengerIdsInDriver.add(this.normalizePhone(driver[fieldName].passengerId));
        }
      }
      
      if (passengerIdsInDriver.has(passengerPhone)) {
        console.log(`⚠️ Passenger ${passengerPhone} already in driver, skipping`);
        return false;
      }
      
      this.activeMatchIds.add(matchId);
      
      const passengerCount = passenger.passengerCount || passenger.numberOfPassengers || 1;
      const currentUniquePassengers = passengerIdsInDriver.size;
      const newCurrentPassengers = currentUniquePassengers + passengerCount;
      const newAvailableSeats = capacity - newCurrentPassengers;
      
      console.log(`🔧 Creating match for ${passengerPhone}, Driver: ${driverPhone}, Field: ${passengerField}`);
      
      const pickup = this.extractLocation(passenger, 'pickup');
      const destination = this.extractLocation(passenger, 'destination');
      
      const driverRoute = { 
        pickup: driver.pickupLocation || driver.currentLocation, 
        destination: driver.destinationLocation 
      };
      const passengerRoute = { 
        pickup: passenger.pickupLocation || passenger.currentLocation, 
        destination: passenger.destinationLocation 
      };
      const compatibility = this.calculateRouteCompatibility(driverRoute, passengerRoute);
      
      const passengerData = {
        passengerId: passengerPhone, 
        passengerName: passenger.passengerName, 
        passengerPhone: passengerPhone,
        passengerPhotoUrl: passenger.passengerPhotoUrl, 
        passengerCount,
        pickupLocation: pickup.loc, 
        pickupName: pickup.name,
        destinationLocation: destination.loc, 
        destinationName: destination.name,
        estimatedFare: passenger.estimatedFare, 
        routePoints: passenger.routePoints || [],
        addedAt: new Date().toISOString(), 
        matchId, 
        matchStatus: 'proposed',
        routeCompatibilityScore: compatibility.score, 
        pickupDistance: compatibility.pickupDistance
      };
      
      const matchData = {
        matchId, 
        driverPhone,
        passengerPhone,
        driverId: driverPhone,
        passengerId: passengerPhone,
        passengerField,
        driverName: driver.driverName || 'Driver', 
        driverPhone: driverPhone,
        driverPhotoUrl: driver.driverPhotoUrl || '', 
        passengerName: passenger.passengerName || 'Passenger',
        passengerPhone: passengerPhone, 
        passengerPhotoUrl: passenger.passengerPhotoUrl || '',
        passengerCount, 
        driverCurrentPassengers: newCurrentPassengers,
        driverCapacity: capacity, 
        driverAvailableSeats: newAvailableSeats,
        pickupLocation: pickup.loc, 
        pickupName: pickup.name,
        pickupAddress: passenger.pickup?.address || pickup.name,
        destinationLocation: destination.loc, 
        destinationName: destination.name,
        destinationAddress: passenger.dropoff?.address || destination.name,
        estimatedFare: passenger.estimatedFare || driver.estimatedFare || 500,
        status: 'proposed', 
        matchType: 'INDIVIDUAL_PASSENGER',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + TIMEOUTS.MATCH_PROPOSAL).toISOString(),
        testMode: this.config.activeConfig.FORCE_TEST_MODE,
        routeCompatibilityScore: compatibility.score, 
        pickupDistance: compatibility.pickupDistance,
        directionSimilarity: compatibility.directionSimilarity,
        matchingAlgorithm: this.config.currentProfile
      };
      
      await this.firestoreService.db.collection('active_matches').doc(matchId).set(matchData, { merge: true });
      
      await this.firestoreService.db.collection('active_searches_driver').doc(driverPhone).update({
        [passengerField]: passengerData, 
        currentPassengers: newCurrentPassengers,
        availableSeats: newAvailableSeats, 
        lastUpdated: Date.now(), 
        status: 'matched'
      });
      
      await this.firestoreService.db.collection('active_searches_passenger').doc(passengerPhone).update({
        matchId, 
        matchedWith: driverPhone, 
        matchStatus: 'proposed', 
        matchProposedAt: new Date(),
        driver: {
          driverId: driverPhone, 
          driverName: driver.driverName, 
          driverPhone: driverPhone,
          driverPhotoUrl: driver.driverPhotoUrl, 
          driverRating: driver.driverRating,
          vehicleInfo: driver.vehicleInfo || {}, 
          currentPassengers: newCurrentPassengers,
          availableSeats: newAvailableSeats, 
          capacity, 
          passengerField
        },
        lastUpdated: Date.now(), 
        status: 'matched'
      });
      
      this.initializedSearches.delete(`passenger_${passengerPhone}`);
      
      if (this.websocketServer) {
        if (this.websocketServer.handleMatchFoundNotification) {
          await this.websocketServer.handleMatchFoundNotification(driverPhone, { 
            matchId, 
            driverId: driverPhone, 
            passengerId: passengerPhone, 
            passengerField 
          });
        }
        
        await this.websocketServer.sendToUser(driverPhone, {
          type: 'SEARCH_STOPPED', 
          data: {
            reason: 'match_found', 
            matchId, 
            passengerId: passengerPhone, 
            timestamp: Date.now(),
            message: 'Search stopped - Passenger found!', 
            shouldOpenMatchScreen: true
          }
        });
        
        await this.websocketServer.sendToUser(passengerPhone, {
          type: 'SEARCH_STOPPED', 
          data: {
            reason: 'match_found', 
            matchId, 
            driverId: driverPhone, 
            timestamp: Date.now(),
            message: 'Search stopped - Driver found!', 
            shouldOpenMatchScreen: true
          }
        });
      } else if (this.websocketServer?.sendToUser) {
        await this.sendIndividualMatchNotification(matchData);
      }
      
      setTimeout(async () => {
        await this.expireIndividualMatch(matchId, driverPhone, passengerPhone, passengerField);
        this.activeMatchIds.delete(matchId);
      }, TIMEOUTS.MATCH_PROPOSAL);
      
      this.successfulMatches++;
      return true;
    } catch (error) {
      console.error(`❌ ERROR creating match: ${error.message}`);
      this.failedMatches++;
      return false;
    }
  }
  
  // MODIFIED: When match is accepted
  async acceptIndividualMatch(matchId, acceptedByUserId, userType) {
    try {
      console.log(`\n✅ ${userType} ${acceptedByUserId} accepting ${matchId}`);
      
      const matchDoc = await this.firestoreService.db.collection('active_matches').doc(matchId).get();
      if (!matchDoc.exists) throw new Error('Match not found');
      
      const match = matchDoc.data();
      const isDriver = userType === 'driver';
      
      if (isDriver && this.normalizePhone(match.driverPhone) !== this.normalizePhone(acceptedByUserId)) {
        throw new Error('Driver phone mismatch');
      }
      if (!isDriver && this.normalizePhone(match.passengerPhone) !== this.normalizePhone(acceptedByUserId)) {
        throw new Error('Passenger phone mismatch');
      }
      
      const driverPhone = this.normalizePhone(match.driverPhone);
      const passengerPhone = this.normalizePhone(match.passengerPhone);
      
      const driver = await this.firestoreService.getDriverSearch(driverPhone);
      if (!driver) throw new Error('Driver not found');
      
      const passenger = await this.firestoreService.getPassengerSearch(passengerPhone);
      if (!passenger) throw new Error('Passenger not found');
      
      console.log(`🔍 Accepting ${passengerPhone} in ${match.passengerField}`);
      
      const driverDoc = await this.firestoreService.db.collection('active_searches_driver').doc(driverPhone).get();
      if (driverDoc.exists) {
        const driverData = driverDoc.data();
        const passengerField = match.passengerField;
        
        if (driverData[passengerField] && 
            this.normalizePhone(driverData[passengerField].passengerId) === passengerPhone) {
          const updatedData = {
            ...driverData[passengerField],
            matchStatus: 'accepted', 
            acceptedAt: new Date().toISOString(), 
            matchAcceptedAt: new Date().toISOString()
          };
          await driverDoc.ref.update({ 
            [passengerField]: updatedData, 
            lastUpdated: Date.now() 
          });
        } else {
          const passengerData = {
            passengerId: passengerPhone, 
            passengerName: passenger.passengerName,
            passengerPhone: passengerPhone, 
            passengerPhotoUrl: passenger.passengerPhotoUrl,
            passengerCount: match.passengerCount || 1,
            pickupLocation: match.pickupLocation || passenger.pickupLocation || { lat: 8.550023, lng: 39.266712 },
            pickupName: match.pickupName || passenger.pickupName || "Pickup",
            destinationLocation: match.destinationLocation || passenger.destinationLocation || { lat: 9.589549, lng: 41.866169 },
            destinationName: match.destinationName || passenger.destinationName || "Destination",
            estimatedFare: passenger.estimatedFare, 
            routePoints: passenger.routePoints || [],
            addedAt: new Date().toISOString(), 
            matchId, 
            matchStatus: 'accepted',
            acceptedAt: new Date().toISOString(), 
            matchAcceptedAt: new Date().toISOString()
          };
          await driverDoc.ref.update({ 
            [passengerField]: passengerData, 
            lastUpdated: Date.now() 
          });
        }
      }
      
      await matchDoc.ref.update({
        status: 'accepted', 
        acceptedAt: this.getServerTimestamp(),
        acceptedBy: userType, 
        updatedAt: this.getServerTimestamp(), 
        matchAcceptedAt: new Date().toISOString()
      });
      
      const updatedMatchDoc = await this.firestoreService.db.collection('active_matches').doc(matchId).get();
      const updatedMatchData = updatedMatchDoc.data();
      
      await this.firestoreService.db.collection('active_searches_passenger').doc(passengerPhone).update({
        matchStatus: 'accepted', 
        status: 'accepted', 
        matchAcceptedAt: new Date(), 
        lastUpdated: Date.now(),
        driver: {
          driverId: driverPhone, 
          driverName: driver.driverName, 
          driverPhone: driverPhone,
          driverPhotoUrl: driver.driverPhotoUrl, 
          driverRating: driver.driverRating,
          vehicleInfo: driver.vehicleInfo || {}, 
          currentPassengers: driver.currentPassengers || 1,
          availableSeats: driver.availableSeats || 3, 
          capacity: driver.capacity || 4,
          passengerField: match.passengerField, 
          matchStatus: 'accepted'
        }
      });
      
      await this.updateDriverOverallStatus(driverPhone);
      
      const locationSessionId = await this.locationService.startRealtimeLocationSharing(
        matchId, 
        acceptedByUserId, 
        isDriver ? passengerPhone : driverPhone, 
        userType
      );
      
      await matchDoc.ref.update({
        locationSessionId, 
        locationSharingEnabled: true,
        locationSharingStarted: this.getServerTimestamp(),
        locationSharingExpires: new Date(Date.now() + (15 * 60 * 1000))
      });
      
      await this.createOrUpdateActiveRide(updatedMatchData, driver, passenger);
      
      // 1. Handle match in global location service
      if (this.globalLocationService) {
        this.globalLocationService.handleMatchCreated(
          matchId,
          driverPhone,
          passengerPhone
        );
      }
      
      console.log(`📍 Match ${matchId}: Driver ${driverPhone} stays visible, Passenger ${passengerPhone} disappears`);
      
      await this.sendInitialMatchLocations(matchId, driverPhone, passengerPhone);
      
      await this.sendMatchAcceptedNotifications(match, userType, acceptedByUserId);
      
      if (userType === 'driver' && !this.ONE_PASSENGER_AT_A_TIME) {
        await this.autoAcceptAllPassengersForDriver(driverPhone);
      }
      
      return { 
        success: true, 
        matchId, 
        locationSessionId, 
        passengerId: passengerPhone, 
        passengerField: match.passengerField, 
        matchStatus: 'accepted' 
      };
    } catch (error) {
      console.error('❌ ERROR accepting match:', error);
      throw error;
    }
  }
  
  async handleGetNearbyUsers(ws, data) {
    try {
      const { userId, userType, location, radiusKm = 5 } = data;
      
      const nearbyUsers = this.globalLocationService.getNearbyUsers(
        location.lat,
        location.lng,
        radiusKm
      );
      
      const oppositeType = userType === 'driver' ? 'passenger' : 'driver';
      const filteredUsers = nearbyUsers.filter(user => user.userType === oppositeType);
      
      ws.send(JSON.stringify({
        type: 'NEARBY_USERS',
        users: filteredUsers.map(user => ({
          userId: user.userId,
          location: user.location,
          distance: user.distance,
          trip: user.trip,
          info: user.info,
          lastUpdate: user.lastUpdate
        })),
        timestamp: Date.now(),
        count: filteredUsers.length
      }));
      
    } catch (error) {
      console.error('❌ Error getting nearby users:', error);
      ws.send(JSON.stringify({
        type: 'ERROR',
        error: 'Failed to get nearby users'
      }));
    }
  }
  
  async handleGetAllUsers(ws, data) {
    try {
      const { userType, destinationFilter } = data;
      
      let users;
      if (destinationFilter) {
        users = this.globalLocationService.getUsersByTrip(destinationFilter, userType);
      } else {
        users = this.globalLocationService.getAllUsers(userType);
      }
      
      ws.send(JSON.stringify({
        type: 'ALL_USERS',
        users: users.map(user => ({
          userId: user.userId,
          userType: user.userType,
          location: user.location,
          trip: user.trip,
          info: user.info,
          lastUpdate: user.lastUpdate
        })),
        timestamp: Date.now(),
        count: users.length
      }));
      
    } catch (error) {
      console.error('❌ Error getting all users:', error);
      ws.send(JSON.stringify({
        type: 'ERROR',
        error: 'Failed to get users'
      }));
    }
  }
  
  async handleHeartbeat(ws, data) {
    try {
      const { userId } = data;
      const connection = this.globalLocationService.connections.get(userId);
      
      if (connection) {
        connection.lastHeartbeat = Date.now();
      }
      
      ws.send(JSON.stringify({
        type: 'HEARTBEAT_RESPONSE',
        timestamp: Date.now()
      }));
      
    } catch (error) {
      console.error('❌ Error handling heartbeat:', error);
    }
  }
  
  async sendInitialMatchLocations(matchId, driverId, passengerId) {
    try {
      const driverConnection = this.globalLocationService.connections.get(driverId);
      const passengerConnection = this.globalLocationService.connections.get(passengerId);
      
      if (driverConnection?.location) {
        this.globalLocationService.sendToUser(passengerId, {
          type: 'MATCHED_DRIVER_LOCATION',
          matchId,
          location: driverConnection.location,
          driverInfo: driverConnection.info,
          timestamp: Date.now()
        });
      }
      
      if (passengerConnection?.location) {
        this.globalLocationService.sendToUser(driverId, {
          type: 'MATCHED_PASSENGER_LOCATION',
          matchId,
          location: passengerConnection.location,
          passengerInfo: passengerConnection.info,
          timestamp: Date.now()
        });
      }
    } catch (error) {
      console.error('❌ Error sending initial match locations:', error);
    }
  }
  
  async declineIndividualMatch(matchId, declinedByUserId, userType, reason = 'declined') {
    try {
      console.log(`\n❌ ${userType} ${declinedByUserId} declining ${matchId}`);
      
      const matchDoc = await this.firestoreService.db.collection('active_matches').doc(matchId).get();
      if (!matchDoc.exists) return { success: false, error: 'Match not found' };
      const match = matchDoc.data();
      
      await matchDoc.ref.update({
        status: 'declined', 
        declinedAt: this.getServerTimestamp(),
        declinedBy: userType, 
        declineReason: reason, 
        updatedAt: this.getServerTimestamp()
      });
      
      const passengerPhone = this.normalizePhone(match.passengerPhone);
      
      await this.firestoreService.db.collection('active_searches_passenger').doc(passengerPhone).update({
        matchId: null, 
        matchedWith: null, 
        matchStatus: null, 
        matchProposedAt: null,
        driver: null, 
        status: 'searching', 
        lastUpdated: Date.now()
      });
      
      const driverPhone = this.normalizePhone(match.driverPhone);
      
      const driverDoc = await this.firestoreService.db.collection('active_searches_driver').doc(driverPhone).get();
      if (driverDoc.exists) {
        const driverData = driverDoc.data();
        const passengerField = match.passengerField;
        
        if (driverData[passengerField]) {
          await this.updatePassengerFieldStatus(driverPhone, passengerField, passengerPhone, 'declined');
          
          setTimeout(async () => {
            const passengerIds = new Set();
            let totalPassengers = 0;
            const capacity = driverData.capacity || 4;
            
            for (let i = 1; i <= capacity; i++) {
              const fieldName = `passenger${i}`;
              if (driverData[fieldName] && driverData[fieldName].passengerId) {
                const passengerId = this.normalizePhone(driverData[fieldName].passengerId);
                if (fieldName !== passengerField && !passengerIds.has(passengerId)) {
                  passengerIds.add(passengerId);
                  totalPassengers += driverData[fieldName].passengerCount || 1;
                }
              }
            }
            
            await driverDoc.ref.update({
              [passengerField]: null, 
              currentPassengers: totalPassengers,
              availableSeats: capacity - totalPassengers, 
              lastUpdated: Date.now()
            });
          }, 100);
        }
      }
      
      await this.updateActiveRideForMatch(matchId, 'declined', userType, reason);
      
      await this.sendMatchDeclinedNotification(match, userType, reason);
      this.initializedSearches.set(`passenger_${passengerPhone}`, Date.now());
      
      return { success: true, matchId };
    } catch (error) {
      console.error('❌ ERROR declining match:', error);
      throw error;
    }
  }
  
  async cancelAcceptedMatch(matchId, cancelledByUserId, userType, reason = 'cancelled_by_user') {
    try {
      console.log(`\n❌ ${userType} ${cancelledByUserId} cancelling accepted match ${matchId}`);
      
      const matchDoc = await this.firestoreService.db.collection('active_matches').doc(matchId).get();
      if (!matchDoc.exists) throw new Error('Match not found');
      const match = matchDoc.data();
      
      const driverPhone = this.normalizePhone(match.driverPhone);
      const passengerPhone = this.normalizePhone(match.passengerPhone);
      
      if (userType === 'driver' && this.normalizePhone(cancelledByUserId) !== driverPhone) {
        throw new Error('Driver phone mismatch');
      }
      if (userType === 'passenger' && this.normalizePhone(cancelledByUserId) !== passengerPhone) {
        throw new Error('Passenger phone mismatch');
      }
      
      if (!['accepted', 'proposed'].includes(match.status)) {
        throw new Error(`Cannot cancel match with status: ${match.status}`);
      }
      
      const passengerField = match.passengerField;
      
      console.log(`🔍 Cancelling ${passengerPhone} in ${passengerField} for driver ${driverPhone}`);
      
      await matchDoc.ref.update({
        status: 'cancelled', 
        cancelledAt: this.getServerTimestamp(),
        cancelledBy: userType, 
        cancellationReason: reason, 
        updatedAt: this.getServerTimestamp()
      });
      console.log(`✅ Match ${matchId} → CANCELLED`);
      
      await this.updateActiveRideForMatch(matchId, 'cancelled', userType, reason);
      
      const driverDoc = await this.firestoreService.db.collection('active_searches_driver').doc(driverPhone).get();
      if (driverDoc.exists) {
        const driverData = driverDoc.data();
        const capacity = driverData.capacity || 4;
        
        const passengerIds = new Set();
        let totalPassengers = 0;
        
        for (let i = 1; i <= capacity; i++) {
          const fieldName = `passenger${i}`;
          if (driverData[fieldName] && driverData[fieldName].passengerId) {
            const passengerIdInField = this.normalizePhone(driverData[fieldName].passengerId);
            if (fieldName === passengerField && passengerIdInField === passengerPhone) continue;
            if (!passengerIds.has(passengerIdInField)) {
              passengerIds.add(passengerIdInField);
              totalPassengers += driverData[fieldName].passengerCount || 1;
            }
          }
        }
        
        await driverDoc.ref.update({
          [passengerField]: null, 
          currentPassengers: totalPassengers,
          availableSeats: capacity - totalPassengers, 
          lastUpdated: Date.now()
        });
        await this.updateDriverOverallStatus(driverPhone);
      }
      
      await this.firestoreService.db.collection('active_searches_passenger').doc(passengerPhone).update({
        matchId: null, 
        matchedWith: null, 
        matchStatus: null, 
        matchProposedAt: null,
        driver: null, 
        status: 'searching', 
        lastUpdated: Date.now(),
        cancellationReason: `Cancelled by ${userType}`
      });
      
      if (match.locationSessionId && this.locationService) {
        await this.locationService.stopLocationSharing(match.locationSessionId);
      }
      
      await this.sendMatchCancelledNotification(match, userType, reason);
      this.initializedSearches.set(`passenger_${passengerPhone}`, Date.now());
      
      return { 
        success: true, 
        matchId, 
        driverId: driverPhone, 
        passengerId: passengerPhone, 
        cancelledBy: userType, 
        reason, 
        timestamp: new Date().toISOString() 
      };
    } catch (error) {
      console.error('❌ ERROR cancelling accepted match:', error);
      throw error;
    }
  }
  
  async sendIndividualMatchNotification(matchData) {
    try {
      if (!this.websocketServer?.sendToUser) return;
      
      const driverPhone = this.normalizePhone(matchData.driverPhone);
      const passengerPhone = this.normalizePhone(matchData.passengerPhone);
      
      const driverMessage = {
        type: 'MATCH_PROPOSAL', 
        matchId: matchData.matchId,
        driverId: driverPhone, 
        passengerId: passengerPhone,
        passengerName: matchData.passengerName, 
        passengerCount: matchData.passengerCount,
        passengerField: matchData.passengerField, 
        currentPassengers: matchData.driverCurrentPassengers,
        availableSeats: matchData.driverAvailableSeats, 
        capacity: matchData.driverCapacity,
        pickupLocation: matchData.pickupLocation, 
        pickupName: matchData.pickupName,
        destinationLocation: matchData.destinationLocation, 
        destinationName: matchData.destinationName,
        status: matchData.status, 
        expiresAt: matchData.expiresAt,
        matchType: 'INDIVIDUAL', 
        timestamp: new Date().toISOString()
      };
      
      this.websocketServer.sendToUser(driverPhone, driverMessage);
      
      const passengerMessage = {
        type: 'MATCH_PROPOSAL', 
        matchId: matchData.matchId,
        driverId: driverPhone, 
        driverName: matchData.driverName,
        driverPhone: driverPhone, 
        driverPhotoUrl: matchData.driverPhotoUrl,
        passengerId: passengerPhone, 
        passengerField: matchData.passengerField,
        currentPassengers: matchData.driverCurrentPassengers, 
        capacity: matchData.driverCapacity,
        availableSeats: matchData.driverAvailableSeats,
        pickupLocation: matchData.pickupLocation, 
        pickupName: matchData.pickupName,
        destinationLocation: matchData.destinationLocation, 
        destinationName: matchData.destinationName,
        status: matchData.status, 
        expiresAt: matchData.expiresAt,
        matchType: 'INDIVIDUAL', 
        timestamp: new Date().toISOString()
      };
      
      this.websocketServer.sendToUser(passengerPhone, passengerMessage);
      console.log(`✅ Match notifications sent for ${matchData.matchId}`);
    } catch (error) {
      console.error('❌ Error sending match notification:', error);
    }
  }
  
  async sendMatchAcceptedNotifications(match, acceptedByUserType, acceptedByUserId) {
    try {
      console.log(`📤 Sending accepted notifications for ${match.matchId}`);
      
      const driverPhone = this.normalizePhone(match.driverPhone);
      const passengerPhone = this.normalizePhone(match.passengerPhone);
      
      const notificationData = {
        type: 'MATCH_ACCEPTED', 
        matchId: match.matchId, 
        acceptedBy: acceptedByUserType,
        acceptedByUserId, 
        passengerId: passengerPhone, 
        driverId: driverPhone,
        passengerField: match.passengerField, 
        pickupLocation: match.pickupLocation,
        pickupName: match.pickupName, 
        destinationLocation: match.destinationLocation,
        timestamp: new Date().toISOString(), 
        message: `${acceptedByUserType} accepted the match!`,
        locationSharingEnabled: true, 
        matchType: 'INDIVIDUAL'
      };
      
      if (this.websocketServer?.sendToUser) {
        await this.websocketServer.sendToUser(driverPhone, notificationData);
        await this.websocketServer.sendToUser(passengerPhone, notificationData);
      }
      
      if (this.notificationService) {
        if (acceptedByUserType !== 'driver') {
          await this.notificationService.sendPushNotification(driverPhone, {
            title: 'Passenger Accepted Your Ride!',
            body: `${match.passengerName || 'Passenger'} accepted your ride request. Pickup at ${match.pickupName}`,
            data: { matchId: match.matchId, type: 'MATCH_ACCEPTED' }
          });
        }
        
        if (acceptedByUserType !== 'passenger') {
          await this.notificationService.sendPushNotification(passengerPhone, {
            title: 'Driver Accepted Your Request!',
            body: `${match.driverName || 'Driver'} accepted your ride request. Your pickup: ${match.pickupName}`,
            data: { matchId: match.matchId, type: 'MATCH_ACCEPTED' }
          });
        }
      }
    } catch (error) {
      console.error('❌ Error sending accepted notifications:', error);
    }
  }
  
  async sendMatchDeclinedNotification(match, declinedByUserType, reason) {
    try {
      if (!this.websocketServer?.sendToUser) return;
      
      const driverPhone = this.normalizePhone(match.driverPhone);
      const passengerPhone = this.normalizePhone(match.passengerPhone);
      
      const message = {
        type: 'MATCH_DECLINED', 
        matchId: match.matchId, 
        declinedBy: declinedByUserType, 
        reason,
        passengerId: passengerPhone, 
        driverId: driverPhone, 
        passengerField: match.passengerField,
        timestamp: new Date().toISOString(), 
        message: `Match declined by ${declinedByUserType}`, 
        matchType: 'INDIVIDUAL'
      };
      
      if (declinedByUserType === 'driver') {
        this.websocketServer.sendToUser(passengerPhone, message);
      } else {
        this.websocketServer.sendToUser(driverPhone, message);
      }
    } catch (error) {
      console.error('❌ Error sending decline notification:', error);
    }
  }
  
  async sendMatchCancelledNotification(match, cancelledByUserType, reason) {
    try {
      console.log(`📤 Sending cancelled notifications for ${match.matchId}`);
      
      const driverPhone = this.normalizePhone(match.driverPhone);
      const passengerPhone = this.normalizePhone(match.passengerPhone);
      
      const notificationData = {
        type: 'MATCH_CANCELLED', 
        matchId: match.matchId, 
        cancelledBy: cancelledByUserType, 
        reason,
        passengerId: passengerPhone, 
        driverId: driverPhone, 
        passengerField: match.passengerField,
        pickupLocation: match.pickupLocation, 
        pickupName: match.pickupName,
        timestamp: new Date().toISOString(), 
        message: `Match cancelled by ${cancelledByUserType}: ${reason}`, 
        matchType: 'INDIVIDUAL'
      };
      
      if (this.websocketServer?.sendToUser) {
        await this.websocketServer.sendToUser(driverPhone, notificationData);
        await this.websocketServer.sendToUser(passengerPhone, notificationData);
      }
      
      if (this.notificationService) {
        if (cancelledByUserType !== 'driver') {
          await this.notificationService.sendPushNotification(driverPhone, {
            title: 'Passenger Cancelled Ride',
            body: `${match.passengerName || 'Passenger'} cancelled the ride. Reason: ${reason}`,
            data: { matchId: match.matchId, type: 'MATCH_CANCELLED' }
          });
        }
        
        if (cancelledByUserType !== 'passenger') {
          await this.notificationService.sendPushNotification(passengerPhone, {
            title: 'Driver Cancelled Ride',
            body: `${match.driverName || 'Driver'} cancelled the ride. Reason: ${reason}`,
            data: { matchId: match.matchId, type: 'MATCH_CANCELLED' }
          });
        }
      }
    } catch (error) {
      console.error('❌ Error sending cancellation notification:', error);
    }
  }
  
  async sendMatchExpiredNotification(match) {
    try {
      if (!this.websocketServer?.sendToUser) return;
      
      const driverPhone = this.normalizePhone(match.driverPhone);
      const passengerPhone = this.normalizePhone(match.passengerPhone);
      
      const message = {
        type: 'MATCH_EXPIRED', 
        matchId: match.matchId, 
        passengerId: passengerPhone,
        driverId: driverPhone, 
        passengerField: match.passengerField,
        pickupLocation: match.pickupLocation, 
        pickupName: match.pickupName,
        timestamp: new Date().toISOString(), 
        reason: 'timeout', 
        matchType: 'INDIVIDUAL'
      };
      
      this.websocketServer.sendToUser(driverPhone, message);
      this.websocketServer.sendToUser(passengerPhone, message);
    } catch (error) {
      console.error('❌ Error sending expired notification:', error);
    }
  }
  
  async sendAutoAcceptNotifications(driverId, passengerCount) {
    try {
      if (!this.websocketServer?.sendToUser) return;
      
      const driverPhone = this.normalizePhone(driverId);
      const message = {
        type: 'AUTO_ACCEPTED', 
        driverId: driverPhone, 
        passengerCount,
        timestamp: new Date().toISOString(), 
        message: `Auto-accepted ${passengerCount} passenger(s)`
      };
      
      this.websocketServer.sendToUser(driverPhone, message);
    } catch (error) {
      console.error('❌ Error sending auto-accept notification:', error);
    }
  }
  
  async updateUserLocation(userId, locationData, userType) {
    try {
      const normalizedUserId = this.normalizePhone(userId);
      console.log(`📍 Updating ${userType} ${normalizedUserId}: lat: ${locationData.latitude}, lng: ${locationData.longitude}`);
      
      const updateData = {
        currentLocation: { lat: locationData.latitude, lng: locationData.longitude },
        lastLocationUpdate: Date.now(), 
        lastUpdated: Date.now()
      };
      
      const collection = userType === 'driver' ? 'active_searches_driver' : 'active_searches_passenger';
      await this.firestoreService.db.collection(collection).doc(normalizedUserId).update(updateData);
      
      if (userType === 'driver' && this.config.getRealtimeConfig().enabled) {
        await this.updateMatchingBasedOnRealTimeLocation(normalizedUserId, {
          lat: locationData.latitude, lng: locationData.longitude
        });
      }
      
      if (userType === 'driver') {
        await this.checkAndAutoStopDriverIfNeeded(normalizedUserId, {
          lat: locationData.latitude, lng: locationData.longitude
        });
      }
      
      return { success: true };
    } catch (error) {
      console.error(`❌ Error updating location for ${userType} ${userId}:`, error);
      return { success: false, error: error.message };
    }
  }
  
  async updateMatchingBasedOnRealTimeLocation(driverId, newLocation) {
    try {
      const normalizedDriverId = this.normalizePhone(driverId);
      console.log(`📍 Real-time location update for ${normalizedDriverId}`);
      
      const driverDoc = await this.firestoreService.db.collection('active_searches_driver').doc(normalizedDriverId).get();
      if (!driverDoc.exists) return;
      
      const driverData = driverDoc.data();
      
      await driverDoc.ref.update({
        currentLocation: newLocation, 
        lastLocationUpdate: Date.now(), 
        lastUpdated: Date.now()
      });
      
      if (this.config.getRealtimeConfig().enabled) {
        await this.findRealTimeMatches(normalizedDriverId, driverData, newLocation);
      }
      
      await this.checkAndAutoStopDriverIfNeeded(normalizedDriverId, newLocation);
    } catch (error) {
      console.error('❌ Error in real-time matching:', error);
    }
  }
  
  async findRealTimeMatches(driverId, driverData, currentLocation) {
    try {
      console.log(`🔍 Finding real-time matches for ${driverId}`);
      const passengers = await this.getActivePassengersDirect();
      const scoredPassengers = [];
      
      for (const passenger of passengers) {
        const passengerId = this.normalizePhone(this.getUserId(passenger, 'passenger'));
        if (passenger.matchStatus === 'accepted' || passenger.matchStatus === 'proposed') continue;
        
        const distance = parseFloat(this.calculateDistance(
          currentLocation.lat, currentLocation.lng,
          passenger.pickupLocation.lat, passenger.pickupLocation.lng
        ));
        
        if (distance <= this.config.activeConfig.PROXIMITY.MAX_PICKUP_DISTANCE) {
          const score = this.calculateQuickMatchScore(driverData, passenger, distance);
          scoredPassengers.push({ passenger, passengerId, distance, score });
        }
      }
      
      scoredPassengers.sort((a, b) => b.score - a.score);
      
      for (const scored of scoredPassengers.slice(0, 3)) {
        if (await this.canAddPassengerToDriver(driverId, scored.passenger)) {
          console.log(`🎯 Real-time match found: ${scored.passengerId} (${scored.distance}km, score: ${scored.score})`);
          await this.sendRealTimeMatchNotification(driverId, scored.passenger);
        }
      }
    } catch (error) {
      console.error('❌ Error finding real-time matches:', error);
    }
  }
  
  calculateQuickMatchScore(driver, passenger, distance) {
    let score = 100;
    const maxDistance = this.config.activeConfig.PROXIMITY.MAX_PICKUP_DISTANCE;
    const distancePenalty = (distance / maxDistance) * 50;
    score -= distancePenalty;
    
    const directionSimilarity = this.calculateDirectionSimilarity(
      driver.pickupLocation || driver.currentLocation,
      driver.destinationLocation,
      passenger.pickupLocation,
      passenger.destinationLocation
    );
    
    if (directionSimilarity < 0.5) score -= 30;
    return Math.max(0, score);
  }
  
  async sendRealTimeMatchNotification(driverId, passenger) {
    try {
      if (!this.websocketServer?.sendToUser) return;
      
      const normalizedDriverId = this.normalizePhone(driverId);
      const passengerId = this.normalizePhone(this.getUserId(passenger, 'passenger'));
      
      const message = {
        type: 'REALTIME_MATCH_SUGGESTION', 
        data: {
          driverId: normalizedDriverId, 
          passengerId, 
          passengerName: passenger.passengerName,
          pickupLocation: passenger.pickupLocation,
          pickupDistance: this.calculateDistance(
            driver.currentLocation?.lat || 0, 
            driver.currentLocation?.lng || 0,
            passenger.pickupLocation.lat, 
            passenger.pickupLocation.lng
          ),
          timestamp: Date.now(), 
          message: 'Potential match found near your current location', 
          urgency: 'high',
        }
      };
      
      await this.websocketServer.sendToUser(normalizedDriverId, message);
      console.log(`📤 Sent real-time match suggestion to ${normalizedDriverId}`);
    } catch (error) {
      console.error('❌ Error sending real-time notification:', error);
    }
  }
  
  async canAddPassengerToDriver(driverId, passenger) {
    try {
      const normalizedDriverId = this.normalizePhone(driverId);
      const driverDoc = await this.firestoreService.db.collection('active_searches_driver').doc(normalizedDriverId).get();
      if (!driverDoc.exists) return false;
      
      const driverData = driverDoc.data();
      const capacity = driverData.capacity || 4;
      const passengerCount = passenger.passengerCount || 1;
      
      let currentPassengers = 0;
      const passengerIds = new Set();
      
      for (let i = 1; i <= capacity; i++) {
        const fieldName = `passenger${i}`;
        if (driverData[fieldName] && driverData[fieldName].passengerId) {
          const pid = this.normalizePhone(driverData[fieldName].passengerId);
          if (!passengerIds.has(pid)) {
            passengerIds.add(pid);
            currentPassengers += driverData[fieldName].passengerCount || 1;
          }
        }
      }
      
      return (currentPassengers + passengerCount) <= capacity;
    } catch (error) {
      console.error('❌ Error checking passenger addition:', error);
      return false;
    }
  }
  
  async updatePassengerFieldStatus(driverId, passengerField, passengerId, newStatus) {
    try {
      const normalizedDriverId = this.normalizePhone(driverId);
      const normalizedPassengerId = this.normalizePhone(passengerId);
      
      console.log(`🔄 Updating ${passengerField} for ${normalizedDriverId}, ${normalizedPassengerId} → ${newStatus}`);
      
      const driverDoc = await this.firestoreService.db.collection('active_searches_driver').doc(normalizedDriverId).get();
      if (!driverDoc.exists) return false;
      
      const driverData = driverDoc.data();
      if (!driverData[passengerField] || 
          this.normalizePhone(driverData[passengerField].passengerId) !== normalizedPassengerId) {
        console.log(`❌ ${normalizedPassengerId} not in ${passengerField}`);
        return false;
      }
      
      const updatedData = { ...driverData[passengerField], matchStatus: newStatus };
      if (newStatus === 'accepted') {
        updatedData.acceptedAt = new Date().toISOString();
        updatedData.matchAcceptedAt = new Date().toISOString();
      } else if (newStatus === 'declined' || newStatus === 'rejected') {
        updatedData.declinedAt = new Date().toISOString();
      }
      
      await driverDoc.ref.update({ [passengerField]: updatedData, lastUpdated: Date.now() });
      return true;
    } catch (error) {
      console.error(`❌ Error updating field status:`, error);
      return false;
    }
  }
  
  async updateDriverOverallStatus(driverId) {
    try {
      const normalizedDriverId = this.normalizePhone(driverId);
      const driverDoc = await this.firestoreService.db.collection('active_searches_driver').doc(normalizedDriverId).get();
      if (!driverDoc.exists) return false;
      
      const driverData = driverDoc.data();
      const capacity = driverData.capacity || 4;
      
      const passengerIds = new Set();
      let totalUniquePassengers = 0, acceptedCount = 0, proposedCount = 0;
      
      for (let i = 1; i <= capacity; i++) {
        const fieldName = `passenger${i}`;
        const passengerData = driverData[fieldName];
        if (passengerData && passengerData.passengerId) {
          const passengerId = this.normalizePhone(passengerData.passengerId);
          if (passengerIds.has(passengerId)) continue;
          passengerIds.add(passengerId);
          totalUniquePassengers++;
          if (passengerData.matchStatus === 'accepted') acceptedCount++;
          else if (passengerData.matchStatus === 'proposed') proposedCount++;
        }
      }
      
      const updateData = { 
        lastUpdated: Date.now(), 
        currentPassengers: totalUniquePassengers, 
        availableSeats: capacity - totalUniquePassengers 
      };
      
      if (totalUniquePassengers > 0) {
        if (acceptedCount === totalUniquePassengers) {
          updateData.matchStatus = 'accepted'; 
          updateData.status = 'accepted';
        } else if (acceptedCount > 0) {
          updateData.matchStatus = 'partially_accepted'; 
          updateData.status = 'matched';
        } else if (proposedCount > 0) {
          updateData.matchStatus = 'proposed'; 
          updateData.status = 'matched';
        } else {
          updateData.matchStatus = 'matched'; 
          updateData.status = 'matched';
        }
      } else {
        updateData.matchStatus = null; 
        updateData.status = 'searching';
        updateData.currentPassengers = 0; 
        updateData.availableSeats = capacity;
      }
      
      await driverDoc.ref.update(updateData);
      return true;
    } catch (error) {
      console.error('❌ Error updating driver status:', error);
      return false;
    }
  }
  
  async autoAcceptAllPassengersForDriver(driverId) {
    try {
      if (this.ONE_PASSENGER_AT_A_TIME) {
        console.log(`⏸️ Auto-accept disabled for ${driverId} (one-at-a-time mode)`);
        return;
      }
      
      const normalizedDriverId = this.normalizePhone(driverId);
      console.log(`🤖 Auto-accepting all for ${normalizedDriverId}...`);
      const driverDoc = await this.firestoreService.db.collection('active_searches_driver').doc(normalizedDriverId).get();
      if (!driverDoc.exists) return;
      
      const driverData = driverDoc.data();
      const capacity = driverData.capacity || 4;
      let autoAcceptedCount = 0;
      
      for (let i = 1; i <= capacity; i++) {
        const fieldName = `passenger${i}`;
        const passengerData = driverData[fieldName];
        
        if (passengerData && passengerData.passengerId && passengerData.matchStatus === 'proposed') {
          const normalizedPassengerId = this.normalizePhone(passengerData.passengerId);
          console.log(`🤖 Auto-accepting ${normalizedPassengerId} in ${fieldName}`);
          
          const updatedData = { 
            ...passengerData, 
            matchStatus: 'accepted', 
            acceptedAt: new Date().toISOString(), 
            autoAccepted: true 
          };
          await driverDoc.ref.update({ 
            [fieldName]: updatedData, 
            lastUpdated: Date.now() 
          });
          
          await this.firestoreService.db.collection('active_searches_passenger').doc(normalizedPassengerId).update({
            matchStatus: 'accepted', 
            status: 'accepted', 
            matchAcceptedAt: new Date(), 
            lastUpdated: Date.now()
          });
          
          if (passengerData.matchId) {
            const matchDoc = await this.firestoreService.db.collection('active_matches').doc(passengerData.matchId).get();
            if (matchDoc.exists) {
              await matchDoc.ref.update({
                status: 'accepted', 
                acceptedAt: this.getServerTimestamp(),
                acceptedBy: 'driver', 
                autoAccepted: true, 
                updatedAt: this.getServerTimestamp()
              });
            }
          }
          
          autoAcceptedCount++;
        }
      }
      
      if (autoAcceptedCount > 0) {
        await this.updateDriverOverallStatus(normalizedDriverId);
        await this.sendAutoAcceptNotifications(normalizedDriverId, autoAcceptedCount);
      }
    } catch (error) {
      console.error('❌ Error auto-accepting passengers:', error);
    }
  }
  
  async expireIndividualMatch(matchId, driverId, passengerId, passengerField) {
    try {
      const normalizedDriverId = this.normalizePhone(driverId);
      const normalizedPassengerId = this.normalizePhone(passengerId);
      
      const matchDoc = await this.firestoreService.db.collection('active_matches').doc(matchId).get();
      if (!matchDoc.exists) {
        this.activeMatchIds.delete(matchId);
        return;
      }
      
      const match = matchDoc.data();
      if (match.status === 'proposed') {
        console.log(`⏰ ${matchId} expired for ${normalizedPassengerId}`);
        
        await matchDoc.ref.update({
          status: 'expired', 
          expiredAt: new Date(), 
          updatedAt: new Date()
        });
        
        await this.updateActiveRideForMatch(matchId, 'expired', 'system', 'timeout');
        
        await this.firestoreService.db.collection('active_searches_passenger').doc(normalizedPassengerId).update({
          matchId: null, 
          matchedWith: null, 
          matchStatus: null, 
          driver: null,
          matchProposedAt: null, 
          status: 'searching', 
          lastUpdated: Date.now()
        });
        
        const driverDoc = await this.firestoreService.db.collection('active_searches_driver').doc(normalizedDriverId).get();
        if (driverDoc.exists) {
          const driverData = driverDoc.data();
          
          if (driverData[passengerField] && 
              this.normalizePhone(driverData[passengerField].passengerId) === normalizedPassengerId) {
            const passengerIds = new Set();
            let totalPassengers = 0;
            const capacity = driverData.capacity || 4;
            
            for (let i = 1; i <= capacity; i++) {
              const fieldName = `passenger${i}`;
              if (driverData[fieldName] && driverData[fieldName].passengerId) {
                const pid = this.normalizePhone(driverData[fieldName].passengerId);
                if (fieldName !== passengerField && !passengerIds.has(pid)) {
                  passengerIds.add(pid);
                  totalPassengers += driverData[fieldName].passengerCount || 1;
                }
              }
            }
            
            await driverDoc.ref.update({
              [passengerField]: null, 
              currentPassengers: totalPassengers,
              availableSeats: capacity - totalPassengers, 
              lastUpdated: Date.now()
            });
          }
        }
        
        await this.sendMatchExpiredNotification(match);
        this.initializedSearches.set(`passenger_${normalizedPassengerId}`, Date.now());
      }
      
      this.activeMatchIds.delete(matchId);
    } catch (error) {
      console.error('❌ Error expiring match:', error);
      this.activeMatchIds.delete(matchId);
    }
  }
  
  async clearExpiredMatchProposals() {
    try {
      const now = Date.now();
      let clearedCount = 0;
      
      const matchesSnapshot = await this.firestoreService.db.collection('active_matches').where('status', '==', 'proposed').get();
      
      for (const matchDoc of matchesSnapshot.docs) {
        const match = matchDoc.data();
        const createdAt = this.parseTimestamp(match.createdAt);
        
        if (createdAt && (now - createdAt.getTime() > TIMEOUTS.MATCH_PROPOSAL)) {
          await matchDoc.ref.update({
            status: 'expired', 
            expiredAt: new Date(), 
            updatedAt: new Date()
          });
          
          await this.updateActiveRideForMatch(matchDoc.id, 'expired', 'system', 'timeout');
          
          if (match.passengerPhone) {
            const normalizedPassengerPhone = this.normalizePhone(match.passengerPhone);
            await this.firestoreService.db.collection('active_searches_passenger').doc(normalizedPassengerPhone).update({
              matchId: null, 
              matchedWith: null, 
              matchStatus: null, 
              driver: null,
              matchProposedAt: null, 
              status: 'searching', 
              lastUpdated: Date.now()
            });
            this.initializedSearches.set(`passenger_${normalizedPassengerPhone}`, Date.now());
          }
          
          if (match.driverPhone && match.passengerField) {
            const normalizedDriverPhone = this.normalizePhone(match.driverPhone);
            const driverDoc = await this.firestoreService.db.collection('active_searches_driver').doc(normalizedDriverPhone).get();
            if (driverDoc.exists) {
              const driverData = driverDoc.data();
              if (driverData[match.passengerField] && 
                  this.normalizePhone(driverData[match.passengerField].passengerId) === this.normalizePhone(match.passengerPhone)) {
                let currentPassengers = 0;
                const capacity = driverData.capacity || 4;
                
                for (let i = 1; i <= capacity; i++) {
                  const fieldName = `passenger${i}`;
                  if (fieldName !== match.passengerField && driverData[fieldName]) {
                    currentPassengers += driverData[fieldName].passengerCount || 1;
                  }
                }
                
                await driverDoc.ref.update({
                  [match.passengerField]: null, 
                  currentPassengers,
                  availableSeats: capacity - currentPassengers, 
                  lastUpdated: Date.now()
                });
              }
            }
          }
          
          clearedCount++;
        }
      }
      
      return clearedCount;
    } catch (error) {
      console.error('❌ Error clearing expired matches:', error);
      return 0;
    }
  }
  
  async fixDriverDuplicatePassengers(driverId) {
    try {
      const normalizedDriverId = this.normalizePhone(driverId);
      console.log(`🔧 Fixing duplicates for ${normalizedDriverId}`);
      const driverDoc = await this.firestoreService.db.collection('active_searches_driver').doc(normalizedDriverId).get();
      if (!driverDoc.exists) return false;
      
      const driverData = driverDoc.data();
      const capacity = driverData.capacity || 4;
      
      const seenPassengerIds = new Set();
      const fieldsToClear = [];
      
      for (let i = 1; i <= capacity; i++) {
        const fieldName = `passenger${i}`;
        const passengerData = driverData[fieldName];
        if (passengerData && passengerData.passengerId) {
          const passengerId = this.normalizePhone(passengerData.passengerId);
          if (seenPassengerIds.has(passengerId)) fieldsToClear.push(fieldName);
          else seenPassengerIds.add(passengerId);
        }
      }
      
      if (fieldsToClear.length === 0) return true;
      
      const updateData = { lastUpdated: Date.now() };
      for (const fieldName of fieldsToClear) updateData[fieldName] = null;
      
      updateData.currentPassengers = seenPassengerIds.size;
      updateData.availableSeats = capacity - seenPassengerIds.size;
      
      await driverDoc.ref.update(updateData);
      console.log(`✅ Fixed ${fieldsToClear.length} duplicate(s) for ${normalizedDriverId}`);
      return true;
    } catch (error) {
      console.error(`❌ Error fixing duplicates for ${driverId}:`, error);
      return false;
    }
  }
  
  async repairBrokenMatches() {
    if (!this.AUTO_REPAIR_MATCHES) return;
    
    try {
      console.log('🔧 Repairing broken matches...');
      const driversSnapshot = await this.firestoreService.db.collection('active_searches_driver')
        .where('status', 'in', ['matched', 'accepted', 'proposed']).limit(10).get();
      
      let fixedCount = 0;
      
      for (const driverDoc of driversSnapshot.docs) {
        const driverId = driverDoc.id;
        if (await this.fixDriverDuplicatePassengers(driverId)) fixedCount++;
        
        const driverData = driverDoc.data();
        if (driverData.passenger && driverData.passenger.passengerId) {
          const capacity = driverData.capacity || 4;
          let emptyField = null;
          
          for (let i = 1; i <= capacity; i++) {
            const fieldName = `passenger${i}`;
            if (!driverData[fieldName] || !driverData[fieldName].passengerId) {
              emptyField = fieldName;
              break;
            }
          }
          
          if (emptyField) {
            const passengerData = { ...driverData.passenger, addedAt: new Date().toISOString() };
            await driverDoc.ref.update({
              [emptyField]: passengerData, 
              passenger: null, 
              lastUpdated: Date.now()
            });
            fixedCount++;
          }
        }
      }
      
      if (fixedCount > 0) console.log(`✅ Fixed ${fixedCount} issues`);
    } catch (error) {
      console.error('❌ Error repairing matches:', error);
    }
  }
  
  async cleanupExpiredSearches() {
    try {
      const now = new Date();
      const expiryTime = new Date(now.getTime() - (30 * 60 * 1000));
      
      let driverCount = 0, passengerCount = 0;
      
      const driverSnapshot = await this.firestoreService.db.collection('active_searches_driver')
        .where('updatedAt', '<', expiryTime).where('status', '==', 'searching').get();
      
      for (const doc of driverSnapshot.docs) {
        await doc.ref.update({ status: 'expired', updatedAt: new Date() });
        driverCount++;
        this.initializedSearches.delete(`driver_${doc.id}`);
      }
      
      const passengerSnapshot = await this.firestoreService.db.collection('active_searches_passenger')
        .where('updatedAt', '<', expiryTime).where('status', '==', 'searching').get();
      
      for (const doc of passengerSnapshot.docs) {
        await doc.ref.update({ status: 'expired', updatedAt: new Date() });
        passengerCount++;
        this.initializedSearches.delete(`passenger_${doc.id}`);
      }
      
      if (driverCount > 0 || passengerCount > 0) {
        console.log(`🧹 Cleanup: ${driverCount} drivers + ${passengerCount} passengers`);
      }
    } catch (error) {
      console.error('❌ Error cleaning up searches:', error.message);
    }
  }
  
  logStatsPeriodically() {
    this.statsIntervalId = setInterval(() => {
      const stats = this.getStats();
      console.log(`\n📊 ENHANCED MATCHING SYSTEM STATS:`);
      console.log(`   Cycles: ${stats.cycles} | Matches: ${stats.successfulMatches}`);
      console.log(`   Failed: ${stats.failedMatches} | Rate: ${stats.successRate}`);
      console.log(`   Active: ${stats.activeIndividualMatchCount}`);
      console.log(`   Initialized Searches: ${this.initializedSearches.size}`);
      console.log(`   Blacklisted Drivers: ${this.cancelledDriverBlacklist.size}`);
      console.log(`   Full Drivers: ${this.fullDrivers.size}`);
      console.log(`   System: ${stats.matchSystem}`);
      console.log(`   Profile: ${this.config.currentProfile}`);
      console.log(`   One-at-a-time: ${this.ONE_PASSENGER_AT_A_TIME ? 'ENABLED' : 'DISABLED'}`);
      console.log(`   Last: ${new Date().toLocaleTimeString()}`);
    }, 60000);
  }
  
  getStats() {
    const successRate = this.matchAttempts > 0 ? 
      ((this.successfulMatches / this.matchAttempts) * 100).toFixed(1) + '%' : '0%';
    
    return {
      cycles: this.cycleCount,
      successfulMatches: this.successfulMatches,
      failedMatches: this.failedMatches,
      totalAttempts: this.matchAttempts,
      successRate,
      activeIndividualMatchCount: this.activeMatchIds.size,
      matchSystem: `CONTINUOUS_SEARCH_${this.config.currentProfile}`,
      matchingProfile: this.config.currentProfile,
      oneAtATimeMode: this.ONE_PASSENGER_AT_A_TIME,
      fullDriversCount: this.fullDrivers.size,
      lastUpdated: new Date().toISOString()
    };
  }
  
  async switchMatchingProfile(profileName) {
    try {
      const success = this.config.switchProfile(profileName);
      if (success) {
        console.log(`🔄 Switched to ${profileName} matching profile`);
        this.FORCE_TEST_MODE = this.config.activeConfig.FORCE_TEST_MODE;
        this.ONE_PASSENGER_AT_A_TIME = this.config.activeConfig.MATCHING_STRATEGY?.ONE_PASSENGER_AT_A_TIME ?? true;
        return { success: true, profile: profileName };
      }
      return { success: false, error: 'Profile not found' };
    } catch (error) {
      console.error('❌ Error switching profile:', error);
      return { success: false, error: error.message };
    }
  }
  
  getCurrentConfig() {
    return {
      profile: this.config.currentProfile,
      forceTestMode: this.config.activeConfig.FORCE_TEST_MODE,
      scoringWeights: this.config.activeConfig.SCORING_WEIGHTS,
      routeThresholds: this.config.activeConfig.ROUTE_THRESHOLDS,
      proximitySettings: this.config.activeConfig.PROXIMITY,
      realtimeMatching: this.config.getRealtimeConfig().enabled,
      onePassengerAtATime: this.ONE_PASSENGER_AT_A_TIME,
      waitForAcceptance: this.WAIT_FOR_ACCEPTANCE_BEFORE_NEXT
    };
  }
  
  // ==================== NEW: WHEN DRIVER ARRIVES AT DESTINATION ====================
  
  async handleDriverArrivedAtDestination(driverId) {
    try {
      console.log(`✅ Driver ${driverId} arrived at destination`);
      
      // Remove driver from global map
      if (this.globalLocationService) {
        this.globalLocationService.handleDriverTripCompleted(driverId);
      }
      
      // Update driver status in Firestore
      await this.firestoreService.db
        .collection('active_searches_driver')
        .doc(driverId)
        .update({
          status: 'completed',
          arrivedAtDestination: this.getServerTimestamp(),
          lastUpdated: Date.now()
        });
      
    } catch (error) {
      console.error('❌ Error handling driver arrival:', error);
    }
  }
  
  // NEW: When passenger cancels search (not matched)
  async handlePassengerCancelledSearch(passengerId) {
    try {
      console.log(`❌ Passenger ${passengerId} cancelled search`);
      
      // Remove passenger from global map
      if (this.globalLocationService) {
        const connection = this.globalLocationService.connections.get(passengerId);
        if (connection && connection.userType === 'passenger') {
          this.globalLocationService.searchingPassengers.delete(passengerId);
          this.globalLocationService.removeFromGrid(passengerId);
          this.globalLocationService.broadcastPassengerRemoved(passengerId, 'cancelled');
        }
      }
      
    } catch (error) {
      console.error('❌ Error handling passenger cancellation:', error);
    }
  }
  
  // ==================== ACTIVE RIDES METHODS ====================
  
  async createOrUpdateActiveRide(matchData, driverData, passengerData) {
    try {
      const normalizedDriverPhone = this.normalizePhone(matchData.driverPhone);
      const normalizedPassengerPhone = this.normalizePhone(matchData.passengerPhone);
      
      const activeRideId = `ride_${normalizedDriverPhone}_${normalizedPassengerPhone}_${Date.now()}`;
      
      const rideData = {
        rideId: activeRideId,
        matchId: matchData.matchId,
        driverPhone: normalizedDriverPhone,
        passengerPhone: normalizedPassengerPhone,
        
        matchStatus: matchData.status || 'accepted',
        matchCreatedAt: matchData.createdAt,
        matchAcceptedAt: matchData.matchAcceptedAt || this.getServerTimestamp(),
        
        driverInfo: {
          phone: normalizedDriverPhone,
          name: driverData.driverName || matchData.driverName,
          photoUrl: driverData.driverPhotoUrl || matchData.driverPhotoUrl,
          rating: driverData.driverRating || 5.0,
          totalRides: driverData.totalRides || 0,
          joinedDate: driverData.joinedDate || new Date().toISOString()
        },
        
        vehicleInfo: {
          ...(driverData.vehicleInfo || matchData.vehicleInfo || {}),
          number: driverData.vehicleNumber || driverData.vehicleInfo?.number || '',
          model: driverData.vehicleModel || driverData.vehicleInfo?.model || '',
          color: driverData.vehicleColor || driverData.vehicleInfo?.color || '',
          capacity: driverData.capacity || matchData.driverCapacity || 4
        },
        
        passengerInfo: {
          phone: normalizedPassengerPhone,
          name: passengerData.passengerName || matchData.passengerName,
          photoUrl: passengerData.passengerPhotoUrl || matchData.passengerPhotoUrl,
          rating: passengerData.passengerRating || 5.0,
          totalRides: passengerData.totalRides || 0
        },
        
        pickup: {
          location: matchData.pickupLocation || passengerData.pickupLocation,
          name: matchData.pickupName || passengerData.pickupName,
          address: matchData.pickupAddress || passengerData.pickupAddress,
          coordinates: {
            lat: matchData.pickupLocation?.lat || passengerData.pickupLocation?.lat,
            lng: matchData.pickupLocation?.lng || passengerData.pickupLocation?.lng
          }
        },
        
        destination: {
          location: matchData.destinationLocation || passengerData.destinationLocation,
          name: matchData.destinationName || passengerData.destinationName,
          address: matchData.destinationAddress || passengerData.destinationAddress,
          coordinates: {
            lat: matchData.destinationLocation?.lat || passengerData.destinationLocation?.lat,
            lng: matchData.destinationLocation?.lng || passengerData.destinationLocation?.lng
          }
        },
        
        passengerCount: matchData.passengerCount || 1,
        passengerField: matchData.passengerField,
        
        routePoints: matchData.routePoints || passengerData.routePoints || [],
        estimatedDistance: matchData.estimatedDistance || passengerData.estimatedDistance || 0,
        estimatedDuration: matchData.estimatedDuration || passengerData.estimatedDuration || 0,
        estimatedFare: matchData.estimatedFare || passengerData.estimatedFare || 0,
        actualFare: matchData.actualFare || 0,
        
        status: 'active',
        rideStatus: 'waiting',
        currentPassengersInVehicle: matchData.driverCurrentPassengers || 1,
        availableSeats: matchData.driverAvailableSeats || 3,
        
        matchAcceptedAt: matchData.matchAcceptedAt || new Date().toISOString(),
        rideCreatedAt: this.getServerTimestamp(),
        pickupConfirmedAt: null,
        arrivedAtPickupAt: null,
        rideStartedAt: null,
        arrivedAtDestinationAt: null,
        rideCompletedAt: null,
        
        currentDriverLocation: driverData.currentLocation || matchData.driverCurrentLocation,
        currentPassengerLocation: passengerData.currentLocation || matchData.passengerCurrentLocation,
        lastLocationUpdate: Date.now(),
        driverArrivedAtPickup: false,
        passengerBoarded: false,
        
        paymentMethod: passengerData.paymentMethod || 'cash',
        paymentStatus: 'pending',
        
        chatSessionId: `chat_${normalizedDriverPhone}_${normalizedPassengerPhone}`,
        locationSessionId: matchData.locationSessionId,
        
        lastUpdated: Date.now(),
        expiresAt: new Date(Date.now() + (24 * 60 * 60 * 1000)).toISOString()
      };
      
      await this.firestoreService.db.collection('active_rides').doc(activeRideId).set(rideData, { merge: true });
      
      console.log(`✅ Created active ride: ${activeRideId} with matchStatus: ${rideData.matchStatus}`);
      
      await this.firestoreService.db.collection('active_searches_driver').doc(normalizedDriverPhone).update({
        activeRideId: activeRideId,
        currentRideStatus: 'active',
        lastUpdated: Date.now()
      });
      
      await this.firestoreService.db.collection('active_searches_passenger').doc(normalizedPassengerPhone).update({
        activeRideId: activeRideId,
        currentRideStatus: 'active',
        lastUpdated: Date.now()
      });
      
      return rideData;
    } catch (error) {
      console.error('❌ Error creating active ride:', error);
      return null;
    }
  }
  
  async updateActiveRideForMatch(matchId, newStatus, updatedBy, reason, additionalData = {}) {
    try {
      console.log(`🔄 Updating active ride for match ${matchId} -> ${newStatus}`);
      
      const ridesSnapshot = await this.firestoreService.db.collection('active_rides')
        .where('matchId', '==', matchId)
        .limit(1)
        .get();
      
      if (ridesSnapshot.empty) {
        console.log(`ℹ️ No active ride found for match ${matchId}`);
        return false;
      }
      
      const rideDoc = ridesSnapshot.docs[0];
      const updateData = {
        matchStatus: newStatus,
        lastUpdated: Date.now(),
        [`${newStatus}By`]: updatedBy,
        [`${newStatus}Reason`]: reason,
        [`${newStatus}At`]: this.getServerTimestamp(),
        ...additionalData
      };
      
      if (newStatus === 'cancelled' || newStatus === 'declined' || newStatus === 'expired') {
        updateData.status = 'cancelled';
        updateData.rideStatus = 'cancelled';
      } else if (newStatus === 'completed') {
        updateData.status = 'completed';
        updateData.rideStatus = 'completed';
      }
      
      await rideDoc.ref.update(updateData);
      console.log(`✅ Updated active ride ${rideDoc.id} matchStatus to ${newStatus}`);
      return true;
    } catch (error) {
      console.error('❌ Error updating active ride:', error);
      return false;
    }
  }
  
  async getActiveRideForDriver(driverPhone) {
    try {
      const normalizedDriverPhone = this.normalizePhone(driverPhone);
      
      const ridesSnapshot = await this.firestoreService.db.collection('active_rides')
        .where('driverPhone', '==', normalizedDriverPhone)
        .where('status', 'in', ['active', 'in_progress'])
        .orderBy('rideCreatedAt', 'desc')
        .limit(1)
        .get();
      
      if (ridesSnapshot.empty) {
        const driverDoc = await this.firestoreService.db.collection('active_searches_driver').doc(normalizedDriverPhone).get();
        if (driverDoc.exists && driverDoc.data().activeRideId) {
          const rideDoc = await this.firestoreService.db.collection('active_rides').doc(driverDoc.data().activeRideId).get();
          if (rideDoc.exists) {
            return { success: true, ride: rideDoc.data() };
          }
        }
        return { success: false, message: 'No active ride found' };
      }
      
      const rideDoc = ridesSnapshot.docs[0];
      return { success: true, ride: rideDoc.data() };
    } catch (error) {
      console.error('❌ Error getting active ride for driver:', error);
      return { success: false, error: error.message };
    }
  }
  
  async getActiveRideForPassenger(passengerPhone) {
    try {
      const normalizedPassengerPhone = this.normalizePhone(passengerPhone);
      
      const ridesSnapshot = await this.firestoreService.db.collection('active_rides')
        .where('passengerPhone', '==', normalizedPassengerPhone)
        .where('status', 'in', ['active', 'in_progress'])
        .orderBy('rideCreatedAt', 'desc')
        .limit(1)
        .get();
      
      if (ridesSnapshot.empty) {
        const passengerDoc = await this.firestoreService.db.collection('active_searches_passenger').doc(normalizedPassengerPhone).get();
        if (passengerDoc.exists && passengerDoc.data().activeRideId) {
          const rideDoc = await this.firestoreService.db.collection('active_rides').doc(passengerDoc.data().activeRideId).get();
          if (rideDoc.exists) {
            return { success: true, ride: rideDoc.data() };
          }
        }
        return { success: false, message: 'No active ride found' };
      }
      
      const rideDoc = ridesSnapshot.docs[0];
      return { success: true, ride: rideDoc.data() };
    } catch (error) {
      console.error('❌ Error getting active ride for passenger:', error);
      return { success: false, error: error.message };
    }
  }
  
  async getAllActivePassengersForDriver(driverPhone) {
    try {
      const normalizedDriverPhone = this.normalizePhone(driverPhone);
      
      const ridesSnapshot = await this.firestoreService.db.collection('active_rides')
        .where('driverPhone', '==', normalizedDriverPhone)
        .where('status', 'in', ['active', 'in_progress'])
        .orderBy('rideCreatedAt', 'desc')
        .get();
      
      if (ridesSnapshot.empty) {
        return { success: true, passengers: [] };
      }
      
      const passengers = ridesSnapshot.docs.map(doc => {
        const ride = doc.data();
        return {
          rideId: ride.rideId,
          passengerPhone: ride.passengerPhone,
          passengerName: ride.passengerInfo?.name,
          passengerPhotoUrl: ride.passengerInfo?.photoUrl,
          passengerCount: ride.passengerCount,
          pickup: ride.pickup,
          destination: ride.destination,
          rideStatus: ride.rideStatus,
          passengerField: ride.passengerField,
          estimatedFare: ride.estimatedFare,
          matchAcceptedAt: ride.matchAcceptedAt,
          currentDriverLocation: ride.currentDriverLocation,
          driverArrivedAtPickup: ride.driverArrivedAtPickup,
          passengerBoarded: ride.passengerBoarded
        };
      });
      
      return { success: true, passengers };
    } catch (error) {
      console.error('❌ Error getting active passengers for driver:', error);
      return { success: false, error: error.message };
    }
  }
  
  async updateRideStatus(rideId, status, updatedBy, additionalData = {}) {
    try {
      const rideRef = this.firestoreService.db.collection('active_rides').doc(rideId);
      const rideDoc = await rideRef.get();
      
      if (!rideDoc.exists) {
        return { success: false, error: 'Ride not found' };
      }
      
      const updateData = {
        rideStatus: status,
        lastUpdated: Date.now(),
        [`${status}At`]: this.getServerTimestamp(),
        ...additionalData
      };
      
      switch (status) {
        case 'pickup_confirmed':
          updateData.pickupConfirmedAt = this.getServerTimestamp();
          updateData.driverArrivedAtPickup = true;
          break;
        case 'enroute':
          updateData.rideStartedAt = this.getServerTimestamp();
          updateData.passengerBoarded = true;
          break;
        case 'arrived':
          updateData.arrivedAtDestinationAt = this.getServerTimestamp();
          break;
        case 'completed':
          updateData.rideCompletedAt = this.getServerTimestamp();
          updateData.status = 'completed';
          updateData.paymentStatus = additionalData.paymentStatus || 'paid';
          updateData.actualFare = additionalData.actualFare || rideDoc.data().estimatedFare;
          break;
      }
      
      await rideRef.update(updateData);
      
      const rideData = rideDoc.data();
      
      if (this.websocketServer?.sendToUser) {
        const notification = {
          type: 'RIDE_STATUS_UPDATE',
          data: {
            rideId,
            status,
            updatedBy,
            timestamp: new Date().toISOString(),
            ...additionalData
          }
        };
        
        await this.websocketServer.sendToUser(rideData.driverPhone, notification);
        await this.websocketServer.sendToUser(rideData.passengerPhone, notification);
      }
      
      return { success: true, rideId, status };
    } catch (error) {
      console.error('❌ Error updating ride status:', error);
      return { success: false, error: error.message };
    }
  }
  
  async updateDriverLocationInRide(driverPhone, location) {
    try {
      const normalizedDriverPhone = this.normalizePhone(driverPhone);
      
      const ridesSnapshot = await this.firestoreService.db.collection('active_rides')
        .where('driverPhone', '==', normalizedDriverPhone)
        .where('status', 'in', ['active', 'in_progress'])
        .limit(1)
        .get();
      
      if (ridesSnapshot.empty) {
        return { success: false, message: 'No active ride found' };
      }
      
      const rideDoc = ridesSnapshot.docs[0];
      const rideRef = rideDoc.ref;
      
      await rideRef.update({
        currentDriverLocation: location,
        lastLocationUpdate: Date.now(),
        lastUpdated: Date.now()
      });
      
      const rideData = rideDoc.data();
      
      if (this.websocketServer?.sendToUser) {
        await this.websocketServer.sendToUser(rideData.passengerPhone, {
          type: 'DRIVER_LOCATION_UPDATE',
          data: {
            rideId: rideData.rideId,
            driverLocation: location,
            timestamp: Date.now(),
            distanceToPickup: this.calculateDistance(
              location.lat, location.lng,
              rideData.pickup.location.lat, rideData.pickup.location.lng
            )
          }
        });
      }
      
      return { success: true, rideId: rideData.rideId };
    } catch (error) {
      console.error('❌ Error updating driver location in ride:', error);
      return { success: false, error: error.message };
    }
  }
  
  async updatePassengerLocationInRide(passengerPhone, location) {
    try {
      const normalizedPassengerPhone = this.normalizePhone(passengerPhone);
      
      const ridesSnapshot = await this.firestoreService.db.collection('active_rides')
        .where('passengerPhone', '==', normalizedPassengerPhone)
        .where('status', 'in', ['active', 'in_progress'])
        .limit(1)
        .get();
      
      if (ridesSnapshot.empty) {
        return { success: false, message: 'No active ride found' };
      }
      
      const rideDoc = ridesSnapshot.docs[0];
      const rideRef = rideDoc.ref;
      
      await rideRef.update({
        currentPassengerLocation: location,
        lastLocationUpdate: Date.now(),
        lastUpdated: Date.now()
      });
      
      return { success: true, rideId: rideDoc.data().rideId };
    } catch (error) {
      console.error('❌ Error updating passenger location in ride:', error);
      return { success: false, error: error.message };
    }
  }
  
  async cleanupOldRides() {
    try {
      const twentyFourHoursAgo = new Date(Date.now() - (24 * 60 * 60 * 1000));
      
      const ridesSnapshot = await this.firestoreService.db.collection('active_rides')
        .where('rideCompletedAt', '<', twentyFourHoursAgo)
        .where('status', '==', 'completed')
        .limit(50)
        .get();
      
      const batch = this.firestoreService.db.batch();
      let deletedCount = 0;
      
      ridesSnapshot.docs.forEach(doc => {
        batch.delete(doc.ref);
        deletedCount++;
      });
      
      if (deletedCount > 0) {
        await batch.commit();
        console.log(`🧹 Cleaned up ${deletedCount} old completed rides`);
      }
    } catch (error) {
      console.error('❌ Error cleaning up old rides:', error);
    }
  }
}

module.exports = MatchingService;
