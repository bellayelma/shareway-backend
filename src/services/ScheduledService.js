// services/ScheduledService.js
// ULTRA OPTIMIZED - Matches all users, minimal CPU/RAM, minimal Firestore reads/writes
// WITH REAL-TIME TRIGGER MATCHING AND STATUS DEBUGGING
// ADDED: Timeout for expired pending matches (15 min)

const logger = require('../utils/Logger');

class ScheduledService {
  constructor(firestoreService, websocketServer, admin, notificationService) {
    console.log('🚀 [SCHEDULED] Initializing ULTRA OPTIMIZED version with REAL-TIME triggers and STATUS FIXES...');
    
    this.firestoreService = firestoreService;
    this.websocketServer = websocketServer;
    this.admin = admin;
    this.notification = notificationService;
    
    // OPTIMIZATION: Extremely conservative settings for free tier
    this.MATCHING_INTERVAL = 120000; // 120 seconds (2 minutes) - reduces reads by 75%
    this.MATCH_EXPIRY = 30 * 60 * 1000; // 30 minutes - longer expiry reduces rewrites
    this.PENDING_EXPIRY = 15 * 60 * 1000; // 15 minutes - timeout for pending matches
    this.MAX_MATCHES_PER_CYCLE = 5; // Still process up to 5 matches
    
    // THRESHOLDS - Set very high to match everyone
    this.DISTANCE_THRESHOLD = 999999999; // Effectively unlimited (matches everyone)
    this.DESTINATION_THRESHOLD = 999999999; // Effectively unlimited
    this.MIN_MATCH_SCORE = 1; // ANY score above 0 will match
    
    this.matchingInterval = null;
    this.cycleCount = 0;
    this.lastMatchRun = 0;
    
    // OPTIMIZATION: Aggressive caching
    this.recentMatches = new Map();
    this.RECENT_MATCH_TTL = 600000; // 10 minutes (longer to prevent repeats)
    
    this.userCache = new Map();
    this.USER_CACHE_TTL = 900000; // 15 minutes (longer cache = fewer reads)
    
    // OPTIMIZATION: Batch processing
    this.matchQueue = [];
    this.processingMatches = false;
    
    // Real-time trigger tracking to prevent spam
    this.lastTriggerTime = 0;
    this.MIN_TRIGGER_INTERVAL = 5000; // Minimum 5 seconds between manual triggers
    
    logger.info('SCHEDULED_SERVICE', '🚀 ULTRA OPTIMIZED mode - Matches ALL users, minimal resource usage');
  }

  // ========== LIFECYCLE ==========

  async start() {
    console.log('🚀 [SCHEDULED] Starting ULTRA OPTIMIZED mode - Will match ALL users regardless of location/time');
    console.log('📊 Settings: Interval=120s, Cache TTL=15min, Match expiry=30min, Pending expiry=15min');
    
    // Test connection once
    await this.testConnection();
    
    // Start matching interval - runs every 2 minutes
    this.matchingInterval = setInterval(async () => {
      this.cycleCount++;
      
      // Run matching every cycle (but cycles are 2 minutes apart)
      logger.info('SCHEDULED_SERVICE', `🔄 Cycle #${this.cycleCount}`);
      const startTime = Date.now();
      
      await this.performMatching();
      await this.cleanupExpiredMatches();
      
      const duration = Date.now() - startTime;
      console.log(`⏱️ Cycle completed in ${duration}ms`);
      
      // Clean up caches periodically
      if (this.cycleCount % 5 === 0) {
        this.cleanupRecentMatches();
        this.cleanupUserCache();
      }
      
    }, this.MATCHING_INTERVAL);
    
    logger.info('SCHEDULED_SERVICE', '✅ Started ULTRA OPTIMIZED mode');
    return true;
  }

  async testConnection() {
    try {
      await this.firestoreService.setDocument('scheduled_test', 'connection_test', { 
        test: true, 
        timestamp: new Date().toISOString() 
      });
      console.log('✅ [SCHEDULED] Firestore connection OK');
    } catch (error) {
      console.error('❌ [SCHEDULED] Firestore error:', error.message);
    }
  }

  stop() {
    if (this.matchingInterval) {
      clearInterval(this.matchingInterval);
      this.matchingInterval = null;
    }
    
    // Clear all caches
    this.recentMatches.clear();
    this.userCache.clear();
    this.matchQueue = [];
    
    logger.info('SCHEDULED_SERVICE', '🛑 Stopped');
  }

  // ========== CACHE MANAGEMENT ==========

  getUserFromCache(phoneNumber, type = '') {
    const key = `${type}_${phoneNumber}`;
    const cached = this.userCache.get(key);
    if (cached && Date.now() - cached.timestamp < this.USER_CACHE_TTL) {
      this.firestoreService.stats.cacheHits++;
      return cached.data;
    }
    return null;
  }

