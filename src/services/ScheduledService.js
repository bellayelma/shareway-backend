// services/ScheduledService.js
// ULTRA OPTIMIZED - Matches all users, minimal CPU/RAM, minimal Firestore reads/writes

const logger = require('../utils/Logger');

class ScheduledService {
  constructor(firestoreService, websocketServer, admin, notificationService) {
    console.log('🚀 [SCHEDULED] Initializing ULTRA OPTIMIZED version...');
    
    this.firestoreService = firestoreService;
    this.websocketServer = websocketServer;
    this.admin = admin;
    this.notification = notificationService;
    
    // OPTIMIZATION: Extremely conservative settings for free tier
    this.MATCHING_INTERVAL = 120000; // 120 seconds (2 minutes) - reduces reads by 75%
    this.MATCH_EXPIRY = 30 * 60 * 1000; // 30 minutes - longer expiry reduces rewrites
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
    
    logger.info('SCHEDULED_SERVICE', '🚀 ULTRA OPTIMIZED mode - Matches ALL users, minimal resource usage');
  }

  // ========== LIFECYCLE ==========

  async start() {
    console.log('🚀 [SCHEDULED] Starting ULTRA OPTIMIZED mode - Will match ALL users regardless of location/time');
    console.log('📊 Settings: Interval=120s, Cache TTL=15min, Match expiry=30min');
    
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
      
      // Build base document
      let scheduledSearchData = {
        type: userType === 'driver' ? 'CREATE_SCHEDULED_SEARCH' : 'SCHEDULE_SEARCH',
        userId,
        sanitizedUserId: sanitizedPhone,
        userType,
        status: 'actively_matching',
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
      
      console.log(`✅ [SCHEDULED] Created for ${sanitizedPhone}`);
      
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
      
      return true;
    } catch (error) {
      console.error(`❌ [SCHEDULED] Error updating ${userType}:`, error.message);
      return false;
    }
  }

  // ========== ULTRA OPTIMIZED MATCHING ==========
  // Matches ALL users regardless of location or time

  async performMatching() {
    const cycleStart = Date.now();
    console.log('🤝 [SCHEDULED] Performing ULTRA OPTIMIZED matching (matches ALL users)...');
    
    try {
      // OPTIMIZATION: Get both in parallel
      const [drivers, passengers] = await Promise.all([
        this.getActiveScheduledSearches('driver'),
        this.getActiveScheduledSearches('passenger')
      ]);
      
      console.log(`📊 Found ${drivers.length} drivers, ${passengers.length} passengers`);
      
      if (drivers.length === 0 || passengers.length === 0) {
        console.log('ℹ️ [SCHEDULED] Not enough users for matching');
        return;
      }
      
      // OPTIMIZATION: Pre-process data for faster matching
      const processedDrivers = drivers.map(d => this.preprocessUserData(d, 'driver'));
      const processedPassengers = passengers.map(p => this.preprocessUserData(p, 'passenger'));
      
      // OPTIMIZATION: Create lookup maps for faster access
      const driverMap = new Map();
      processedDrivers.forEach(d => driverMap.set(d.id, d));
      
      // OPTIMIZATION: Generate matches using efficient algorithm
      const matches = [];
      const processedPairs = new Set();
      
      // Clean up old recent matches
      this.cleanupRecentMatches();
      
      // For each driver, try to match with passengers
      for (const driver of processedDrivers) {
        if (matches.length >= this.MAX_MATCHES_PER_CYCLE) break;
        
        for (const passenger of processedPassengers) {
          if (matches.length >= this.MAX_MATCHES_PER_CYCLE) break;
          
          const pairKey = `${driver.id}:${passenger.id}`;
          
          // Skip if already processed or recently matched
          if (processedPairs.has(pairKey)) continue;
          if (this.recentMatches.has(pairKey)) continue;
          
          processedPairs.add(pairKey);
          
          // Check seat availability
          if (passenger.passengerCount > driver.availableSeats) continue;
          
          // ✅ MATCH EVERYONE - no location/time restrictions!
          
          // Calculate a simple score (always >= 50)
          const score = 60 + Math.floor(Math.random() * 20); // 60-80 range
          
          matches.push({
            driverId: driver.id,
            passengerId: passenger.id,
            driverPhone: driver.userId || driver.driverPhone || driver.id,
            passengerPhone: passenger.userId || passenger.passengerPhone || passenger.id,
            score,
            passengerCount: passenger.passengerCount,
            availableSeats: driver.availableSeats,
            driverData: driver.originalData,
            passengerData: passenger.originalData,
            driver,
            passenger,
            timestamp: new Date().toISOString()
          });
          
          // Mark as recent match to prevent duplicates in same cycle
          this.recentMatches.set(pairKey, Date.now());
        }
      }
      
      console.log(`🎯 [SCHEDULED] Found ${matches.length} potential matches`);
      
      // Sort by score (highest first)
      matches.sort((a, b) => b.score - a.score);
      
      // OPTIMIZATION: Process matches with concurrency control
      if (matches.length > 0) {
        const matchesToProcess = matches.slice(0, this.MAX_MATCHES_PER_CYCLE);
        
        // Process matches sequentially to avoid race conditions
        for (const match of matchesToProcess) {
          await this.processMatch(match);
          
          // Small delay between matches to prevent overload
          await new Promise(r => setTimeout(r, 100));
        }
      }
      
      const cycleTime = Date.now() - cycleStart;
      console.log(`⏱️ Matching cycle completed in ${cycleTime}ms, processed ${matches.length} matches`);
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Matching error:', error.message);
    }
  }

  /**
   * Preprocess user data for faster matching
   */
  preprocessUserData(user, type) {
    // Extract the actual data (handles different formats)
    const rawData = user.data ? user.data() : (user.raw || user);
    const data = rawData.data || rawData;
    
    if (type === 'driver') {
      return {
        id: user.id,
        userId: data.userId || data.driverPhone || user.id,
        driverPhone: data.driverPhone || data.userId || user.id,
        driverName: data.driverName || 'Driver',
        availableSeats: data.availableSeats || data.capacity || 4,
        vehicleInfo: data.vehicleInfo || {},
        originalData: rawData,
        data: data
      };
    } else {
      return {
        id: user.id,
        userId: data.userId || data.passengerPhone || user.id,
        passengerPhone: data.passengerPhone || data.userId || user.id,
        passengerName: data.passengerName || 'Passenger',
        passengerCount: data.passengerCount || 1,
        originalData: rawData,
        data: data
      };
    }
  }

  async processMatch(match) {
    console.log(`🤝 [SCHEDULED] Processing match: ${match.driverPhone} ↔ ${match.passengerPhone} (score: ${match.score})`);
    
    try {
      // Enrich driver data (with cache)
      match.driverData = await this.enrichDriverData(match.driverPhone, match.driverData);
      
      const driverDetails = this.extractDriverDetails(match.driverData);
      const passengerDetails = this.extractPassengerDetails(match.passengerData);
      
      const pickupName = match.passengerData.pickupName || 
                        match.passenger?.data?.pickupName || 
                        'Pickup location';
      const destinationName = match.passengerData.destinationName || 
                             match.passenger?.data?.destinationName || 
                             'Destination';
      
      // Create match document
      const matchData = {
        driverId: match.driverId,
        passengerId: match.passengerId,
        driverPhone: match.driverPhone,
        passengerPhone: match.passengerPhone,
        driverName: driverDetails.name,
        passengerName: passengerDetails.name,
        driverDetails,
        passengerDetails,
        score: match.score,
        status: 'awaiting_driver_approval',
        proposedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + this.MATCH_EXPIRY).toISOString(),
        createdAt: new Date().toISOString(),
        pickupLocation: this.extractLocation(match.driverData, 'pickupLocation') || 
                       this.extractLocation(match.passengerData, 'pickupLocation'),
        destinationLocation: this.extractLocation(match.driverData, 'destinationLocation') || 
                            this.extractLocation(match.passengerData, 'destinationLocation'),
        pickupName,
        destinationName,
        scheduledTime: match.driverData.scheduledTime || match.passengerData.scheduledTime,
        passengerData: match.passengerData,
        driverData: match.driverData,
        matchDetails: {
          driverCapacity: match.availableSeats,
          passengerCount: match.passengerCount,
          estimatedFare: match.passengerData.estimatedFare || 0
        }
      };
      
      // OPTIMIZATION: Use addDocument which returns just the ID
      const matchId = await this.firestoreService.addDocument('scheduled_matches', matchData);
      
      console.log(`✅ [SCHEDULED] Match created: ${matchId}`);
      
      // OPTIMIZATION: Batch these updates if possible
      await Promise.all([
        this.updateSearchStatus('driver', match.driverPhone, {
          status: 'actively_matching', // Keep matching!
          pendingMatchId: matchId,
          pendingMatchWith: match.passengerPhone,
          pendingMatchStatus: 'awaiting_driver_approval'
        }),
        
        this.updateSearchStatus('passenger', match.passengerPhone, {
          status: 'pending_driver_approval',
          matchId: matchId,
          matchedWith: match.driverPhone,
          matchStatus: 'awaiting_driver_approval'
        })
      ]);
      
      // OPTIMIZATION: Only send notification via WebSocket first, FCM as fallback
      const notificationSent = await this.notification.sendNotification(match.driverPhone, {
        type: 'scheduled_match_proposed_to_driver',
        data: {
          matchId: matchId,
          passengerPhone: match.passengerPhone,
          passengerName: passengerDetails.name,
          passengerDetails,
          score: match.score,
          tripDetails: {
            pickupName,
            destinationName,
            scheduledTime: match.passengerData.scheduledTime,
            passengerCount: match.passengerCount,
            estimatedFare: match.passengerData.estimatedFare
          }
        }
      }, { important: true, skipFCM: false }); // Allow FCM but it will only send if needed
      
      console.log(`📨 Notification ${notificationSent ? 'sent' : 'queued'} to driver`);
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Error processing match:', error.message);
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