  setUserCache(phoneNumber, data, type = '') {
    const key = `${type}_${phoneNumber}`;
    this.userCache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  cleanupRecentMatches() {
    const now = Date.now();
    let count = 0;
    for (const [key, timestamp] of this.recentMatches.entries()) {
      if (now - timestamp > this.RECENT_MATCH_TTL) {
        this.recentMatches.delete(key);
        count++;
      }
    }
    if (count > 0) console.log(`🧹 Cleaned ${count} recent matches from cache`);
  }

  cleanupUserCache() {
    const now = Date.now();
    let count = 0;
    for (const [key, value] of this.userCache.entries()) {
      if (now - value.timestamp > this.USER_CACHE_TTL) {
        this.userCache.delete(key);
        count++;
      }
    }
    if (count > 0) console.log(`🧹 Cleaned ${count} user cache entries`);
  }

  // ========== PHONE UTILITIES ==========

  sanitizePhoneNumber(phoneNumber) {
    return this.notification.sanitizePhoneNumber(phoneNumber);
  }

  // ========== REAL-TIME TRIGGER MATCHING ==========
  
  /**
   * TRIGGER MATCHING IMMEDIATELY when a new user joins or status changes
   * This bypasses the 2-minute waiting cycle
   */
  async triggerMatching(triggeredBy = 'new_user') {
    console.log(`⚡ [TRIGGER] Matching triggered immediately by: ${triggeredBy}`);
    
    // Run matching immediately (not waiting for interval)
    // Use setTimeout to not block the current operation
    setTimeout(async () => {
      try {
        // ✅ First check for expired matches
        await this.checkExpiredPendingMatches();
        
        // Then run matching
        await this.performMatching();
        await this.cleanupExpiredMatches();
        console.log(`✅ [TRIGGER] Immediate matching completed for: ${triggeredBy}`);
      } catch (error) {
        console.error(`❌ [TRIGGER] Error:`, error.message);
      }
    }, 500); // Small delay to ensure the new user data is saved
  }

  // ========== DEBUG METHODS ==========

  /**
   * DEBUG: Monitor user status
   */
  async debugUserStatus(phoneNumber, userType) {
    try {
      const sanitizedPhone = this.sanitizePhoneNumber(phoneNumber);
      const collectionName = userType === 'driver' 
        ? 'scheduled_searches_driver' 
        : 'scheduled_searches_passenger';
      
      const doc = await this.firestoreService.getDocument(collectionName, sanitizedPhone);
      
      if (doc && doc.exists) {
        const data = doc.data();
        console.log(`🔍 [DEBUG] ${userType} ${phoneNumber} status: ${data.status}`);
        console.log(`🔍 [DEBUG] Full data:`, JSON.stringify(data).substring(0, 500));
        return data.status;
      } else {
        console.log(`🔍 [DEBUG] ${userType} ${phoneNumber} not found`);
        return null;
      }
    } catch (error) {
      console.error(`❌ [DEBUG] Error:`, error.message);
      return null;
    }
  }

  // ========== CREATE SCHEDULED SEARCH ==========

  async handleCreateScheduledSearch(data, userId, userType) {
    console.log(`📝 [SCHEDULED] Create for ${userType}: ${userId}`);
    
    try {
      if (!userId) throw new Error('User ID required');
      if (!userType || !['driver', 'passenger'].includes(userType)) {
        throw new Error('Valid user type required');
      }
      
      const sanitizedPhone = this.sanitizePhoneNumber(userId);
      const collectionName = userType === 'driver' 
        ? 'scheduled_searches_driver' 
        : 'scheduled_searches_passenger';
      
      // Parse scheduled time
      let scheduledTime = data.scheduledTime || data.departureTime;
      if (userType === 'passenger') {
        scheduledTime = data.rideDetails?.scheduledTime || scheduledTime;
      }
      
      if (!scheduledTime) throw new Error('Scheduled time required');
      
      const parsedTime = new Date(scheduledTime);
      if (isNaN(parsedTime.getTime())) throw new Error('Invalid time format');
      
      const scheduledTimestamp = parsedTime.getTime();
      const timeString = parsedTime.toISOString();
      
      // Build base document - FORCE status to 'actively_matching'
      let scheduledSearchData = {
        type: userType === 'driver' ? 'CREATE_SCHEDULED_SEARCH' : 'SCHEDULE_SEARCH',
        userId,
        sanitizedUserId: sanitizedPhone,
        userType,
        status: 'actively_matching', // FORCE this value
        scheduledTime: timeString,
        scheduledTimestamp,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastUpdated: Date.now()
      };
      
      // Add type-specific fields
      if (userType === 'driver') {
        scheduledSearchData = {
          ...scheduledSearchData,
          availableSeats: data.availableSeats || data.capacity || 4,
          initialSeats: data.availableSeats || data.capacity || 4,
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
          acceptedPassengers: [],
          rejectedMatches: [],
          cancelledPassengersHistory: [],
          totalAcceptedPassengers: 0,
          vehicleInfo: {
            type: data.vehicleType || 'Car',
            model: data.vehicleModel || 'Standard',
            color: data.vehicleColor || 'Not specified',
            plate: data.licensePlate || 'Not specified',
            capacity: data.availableSeats || data.capacity || 4,
            driverName: data.driverName || 'Driver',
            driverPhone: userId,
            driverRating: data.rating || 5.0,
            driverPhotoUrl: data.profilePhoto || data.driverPhoto || null
          }
        };
        
        // Enrich with user profile
        scheduledSearchData = await this.enrichDriverData(userId, scheduledSearchData);
        
      } else { // passenger
        const passengerInfo = {
          name: data.passenger?.name || data.passengerName || 'Passenger',
          phone: data.passenger?.phone || userId,
          rating: data.rating || 5.0,
          photoUrl: data.passenger?.photoUrl || data.passengerPhotoUrl || null
        };
        
        scheduledSearchData = {
          ...scheduledSearchData,
          passengerInfo,
          passengerName: passengerInfo.name,
          passengerPhone: userId,
          passengerPhotoUrl: passengerInfo.photoUrl,
          passengerCount: data.passengerCount || 1,
          pickupLocation: data.pickupLocation || null,
          destinationLocation: data.destinationLocation || null,
          pickupName: data.pickupName || 'Pickup location',
          destinationName: data.destinationName || 'Destination',
          luggageCount: data.luggageCount || 0,
          specialRequests: data.specialRequests || '',
          paymentMethod: data.paymentMethod || 'cash',
          estimatedFare: data.estimatedFare || 0,
          matchHistory: [],
          rideDetails: {
            scheduledTime: timeString,
            scheduledTimestamp,
            pickupName: data.pickupName || 'Pickup location',
            destinationName: data.destinationName || 'Destination',
            pickupLocation: data.pickupLocation || null,
            destinationLocation: data.destinationLocation || null,
            passengerCount: data.passengerCount || 1,
            passenger: passengerInfo
          }
        };
      }
      
      // OPTIMIZATION: Use documentExists to check first (reduces reads)
      const exists = await this.firestoreService.documentExists(collectionName, sanitizedPhone);
      
      if (exists) {
        const docSnapshot = await this.firestoreService.getDocument(collectionName, sanitizedPhone);
        const existing = docSnapshot.data();
        const previousVersions = existing.previousVersions || [];
        previousVersions.unshift({
          status: existing.status,
          updatedAt: existing.updatedAt,
          archivedAt: new Date().toISOString()
        });
        
        if (previousVersions.length > 5) previousVersions.pop();
        
        // Update existing document
        await this.firestoreService.updateDocument(collectionName, sanitizedPhone, {
          ...scheduledSearchData,
          createdAt: existing.createdAt,
          previousVersions,
          updatedAt: new Date().toISOString()
        });
      } else {
        // Create new document
        await this.firestoreService.setDocument(collectionName, sanitizedPhone, { 
          ...scheduledSearchData, 
          previousVersions: [] 
        });
      }
      
      // Update cache
      this.setUserCache(sanitizedPhone, scheduledSearchData, userType);
      
      console.log(`✅ [SCHEDULED] Created for ${sanitizedPhone} with status: actively_matching`);
      
      // DEBUG: Check status immediately after creation
      await this.debugUserStatus(userId, userType);
      
      // OPTIMIZATION: Only notify via WebSocket, not FCM for creation
      if (this.websocketServer?.broadcast) {
        this.websocketServer.broadcast('scheduled_updates', {
          type: 'scheduled_search_created',
          userId,
          userType,
          searchId: sanitizedPhone,
          scheduledTime: timeString
        });
      }
      
      // ✅ TRIGGER IMMEDIATE MATCHING for the new user!
      console.log(`⚡ Triggering immediate matching for new ${userType}`);
      this.triggerMatching(`new_${userType}_${userId}`).catch(err => 
        console.error('Background matching error:', err.message)
      );
      
      return {
        success: true,
        userId,
        userType,
        searchId: sanitizedPhone,
        scheduledTime: timeString
      };
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Create error:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== ENRICH DRIVER DATA (with caching) ==========

  async enrichDriverData(driverPhone, driverData) {
    try {
      const sanitizedPhone = this.sanitizePhoneNumber(driverPhone);
      
      // Check cache first
      let userData = this.getUserFromCache(sanitizedPhone, 'user');
      
      if (!userData) {
        const userDoc = await this.firestoreService.getDocument('users', sanitizedPhone);
        if (userDoc.exists) {
          userData = userDoc.data();
          this.setUserCache(sanitizedPhone, userData, 'user');
        }
      }
      
      if (userData) {
        const realName = userData.name || userData.displayName || userData.fullName;
        const realPhoto = userData.photoUrl || userData.photoURL || userData.profilePhoto;
        
        driverData.driverName = realName || driverData.driverName;
        driverData.profilePhoto = realPhoto || driverData.profilePhoto;
        
        if (driverData.vehicleInfo) {
          driverData.vehicleInfo.driverName = realName || driverData.vehicleInfo.driverName;
          driverData.vehicleInfo.driverPhotoUrl = realPhoto || driverData.vehicleInfo.driverPhotoUrl;
        }
      }
    } catch (error) {
      console.error('❌ [SCHEDULED] Enrich error:', error.message);
    }
    
    return driverData;
  }

  // ========== GET ACTIVE SEARCHES (ULTRA OPTIMIZED) ==========

  async getActiveScheduledSearches(userType) {
    try {
      // OPTIMIZATION: Use the firestoreService's optimized method
      const results = await this.firestoreService.getActiveMatchingDocuments(userType);
      
      // Further filter in memory (minimal cost)
      return results.filter(item => {
        const data = item.data ? item.data() : item.raw || item;
        if (!data) return false;
        
        // For drivers, check seats
        if (userType === 'driver') {
          const seats = data.availableSeats || 
                       data.capacity || 
                       (data.vehicleInfo?.capacity) || 
                       4;
          return seats > 0;
        }
        
        // For passengers, always return if active
        return true;
      });
    } catch (error) {
      console.error(`❌ [SCHEDULED] Error getting ${userType}s:`, error.message);
      return [];
    }
  }

  async getUserScheduledSearch(userType, phoneNumber) {
    if (!phoneNumber) return null;
    
    const collectionName = userType === 'driver' 
      ? 'scheduled_searches_driver' 
      : 'scheduled_searches_passenger';
    
    const sanitizedPhone = this.sanitizePhoneNumber(phoneNumber);
    
    try {
      // Check cache first
      const cached = this.getUserFromCache(sanitizedPhone, userType);
      if (cached) return cached;
      
      const docSnapshot = await this.firestoreService.getDocument(collectionName, sanitizedPhone);
      
      if (!docSnapshot || !docSnapshot.exists) return null;
      
      const data = { 
        id: docSnapshot.id, 
        ...(docSnapshot.data ? docSnapshot.data() : docSnapshot)
      };
      
      // Cache the result
      this.setUserCache(sanitizedPhone, data, userType);
      
      return data;
    } catch (error) {
      console.error(`❌ [SCHEDULED] Error getting ${userType}:`, error.message);
      return null;
    }
  }

  async updateSearchStatus(userType, phoneNumber, updates) {
    if (!phoneNumber) return false;
    
    const collectionName = userType === 'driver' 
      ? 'scheduled_searches_driver' 
      : 'scheduled_searches_passenger';
    
    const sanitizedPhone = this.sanitizePhoneNumber(phoneNumber);
    
    try {
      const exists = await this.firestoreService.documentExists(collectionName, sanitizedPhone);
      
      if (!exists) return false;
      
      await this.firestoreService.updateDocument(collectionName, sanitizedPhone, {
        ...updates,
        updatedAt: new Date().toISOString(),
        lastUpdated: Date.now()
      });
      
      // Invalidate cache
      this.userCache.delete(`${userType}_${sanitizedPhone}`);
      
      // ✅ TRIGGER MATCHING when status changes (e.g., after rejection)
      if (updates.status === 'actively_matching') {
        console.log(`⚡ User ${phoneNumber} is now actively matching, triggering immediate match`);
        this.triggerMatching(`status_change_${userType}_${phoneNumber}`).catch(() => {});
      }
      
      return true;
    } catch (error) {
      console.error(`❌ [SCHEDULED] Error updating ${userType}:`, error.message);
      return false;
    }
  }

  // ========== CHECK EXPIRED PENDING MATCHES (THE FIX) ==========
  
  /**
   * Check for expired pending matches and reset them
   * This prevents users from getting stuck in pending_driver_approval state
   */
  async checkExpiredPendingMatches() {
    try {
      console.log('⏰ Checking for expired pending matches...');
      
      const now = new Date().toISOString();
      const expiryTime = new Date(Date.now() - this.PENDING_EXPIRY).toISOString(); // 15 minutes ago
      
      // Find passengers stuck in pending_driver_approval for too long
      const pendingPassengers = await this.firestoreService.queryCollection(
        'scheduled_searches_passenger',
        [
          { field: 'status', operator: '==', value: 'pending_driver_approval' },
          { field: 'updatedAt', operator: '<', value: expiryTime }
        ],
        20
      );
      
      if (pendingPassengers && pendingPassengers.length > 0) {
        console.log(`⏰ Found ${pendingPassengers.length} expired pending passengers`);
        
        for (const passenger of pendingPassengers) {
          console.log(`⏰ Resetting expired pending passenger: ${passenger.id}`);
          
          // Reset passenger to actively_matching
          await this.firestoreService.updateDocument('scheduled_searches_passenger', passenger.id, {
            status: 'actively_matching',
            matchId: null,
            matchedWith: null,
            matchStatus: null,
            updatedAt: new Date().toISOString()
          });
          
          // Invalidate cache
          this.userCache.delete(`passenger_${passenger.id}`);
        }
      }
      
      // Also check for expired matches and reset both parties
      const expiredMatches = await this.firestoreService.queryCollection(
        'scheduled_matches',
        [
          { field: 'status', operator: '==', value: 'awaiting_driver_approval' },
          { field: 'proposedAt', operator: '<', value: expiryTime }
        ],
        20
      );
      
      if (expiredMatches && expiredMatches.length > 0) {
        console.log(`⏰ Found ${expiredMatches.length} expired matches`);
        
        for (const match of expiredMatches) {
          console.log(`⏰ Expiring match: ${match.id}`);
          
          // Update match status
          await this.firestoreService.updateDocument('scheduled_matches', match.id, {
            status: 'expired',
            expiredAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
          
          // Reset passenger
          if (match.passengerPhone) {
            await this.firestoreService.updateDocument('scheduled_searches_passenger', match.passengerPhone, {
              status: 'actively_matching',
              matchId: null,
              matchedWith: null,
              matchStatus: null,
              updatedAt: new Date().toISOString()
            });
            
            // Invalidate cache
            this.userCache.delete(`passenger_${match.passengerPhone}`);
          }
          
          // Reset driver (remove pending match)
          if (match.driverPhone) {
            await this.firestoreService.updateDocument('scheduled_searches_driver', match.driverPhone, {
              pendingMatchId: null,
              pendingMatchWith: null,
              pendingMatchStatus: null,
              updatedAt: new Date().toISOString()
            });
            
            // Invalidate cache
            this.userCache.delete(`driver_${match.driverPhone}`);
          }
        }
      }
      
      if ((pendingPassengers?.length || 0) + (expiredMatches?.length || 0) > 0) {
        console.log(`✅ Cleaned up ${(pendingPassengers?.length || 0) + (expiredMatches?.length || 0)} expired pending items`);
      }
      
    } catch (error) {
      console.error('❌ Error checking expired matches:', error.message);
    }
  }

  // ========== ULTRA SIMPLE MATCHING ==========
  // This is a simplified version that WILL work

  async performMatching() {
    console.log('🤝 [SCHEDULED] ========== ULTRA SIMPLE MATCHING ==========');
    
    // ✅ FIRST: Clean up expired pending matches
    await this.checkExpiredPendingMatches();
    
    try {
      // DEBUG: Check status of known users
      await this.debugUserStatus('+251911240957', 'driver');
      await this.debugUserStatus('+251920121197', 'passenger');
      
      // Get ALL drivers and passengers (no filtering)
      const driversSnapshot = await this.firestoreService.getCollection('scheduled_searches_driver');
      const passengersSnapshot = await this.firestoreService.getCollection('scheduled_searches_passenger');
      
      console.log(`📊 Raw drivers: ${driversSnapshot.length}, Raw passengers: ${passengersSnapshot.length}`);
      
      // Log all driver statuses
      driversSnapshot.forEach(d => {
        console.log(`📊 Driver ${d.id} status: ${d.status}`);
      });
      
      // Log all passenger statuses
      passengersSnapshot.forEach(p => {
        console.log(`📊 Passenger ${p.id} status: ${p.status}`);
      });
      
      // Filter manually - ONLY actively_matching users
      const activeDrivers = driversSnapshot.filter(d => d.status === 'actively_matching');
      const activePassengers = passengersSnapshot.filter(p => p.status === 'actively_matching');
      
      console.log(`📊 Active drivers: ${activeDrivers.length}, Active passengers: ${activePassengers.length}`);
      
      if (activeDrivers.length === 0) {
        console.log('ℹ️ No active drivers found');
        return;
      }
      
      if (activePassengers.length === 0) {
        console.log('ℹ️ No active passengers found');
        return;
      }
      
      // Take the first driver and first passenger
      const driver = activeDrivers[0];
      const passenger = activePassengers[0];
      
      console.log(`🎯 Creating match between driver ${driver.id} and passenger ${passenger.id}`);
      
      // Create match data
      const matchData = {
        driverId: driver.id,
        passengerId: passenger.id,
        driverPhone: driver.userId || driver.driverPhone || driver.id,
        passengerPhone: passenger.userId || passenger.passengerPhone || passenger.id,
        driverName: driver.driverName || 'Driver',
        passengerName: passenger.passengerName || 'Passenger',
        status: 'awaiting_driver_approval',
        proposedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + this.MATCH_EXPIRY).toISOString(),
        createdAt: new Date().toISOString(),
        passengerCount: passenger.passengerCount || 1,
        availableSeats: driver.availableSeats || 4
      };
      
      // Add additional details if available
      if (driver.pickupLocation) matchData.pickupLocation = driver.pickupLocation;
      if (driver.destinationLocation) matchData.destinationLocation = driver.destinationLocation;
      if (passenger.pickupName) matchData.pickupName = passenger.pickupName;
      if (passenger.destinationName) matchData.destinationName = passenger.destinationName;
      if (driver.scheduledTime) matchData.scheduledTime = driver.scheduledTime;
      if (passenger.scheduledTime) matchData.scheduledTime = passenger.scheduledTime;
      
      // Save match
      const matchId = await this.firestoreService.addDocument('scheduled_matches', matchData);
      console.log(`✅ Match created: ${matchId}`);
      
      // Update driver - KEEP status as actively_matching to continue matching
      await this.firestoreService.updateDocument('scheduled_searches_driver', driver.id, {
        pendingMatchId: matchId,
        pendingMatchWith: passenger.id,
        pendingMatchStatus: 'awaiting_driver_approval',
        updatedAt: new Date().toISOString()
      });
      console.log(`✅ Driver ${driver.id} updated with pending match`);
      
      // Update passenger
      await this.firestoreService.updateDocument('scheduled_searches_passenger', passenger.id, {
        status: 'pending_driver_approval',
        matchId: matchId,
        matchedWith: driver.id,
        matchStatus: 'awaiting_driver_approval',
        updatedAt: new Date().toISOString()
      });
      console.log(`✅ Passenger ${passenger.id} updated to pending_driver_approval`);
      
      // Send notification to driver
      await this.notification.sendNotification(matchData.driverPhone, {
        type: 'scheduled_match_proposed_to_driver',
        data: {
          matchId: matchId,
          passengerPhone: matchData.passengerPhone,
          passengerName: matchData.passengerName,
          tripDetails: {
            pickupName: matchData.pickupName || 'Pickup location',
            destinationName: matchData.destinationName || 'Destination',
            scheduledTime: matchData.scheduledTime,
            passengerCount: matchData.passengerCount
          }
        }
      }, { important: true });
      
      console.log('✅ Match created and notifications sent!');
      
      // DEBUG: Check updated statuses
      await this.debugUserStatus(matchData.driverPhone, 'driver');
      await this.debugUserStatus(matchData.passengerPhone, 'passenger');
      
    } catch (error) {
      console.error('❌ Matching error:', error.message);
    }
  }

  // ========== MATCH DECISION HANDLERS ==========

  async handleMatchDecision(matchId, userPhone, userType, decision, reason = '') {
    console.log(`🎯 [SCHEDULED] Decision: ${userType} ${decision} for ${matchId}`);
    
    if (!matchId || !userPhone || !userType || !decision) {
      return { success: false, error: 'Missing parameters' };
    }
    
    if (userType === 'driver') {
      return await this.handleDriverDecision(matchId, userPhone, decision);
    }
    
    return { success: false, error: 'Invalid user type' };
  }

  async handleDriverDecision(matchId, driverPhone, decision) {
    try {
      const matchDoc = await this.firestoreService.getDocument('scheduled_matches', matchId);
      
      if (!matchDoc || !matchDoc.exists) throw new Error('Match not found');
      
      const matchData = matchDoc.data ? matchDoc.data() : matchDoc;
      if (matchData.driverPhone !== driverPhone) throw new Error('Unauthorized');
      
      if (matchData.status === 'expired') {
        return { success: false, error: 'Match expired', matchId };
      }
      
      const updateData = {
        driverDecision: decision,
        driverDecisionAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      if (decision === 'accept') {
        // Get driver document (from cache if possible)
        const driverDoc = await this.getUserScheduledSearch('driver', driverPhone);
        if (!driverDoc) throw new Error('Driver not found');
        
        const passengerCount = matchData.matchDetails?.passengerCount || 
                              matchData.passengerCount || 
                              1;
        const currentSeats = driverDoc.availableSeats || 0;
        const newSeats = currentSeats - passengerCount;
        
        // ONE-STEP APPROVAL
        updateData.status = 'confirmed';
        updateData.confirmedAt = new Date().toISOString();
        updateData.passengerDecision = 'accept';
        updateData.passengerDecisionAt = new Date().toISOString();
        
        await this.firestoreService.updateDocument('scheduled_matches', matchId, updateData);
        
        // Create passenger record
        const passengerRecord = {
          passengerPhone: matchData.passengerPhone,
          passengerName: matchData.passengerName,
          passengerCount,
          profilePhoto: matchData.passengerDetails?.profilePhoto,
          matchId,
          acceptedAt: new Date().toISOString(),
          confirmedAt: new Date().toISOString(),
          status: 'confirmed',
          pickupName: matchData.pickupName,
          destinationName: matchData.destinationName,
          scheduledTime: matchData.scheduledTime
        };
        
        const currentAccepted = driverDoc.acceptedPassengers || [];
        const updatedAccepted = [...currentAccepted, passengerRecord];
        
        // Update driver
        const driverStatus = newSeats <= 0 ? 'fully_booked' : 'actively_matching';
        await this.updateSearchStatus('driver', driverPhone, {
          status: driverStatus,
          availableSeats: Math.max(0, newSeats),
          acceptedPassengers: updatedAccepted,
          totalAcceptedPassengers: (driverDoc.totalAcceptedPassengers || 0) + passengerCount,
          pendingMatchId: null,
          pendingMatchWith: null
        });
        
        // Update passenger
        await this.updateSearchStatus('passenger', matchData.passengerPhone, {
          status: 'matched_confirmed',
          matchId,
          matchedWith: driverPhone,
          matchStatus: 'confirmed',
          confirmedAt: new Date().toISOString(),
          driverDetails: {
            name: driverDoc.driverName,
            phone: driverPhone,
            photoUrl: driverDoc.profilePhoto,
            vehicleInfo: driverDoc.vehicleInfo
          }
        });
        
        // Send confirmations
        await Promise.all([
          this.notification.sendNotification(matchData.passengerPhone, {
            type: 'scheduled_match_confirmed',
            data: {
              matchId,
              confirmedBy: driverPhone,
              driverName: driverDoc.driverName,
              driverPhone,
              driverDetails: {
                name: driverDoc.driverName,
                phone: driverPhone,
                photoUrl: driverDoc.profilePhoto,
                vehicleInfo: driverDoc.vehicleInfo
              },
              pickupName: matchData.pickupName,
              destinationName: matchData.destinationName
            }
          }, { important: true }),
          
          this.notification.sendNotification(driverPhone, {
            type: 'scheduled_match_confirmed',
            data: {
              matchId,
              confirmedBy: driverPhone,
              passengerName: matchData.passengerName,
              passengerPhone: matchData.passengerPhone,
              passengerDetails: matchData.passengerDetails,
              seatsLeft: newSeats
            }
          }, { important: true })
        ]);
        
        console.log(`✅ [SCHEDULED] Match ${matchId} confirmed, seats left: ${newSeats}`);
        
      } else if (decision === 'reject') {
        updateData.status = 'driver_rejected';
        await this.firestoreService.updateDocument('scheduled_matches', matchId, updateData);
        
        const driverDoc = await this.getUserScheduledSearch('driver', driverPhone);
        
        const rejectedMatch = {
          matchId,
          passengerPhone: matchData.passengerPhone,
          passengerName: matchData.passengerName,
          rejectedAt: new Date().toISOString()
        };
        
        const currentRejected = driverDoc?.rejectedMatches || [];
        const updatedRejected = [...currentRejected, rejectedMatch];
        
        // Driver stays actively_matching
        await this.updateSearchStatus('driver', driverPhone, {
          status: 'actively_matching',
          pendingMatchId: null,
          pendingMatchWith: null,
          rejectedMatches: updatedRejected
        });
        
        // Passenger goes back to matching
        await this.updateSearchStatus('passenger', matchData.passengerPhone, {
          status: 'actively_matching',
          matchId: null,
          matchedWith: null
        });
        
        // Notify passenger
        await this.notification.sendNotification(matchData.passengerPhone, {
          type: 'scheduled_match_driver_declined',
          data: { matchId }
        });
      }
      
      return { success: true, matchId, decision };
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Driver decision error:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== CANCELLATION HANDLERS (with batched operations) ==========

  async handleDriverCancelAll(driverPhone, reason = 'driver_cancelled_trip') {
    console.log(`🚫 [SCHEDULED] Driver ${driverPhone} cancelling ALL`);
    
    try {
      const driverDoc = await this.getUserScheduledSearch('driver', driverPhone);
      if (!driverDoc) return { success: false, error: 'Driver not found' };
      
      const acceptedPassengers = driverDoc.acceptedPassengers || [];
      
      if (acceptedPassengers.length === 0) {
        return await this.cancelScheduledSearch(driverPhone, 'driver', reason);
      }
      
      // Use batched writes
      const batch = this.firestoreService.batch();
      
      // Update each passenger
      for (const passenger of acceptedPassengers) {
        const passengerPhone = this.sanitizePhoneNumber(passenger.passengerPhone);
        
        batch.update('scheduled_searches_passenger', passengerPhone, {
          status: 'cancelled_by_driver',
          cancelledAt: new Date().toISOString(),
          cancelledByDriver: { driverPhone, driverName: driverDoc.driverName, reason },
          matchId: null
        });
        
        this.userCache.delete(`passenger_${passengerPhone}`);
        
        if (passenger.matchId) {
          batch.update('scheduled_matches', passenger.matchId, {
            status: 'cancelled_by_driver',
            cancelledAt: new Date().toISOString(),
            cancellationReason: reason
          });
        }
        
        // Send notification (non-batch)
        await this.notification.sendNotification(passenger.passengerPhone, {
          type: 'DRIVER_CANCELLED_ALL',
          data: {
            driverName: driverDoc.driverName,
            reason,
            yourBooking: {
              pickupName: passenger.pickupName,
              destinationName: passenger.destinationName
            }
          }
        }, { important: true });
      }
      
      // Update driver
      batch.update('scheduled_searches_driver', this.sanitizePhoneNumber(driverPhone), {
        status: 'cancelled',
        cancelledAt: new Date().toISOString(),
        cancellationReason: reason,
        acceptedPassengers: [],
        cancelledPassengersHistory: [
          ...(driverDoc.cancelledPassengersHistory || []),
          { passengers: acceptedPassengers, cancelledAt: new Date().toISOString(), reason }
        ]
      });
      
      this.userCache.delete(`driver_${this.sanitizePhoneNumber(driverPhone)}`);
      
      await this.firestoreService.commitBatch(batch);
      
      return {
        success: true,
        cancelledPassengers: acceptedPassengers.length,
        message: `Cancelled ${acceptedPassengers.length} passengers`
      };
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Cancel all error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async handleDriverCancelPassenger(driverPhone, passengerPhone, reason = 'driver_cancelled_passenger') {
    console.log(`🚫 [SCHEDULED] Driver ${driverPhone} cancelling passenger ${passengerPhone}`);
    
    try {
      const driverDoc = await this.getUserScheduledSearch('driver', driverPhone);
      if (!driverDoc) return { success: false, error: 'Driver not found' };
      
      const acceptedPassengers = driverDoc.acceptedPassengers || [];
      const passengerIndex = acceptedPassengers.findIndex(p => p.passengerPhone === passengerPhone);
      
      if (passengerIndex === -1) {
        return { success: false, error: 'Passenger not found' };
      }
      
      const cancelledPassenger = acceptedPassengers[passengerIndex];
      const passengerCount = cancelledPassenger.passengerCount || 1;
      const currentSeats = driverDoc.availableSeats || 0;
      const restoredSeats = currentSeats + passengerCount;
      
      // Use batched writes
      const batch = this.firestoreService.batch();
      
      // Update driver
      const updatedAccepted = acceptedPassengers.filter((_, i) => i !== passengerIndex);
      const sanitizedDriverPhone = this.sanitizePhoneNumber(driverPhone);
      
      batch.update('scheduled_searches_driver', sanitizedDriverPhone, {
        acceptedPassengers: updatedAccepted,
        availableSeats: restoredSeats,
        status: restoredSeats > 0 ? 'actively_matching' : 'fully_booked',
        cancelledPassengersHistory: [
          ...(driverDoc.cancelledPassengersHistory || []),
          { passenger: cancelledPassenger, cancelledAt: new Date().toISOString(), reason }
        ]
      });
      
      this.userCache.delete(`driver_${sanitizedDriverPhone}`);
      
      // Update passenger
      const sanitizedPassengerPhone = this.sanitizePhoneNumber(passengerPhone);
      batch.update('scheduled_searches_passenger', sanitizedPassengerPhone, {
        status: 'cancelled_by_driver',
        cancelledAt: new Date().toISOString(),
        cancelledByDriver: { driverPhone, driverName: driverDoc.driverName, reason },
        matchId: null
      });
      
      this.userCache.delete(`passenger_${sanitizedPassengerPhone}`);
      
      if (cancelledPassenger.matchId) {
        batch.update('scheduled_matches', cancelledPassenger.matchId, {
          status: 'cancelled_by_driver',
          cancelledAt: new Date().toISOString(),
          cancellationReason: reason
        });
      }
      
      await this.firestoreService.commitBatch(batch);
      
      // Notify passenger
      await this.notification.sendNotification(passengerPhone, {
        type: 'DRIVER_CANCELLED_YOUR_RIDE',
        data: {
          driverName: driverDoc.driverName,
          reason,
          yourBooking: {
            pickupName: cancelledPassenger.pickupName,
            destinationName: cancelledPassenger.destinationName
          }
        }
      }, { important: true });
      
      return {
        success: true,
        cancelledPassenger: { name: cancelledPassenger.passengerName },
        availableSeats: restoredSeats
      };
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Cancel passenger error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async handlePassengerCancelRide(passengerPhone, driverPhone, reason = 'passenger_cancelled_ride') {
    console.log(`🚫 [SCHEDULED] Passenger ${passengerPhone} cancelling ride`);
    
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
        return { success: false, error: 'Passenger not found in driver list' };
      }
      
      const cancelledPassenger = acceptedPassengers[passengerIndex];
      const passengerCount = cancelledPassenger.passengerCount || 1;
      const currentSeats = driverDoc.availableSeats || 0;
      const restoredSeats = currentSeats + passengerCount;
      
      // Use batched writes
      const batch = this.firestoreService.batch();
      
      // Update driver
      const updatedAccepted = acceptedPassengers.filter((_, i) => i !== passengerIndex);
      const sanitizedDriverPhone = this.sanitizePhoneNumber(driverPhone);
      
      batch.update('scheduled_searches_driver', sanitizedDriverPhone, {
        acceptedPassengers: updatedAccepted,
        availableSeats: restoredSeats,
        status: restoredSeats > 0 ? 'actively_matching' : 'fully_booked',
        cancelledPassengersHistory: [
          ...(driverDoc.cancelledPassengersHistory || []),
          { passenger: cancelledPassenger, cancelledAt: new Date().toISOString(), cancelledBy: 'passenger', reason }
        ]
      });
      
      this.userCache.delete(`driver_${sanitizedDriverPhone}`);
      
      // Update passenger
      const sanitizedPassengerPhone = this.sanitizePhoneNumber(passengerPhone);
      batch.update('scheduled_searches_passenger', sanitizedPassengerPhone, {
        status: 'cancelled_by_passenger',
        cancelledAt: new Date().toISOString(),
        cancellationReason: reason,
        matchId: null
      });
      
      this.userCache.delete(`passenger_${sanitizedPassengerPhone}`);
      
      if (cancelledPassenger.matchId) {
        batch.update('scheduled_matches', cancelledPassenger.matchId, {
          status: 'cancelled_by_passenger',
          cancelledAt: new Date().toISOString(),
          cancellationReason: reason
        });
      }
      
      await this.firestoreService.commitBatch(batch);
      
      // Create cancellation record
      const cancellation = await this.notification.createCancellationRecord({
        cancellationType: 'passenger_cancelled',
        cancelledBy: passengerPhone,
        driverDetails: { phone: driverPhone, name: driverDoc.driverName },
        passengerDetails: cancelledPassenger,
        reason,
        afterCancellation: { driverAvailableSeats: restoredSeats }
      });
      
      // Notify driver
      await this.notification.sendNotification(driverPhone, {
        type: 'PASSENGER_CANCELLED_RIDE',
        data: {
          passengerName: passengerDoc.passengerName,
          reason,
          cancelledRide: {
            pickupName: cancelledPassenger.pickupName,
            destinationName: cancelledPassenger.destinationName
          },
          availableSeats: restoredSeats
        }
      }, { important: true });
      
      // Notify passenger
      await this.notification.sendNotification(passengerPhone, {
        type: 'PASSENGER_CANCELLATION_CONFIRMED',
        data: {
          success: true,
          cancellationId: cancellation.id,
          driverName: driverDoc.driverName
        }
      }, { important: true });
      
      return {
        success: true,
        cancellationId: cancellation.id,
        driverUpdate: { availableSeats: restoredSeats }
      };
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Passenger cancel error:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== GET ACCEPTED PASSENGERS ==========

  async getDriverAcceptedPassengers(driverPhone) {
    try {
      const driverDoc = await this.getUserScheduledSearch('driver', driverPhone);
      
      if (!driverDoc) {
        return { success: false, error: 'Driver not found', passengers: [] };
      }
      
      const passengers = (driverDoc.acceptedPassengers || []).map(p => ({
        ...p,
        displayName: p.passengerName,
        photoUrl: p.profilePhoto,
        timeUntilPickup: this.calculateTimeUntilPickup(p.scheduledTime)
      }));
      
      return {
        success: true,
        passengers,
        totalPassengers: passengers.length,
        availableSeats: driverDoc.availableSeats || 0,
        driverStatus: driverDoc.status,
        driverName: driverDoc.driverName,
        driverDoc: {
          id: driverDoc.id,
          driverName: driverDoc.driverName,
          availableSeats: driverDoc.availableSeats,
          status: driverDoc.status,
          scheduledTime: driverDoc.scheduledTime,
          pickupName: driverDoc.pickupName,
          destinationName: driverDoc.destinationName,
          vehicleInfo: driverDoc.vehicleInfo
        }
      };
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Get passengers error:', error.message);
      return { success: false, error: error.message, passengers: [] };
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
      
      if (diffHours > 24) return `${Math.floor(diffHours / 24)}d`;
      if (diffHours > 0) return `${diffHours}h ${remainingMins}m`;
      return `${diffMins}m`;
    } catch {
      return 'Unknown';
    }
  }

  // ========== HELPER METHODS ==========

  extractLocation(data, fieldName) {
    try {
      if (!data) return null;
      
      // Handle nested data structures
      const source = data.data || data;
      const loc = source[fieldName];
      
      if (!loc) return null;
      
      if (typeof loc === 'object') {
        if (loc.lat !== undefined && loc.lng !== undefined) {
          return { latitude: loc.lat, longitude: loc.lng };
        }
        if (loc.latitude !== undefined && loc.longitude !== undefined) {
          return { latitude: loc.latitude, longitude: loc.longitude };
        }
        // Handle GeoPoint
        if (loc._lat !== undefined && loc._long !== undefined) {
          return { latitude: loc._lat, longitude: loc._long };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  extractTime(data) {
    try {
      if (!data) return Date.now();
      
      const source = data.data || data;
      const sources = [
        source.scheduledTimestamp,
        source.scheduledTime,
        source.rideDetails?.scheduledTime,
        source.createdAt
      ];
      
      for (const src of sources) {
        if (!src) continue;
        if (typeof src === 'number') return src;
        if (typeof src === 'string') {
          const ts = new Date(src).getTime();
          if (!isNaN(ts)) return ts;
        }
      }
      return Date.now();
    } catch {
      return Date.now();
    }
  }

  extractDriverDetails(data) {
    const source = data.data || data;
    return {
      name: source.driverName || 'Driver',
      phone: source.driverPhone || source.userId,
      vehicleInfo: source.vehicleInfo || {},
      vehicleType: source.vehicleType || 'Car',
      vehicleModel: source.vehicleModel || 'Standard',
      vehicleColor: source.vehicleColor || 'Not specified',
      licensePlate: source.licensePlate || 'Not specified',
      rating: source.rating || 5.0,
      profilePhoto: source.profilePhoto || null,
      availableSeats: source.availableSeats || 4
    };
  }

  extractPassengerDetails(data) {
    const source = data.data || data;
    return {
      name: source.passengerName || 'Passenger',
      phone: source.passengerPhone || source.userId,
      passengerCount: source.passengerCount || 1,
      profilePhoto: source.passengerPhotoUrl || source.passengerInfo?.photoUrl || null,
      rating: source.rating || 5.0
    };
  }

  calculateDistance(loc1, loc2) {
    if (!loc1 || !loc2) return 10000; // Return medium distance if missing
    
    try {
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
    } catch {
      return 10000;
    }
  }

  // ========== CANCEL SCHEDULED SEARCH ==========

  async cancelScheduledSearch(userId, userType, reason = 'user_cancelled') {
    if (!userId) return { success: false, error: 'User ID required' };
    
    try {
      const collectionName = userType === 'driver' 
        ? 'scheduled_searches_driver' 
        : 'scheduled_searches_passenger';
      
      const sanitizedPhone = this.sanitizePhoneNumber(userId);
      const exists = await this.firestoreService.documentExists(collectionName, sanitizedPhone);
      
      if (!exists) {
        return { success: false, error: 'No active search found' };
      }
      
      await this.firestoreService.updateDocument(collectionName, sanitizedPhone, {
        status: 'cancelled',
        cancelledAt: new Date().toISOString(),
        cancellationReason: reason,
        updatedAt: new Date().toISOString()
      });
      
      // Invalidate cache
      this.userCache.delete(`${userType}_${sanitizedPhone}`);
      
      return { success: true, searchId: sanitizedPhone };
    } catch (error) {
      console.error('❌ [SCHEDULED] Cancel error:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== CLEANUP (OPTIMIZED) ==========

  async cleanupExpiredMatches() {
    try {
      const expiryTime = new Date(Date.now() - this.MATCH_EXPIRY).toISOString();
      
      const constraints = [
        { field: 'status', operator: 'in', value: ['awaiting_driver_approval', 'awaiting_passenger_approval'] },
        { field: 'proposedAt', operator: '<', value: expiryTime }
      ];
      
      const matches = await this.firestoreService.queryCollection(
        'scheduled_matches',
        constraints,
        20 // Limit cleanup
      );
      
      if (!matches || matches.length === 0) return 0;
      
      // Use batched writes for cleanup
      const batch = this.firestoreService.batch();
      let cleaned = 0;
      
      for (const match of matches) {
        batch.update('scheduled_matches', match.id, {
          status: 'expired',
          expiredAt: new Date().toISOString()
        });
        cleaned++;
      }
      
      if (cleaned > 0) {
        await this.firestoreService.commitBatch(batch);
        console.log(`🧹 [SCHEDULED] Cleaned ${cleaned} expired matches`);
      }
      
      return cleaned;
    } catch (error) {
      console.error('❌ [SCHEDULED] Cleanup error:', error.message);
      return 0;
    }
  }

  // ========== STATUS AND STATS (OPTIMIZED) ==========

  async getScheduledSearchStatus(phoneNumber) {
    try {
      const sanitizedPhone = this.sanitizePhoneNumber(phoneNumber);
      
      const [driver, passenger] = await Promise.all([
        this.getUserScheduledSearch('driver', sanitizedPhone),
        this.getUserScheduledSearch('passenger', sanitizedPhone)
      ]);
      
      return {
        success: true,
        phoneNumber: sanitizedPhone,
        hasDriverScheduled: !!driver,
        hasPassengerScheduled: !!passenger,
        driverData: driver || null,
        passengerData: passenger || null
      };
    } catch (error) {
      console.error('❌ [SCHEDULED] Status error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getStats() {
    try {
      // Use the firestoreService stats directly
      const firestoreStats = this.firestoreService.getStats();
      
      return {
        success: true,
        stats: {
          cycleCount: this.cycleCount,
          recentMatchesCacheSize: this.recentMatches.size,
          userCacheSize: this.userCache.size,
          matchQueueLength: this.matchQueue.length,
          firestore: firestoreStats,
          lastTriggerTime: this.lastTriggerTime,
          timestamp: new Date().toISOString()
        }
      };
    } catch (error) {
      console.error('❌ [SCHEDULED] Stats error:', error.message);
      return { success: false, error: error.message };
    }
  }
}

module.exports = ScheduledService;
