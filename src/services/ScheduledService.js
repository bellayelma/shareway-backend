// services/ScheduledService.js
// OPTIMIZED FOR FREE TIER - Reduced reads/writes, caching, batched operations

const logger = require('../utils/Logger');

class ScheduledService {
  constructor(firestoreService, websocketServer, admin, notificationService) {
    console.log('🚀 [SCHEDULED] Initializing...');
    
    this.firestoreService = firestoreService;
    this.websocketServer = websocketServer;
    this.admin = admin;
    this.notification = notificationService; // Injected dependency
    
    // Get db instance (fallback only)
    this.db = firestoreService?.db || admin?.firestore();
    
    // OPTIMIZATION: Configuration for free tier
    this.MATCHING_INTERVAL = 60000; // 60 seconds (reduced from 30)
    this.MATCH_EXPIRY = 15 * 60 * 1000; // 15 minutes
    this.MAX_MATCHES_PER_CYCLE = 3; // Reduced from 5
    this.DISTANCE_THRESHOLD = 20000; // 20km
    this.DESTINATION_THRESHOLD = 30000; // 30km
    this.MIN_MATCH_SCORE = 40;
    
    this.matchingInterval = null;
    this.cycleCount = 0;
    
    // OPTIMIZATION: Cache for recently seen users to prevent repeated matching
    this.recentMatches = new Map();
    this.RECENT_MATCH_TTL = 300000; // 5 minutes
    
    // OPTIMIZATION: Cache for user data to reduce reads
    this.userCache = new Map();
    this.USER_CACHE_TTL = 600000; // 10 minutes
    
    logger.info('SCHEDULED_SERVICE', '🚀 Scheduled Service initialized (Optimized Mode)');
  }

  // ========== LIFECYCLE ==========

  async start() {
    console.log('🚀 [SCHEDULED] Starting in OPTIMIZED mode for free tier...');
    
    // Test connection (only once at startup)
    await this.testConnection();
    
    // Start matching interval with optimization
    this.matchingInterval = setInterval(async () => {
      this.cycleCount++;
      
      // OPTIMIZATION: Only run matching every other cycle (reduce by 50%)
      if (this.cycleCount % 2 === 0) {
        logger.info('SCHEDULED_SERVICE', `🔄 Cycle #${this.cycleCount}`);
        await this.performMatching();
        await this.cleanupExpiredMatches();
      }
      
    }, this.MATCHING_INTERVAL);
    
    logger.info('SCHEDULED_SERVICE', '✅ Started (Optimized Mode)');
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
    
    // Clear caches
    this.recentMatches.clear();
    this.userCache.clear();
    
    logger.info('SCHEDULED_SERVICE', '🛑 Stopped');
  }

  // ========== CACHE MANAGEMENT ==========

  getUserFromCache(phoneNumber) {
    const cached = this.userCache.get(phoneNumber);
    if (cached && Date.now() - cached.timestamp < this.USER_CACHE_TTL) {
      return cached.data;
    }
    return null;
  }

  setUserCache(phoneNumber, data) {
    this.userCache.set(phoneNumber, {
      data,
      timestamp: Date.now()
    });
  }

  cleanupRecentMatches() {
    const now = Date.now();
    for (const [key, timestamp] of this.recentMatches.entries()) {
      if (now - timestamp > this.RECENT_MATCH_TTL) {
        this.recentMatches.delete(key);
      }
    }
  }

  cleanupUserCache() {
    const now = Date.now();
    for (const [key, value] of this.userCache.entries()) {
      if (now - value.timestamp > this.USER_CACHE_TTL) {
        this.userCache.delete(key);
      }
    }
  }

  // ========== PHONE UTILITIES (Delegate to NotificationService) ==========

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
      
      // Check if document exists using firestoreService
      const docSnapshot = await this.firestoreService.getDocument(collectionName, sanitizedPhone);
      
      if (docSnapshot.exists) {
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
      this.setUserCache(sanitizedPhone, scheduledSearchData);
      
      console.log(`✅ [SCHEDULED] Created for ${sanitizedPhone}`);
      
      // Notify via WebSocket
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
      let userData = this.getUserFromCache(sanitizedPhone);
      
      if (!userData) {
        const userDoc = await this.firestoreService.getDocument('users', sanitizedPhone);
        if (userDoc.exists) {
          userData = userDoc.data();
          this.setUserCache(sanitizedPhone, userData);
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

  // ========== GET ACTIVE SEARCHES (OPTIMIZED) ==========

  async getActiveScheduledSearches(userType) {
    try {
      // Use the optimized method from firestoreService
      const results = await this.firestoreService.getActiveMatchingDocuments(userType);
      return results;
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
      const cached = this.getUserFromCache(`${userType}_${sanitizedPhone}`);
      if (cached) return cached;
      
      const docSnapshot = await this.firestoreService.getDocument(collectionName, sanitizedPhone);
      
      if (!docSnapshot.exists) return null;
      
      const data = { id: docSnapshot.id, ...docSnapshot.data() };
      
      // Cache the result
      this.setUserCache(`${userType}_${sanitizedPhone}`, data);
      
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

  // ========== MATCHING LOGIC (OPTIMIZED) ==========

  async performMatching() {
    console.log('🤝 [SCHEDULED] Performing matching (optimized)...');
    
    try {
      // OPTIMIZATION: Use specialized methods that filter on server
      const [drivers, passengers] = await Promise.all([
        this.getActiveScheduledSearches('driver'),
        this.getActiveScheduledSearches('passenger')
      ]);
      
      if (drivers.length === 0 || passengers.length === 0) {
        console.log('ℹ️ [SCHEDULED] Not enough users');
        return;
      }
      
      // OPTIMIZATION: Limit matches per cycle
      const matches = [];
      const processedPairs = new Set();
      
      // Clean up old recent matches
      this.cleanupRecentMatches();
      
      for (const driver of drivers) {
        if (matches.length >= this.MAX_MATCHES_PER_CYCLE) break;
        
        const driverData = driver.data;
        if (!driverData) continue;
        
        const driverLoc = this.extractLocation(driverData, 'pickupLocation');
        const driverTime = this.extractTime(driverData);
        const driverDest = this.extractLocation(driverData, 'destinationLocation');
        const availableSeats = driverData.availableSeats || 4;
        
        if (!driverTime || !driverLoc) continue;
        if (availableSeats <= 0) continue;
        
        for (const passenger of passengers) {
          if (matches.length >= this.MAX_MATCHES_PER_CYCLE) break;
          
          const passengerData = passenger.data;
          if (!passengerData) continue;
          
          const pairKey = `${driver.id}:${passenger.id}`;
          if (processedPairs.has(pairKey)) continue;
          if (this.recentMatches.has(pairKey)) continue; // Skip recently matched
          
          processedPairs.add(pairKey);
          
          if (passengerData.status !== 'actively_matching' && passengerData.status !== 'scheduled') continue;
          
          const passengerTime = this.extractTime(passengerData);
          const passengerLoc = this.extractLocation(passengerData, 'pickupLocation');
          const passengerDest = this.extractLocation(passengerData, 'destinationLocation');
          const passengerCount = passengerData.passengerCount || 1;
          
          if (!passengerTime || !passengerLoc) continue;
          if (passengerCount > availableSeats) continue;
          
          // Time difference check (optimization)
          const timeDiff = Math.abs(driverTime - passengerTime);
          if (timeDiff > 3600000) continue; // Skip if time difference > 1 hour
          
          // Calculate distances
          const distance = this.calculateDistance(driverLoc, passengerLoc);
          if (distance > this.DISTANCE_THRESHOLD) continue;
          
          let destDistance = Infinity;
          if (driverDest && passengerDest) {
            destDistance = this.calculateDistance(driverDest, passengerDest);
            if (destDistance > this.DESTINATION_THRESHOLD) continue;
          }
          
          // Calculate match score
          const score = this.calculateMatchScore(distance, destDistance, availableSeats, passengerCount);
          
          if (score >= this.MIN_MATCH_SCORE) {
            matches.push({
              driverId: driver.id,
              passengerId: passenger.id,
              driverPhone: driverData.userId || driverData.driverPhone || driver.id,
              passengerPhone: passengerData.userId || passengerData.passengerPhone || passenger.id,
              score,
              distance,
              destDistance,
              passengerCount,
              availableSeats,
              driverData,
              passengerData,
              timestamp: new Date().toISOString()
            });
            
            // Mark as recent match
            this.recentMatches.set(pairKey, Date.now());
          }
        }
      }
      
      console.log(`🎯 [SCHEDULED] Found ${matches.length} potential matches`);
      
      // Sort by score and process top matches
      matches.sort((a, b) => b.score - a.score);
      
      // OPTIMIZATION: Process matches in batch if possible
      for (const match of matches.slice(0, this.MAX_MATCHES_PER_CYCLE)) {
        await this.processMatch(match);
      }
      
    } catch (error) {
      console.error('❌ [SCHEDULED] Matching error:', error.message);
    }
  }

  calculateMatchScore(distance, destDistance, availableSeats, neededSeats) {
    let score = 60; // Base
    
    // Location proximity (max 25)
    if (distance < this.DISTANCE_THRESHOLD) {
      score += 25 * (1 - distance / this.DISTANCE_THRESHOLD);
    }
    
    // Destination proximity (max 15)
    if (destDistance < this.DESTINATION_THRESHOLD) {
      score += 15 * (1 - destDistance / this.DESTINATION_THRESHOLD);
    }
    
    // Capacity (max 10)
    if (availableSeats >= neededSeats) {
      score += availableSeats === neededSeats ? 10 : 5;
    }
    
    return Math.min(Math.round(score), 100);
  }

  async processMatch(match) {
    try {
      console.log(`🤝 [SCHEDULED] Processing match: ${match.driverPhone} ↔ ${match.passengerPhone}`);
      
      // Enrich driver data
      match.driverData = await this.enrichDriverData(match.driverPhone, match.driverData);
      
      const driverDetails = this.extractDriverDetails(match.driverData);
      const passengerDetails = this.extractPassengerDetails(match.passengerData);
      
      const pickupName = match.passengerData.pickupName || 'Pickup location';
      const destinationName = match.passengerData.destinationName || 'Destination';
      
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
        distance: match.distance,
        status: 'awaiting_driver_approval',
        proposedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + this.MATCH_EXPIRY).toISOString(),
        createdAt: new Date().toISOString(),
        pickupLocation: this.extractLocation(match.driverData, 'pickupLocation') || this.extractLocation(match.passengerData, 'pickupLocation'),
        destinationLocation: this.extractLocation(match.driverData, 'destinationLocation') || this.extractLocation(match.passengerData, 'destinationLocation'),
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
      
      const matchId = await this.firestoreService.addDocument('scheduled_matches', matchData);
      
      console.log(`✅ [SCHEDULED] Match created: ${matchId}`);
      
      // Update driver (keep actively_matching)
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
        matchStatus: 'awaiting_driver_approval'
      });
      
      // Send notification via NotificationService
      await this.notification.sendNotification(match.driverPhone, {
        type: 'scheduled_match_proposed_to_driver',
        data: {
          matchId: matchId,
          passengerPhone: match.passengerPhone,
          passengerName: passengerDetails.name,
          passengerDetails,
          score: match.score,
          distance: match.distance,
          tripDetails: {
            pickupName,
            destinationName,
            scheduledTime: match.passengerData.scheduledTime,
            passengerCount: match.passengerCount,
            estimatedFare: match.passengerData.estimatedFare
          }
        }
      }, { important: true });
      
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
      
      if (!matchDoc.exists) throw new Error('Match not found');
      
      const matchData = matchDoc.data();
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
        // Get driver document
        const driverDoc = await this.getUserScheduledSearch('driver', driverPhone);
        if (!driverDoc) throw new Error('Driver not found');
        
        const passengerCount = matchData.passengerCount || 1;
        const currentSeats = driverDoc.availableSeats || 0;
        const newSeats = currentSeats - passengerCount;
        
        // ONE-STEP APPROVAL - immediate confirmation
        updateData.status = 'confirmed';
        updateData.confirmedAt = new Date().toISOString();
        updateData.passengerDecision = 'accept';
        updateData.passengerDecisionAt = new Date().toISOString();
        
        await this.firestoreService.updateDocument('scheduled_matches', matchId, updateData);
        
        // Create passenger record for driver
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
        
        // Send confirmations via NotificationService
        await this.notification.sendNotification(matchData.passengerPhone, {
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
        }, { important: true });
        
        await this.notification.sendNotification(driverPhone, {
          type: 'scheduled_match_confirmed',
          data: {
            matchId,
            confirmedBy: driverPhone,
            passengerName: matchData.passengerName,
            passengerPhone: matchData.passengerPhone,
            passengerDetails: matchData.passengerDetails,
            seatsLeft: newSeats
          }
        }, { important: true });
        
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
      
      // OPTIMIZATION: Use batched writes
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
        
        // Update cache invalidation
        this.userCache.delete(`passenger_${passengerPhone}`);
        
        // Update match if exists
        if (passenger.matchId) {
          batch.update('scheduled_matches', passenger.matchId, {
            status: 'cancelled_by_driver',
            cancelledAt: new Date().toISOString(),
            cancellationReason: reason
          });
        }
        
        // Create cancellation record (non-batch operation)
        await this.notification.createCancellationRecord({
          cancellationType: 'driver_cancelled_all',
          cancelledBy: driverPhone,
          driverDetails: { phone: driverPhone, name: driverDoc.driverName },
          passengerDetails: passenger,
          reason
        });
        
        // Send notification
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
      
      // Invalidate driver cache
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
      
      // OPTIMIZATION: Use batched writes
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
      
      // Invalidate driver cache
      this.userCache.delete(`driver_${sanitizedDriverPhone}`);
      
      // Update passenger
      const sanitizedPassengerPhone = this.sanitizePhoneNumber(passengerPhone);
      batch.update('scheduled_searches_passenger', sanitizedPassengerPhone, {
        status: 'cancelled_by_driver',
        cancelledAt: new Date().toISOString(),
        cancelledByDriver: { driverPhone, driverName: driverDoc.driverName, reason },
        matchId: null
      });
      
      // Invalidate passenger cache
      this.userCache.delete(`passenger_${sanitizedPassengerPhone}`);
      
      // Update match if exists
      if (cancelledPassenger.matchId) {
        batch.update('scheduled_matches', cancelledPassenger.matchId, {
          status: 'cancelled_by_driver',
          cancelledAt: new Date().toISOString(),
          cancellationReason: reason
        });
      }
      
      await this.firestoreService.commitBatch(batch);
      
      // Create cancellation record
      await this.notification.createCancellationRecord({
        cancellationType: 'driver_cancelled_passenger',
        cancelledBy: driverPhone,
        driverDetails: { phone: driverPhone, name: driverDoc.driverName },
        passengerDetails: cancelledPassenger,
        reason,
        afterCancellation: { driverAvailableSeats: restoredSeats }
      });
      
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
      
      // OPTIMIZATION: Use batched writes
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
      
      // Invalidate driver cache
      this.userCache.delete(`driver_${sanitizedDriverPhone}`);
      
      // Update passenger
      const sanitizedPassengerPhone = this.sanitizePhoneNumber(passengerPhone);
      batch.update('scheduled_searches_passenger', sanitizedPassengerPhone, {
        status: 'cancelled_by_passenger',
        cancelledAt: new Date().toISOString(),
        cancellationReason: reason,
        matchId: null
      });
      
      // Invalidate passenger cache
      this.userCache.delete(`passenger_${sanitizedPassengerPhone}`);
      
      // Update match if exists
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
      const loc = data[fieldName];
      if (!loc) return null;
      
      if (typeof loc === 'object') {
        if (loc.lat !== undefined && loc.lng !== undefined) {
          return { latitude: loc.lat, longitude: loc.lng };
        }
        if (loc.latitude !== undefined && loc.longitude !== undefined) {
          return { latitude: loc.latitude, longitude: loc.longitude };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  extractTime(data) {
    try {
      const sources = [
        data.scheduledTimestamp,
        data.scheduledTime,
        data.rideDetails?.scheduledTime,
        data.createdAt
      ];
      
      for (const source of sources) {
        if (!source) continue;
        if (typeof source === 'number') return source;
        if (typeof source === 'string') {
          const ts = new Date(source).getTime();
          if (!isNaN(ts)) return ts;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  extractDriverDetails(data) {
    return {
      name: data.driverName || 'Driver',
      phone: data.driverPhone || data.userId,
      vehicleInfo: data.vehicleInfo || {},
      vehicleType: data.vehicleType || 'Car',
      vehicleModel: data.vehicleModel || 'Standard',
      vehicleColor: data.vehicleColor || 'Not specified',
      licensePlate: data.licensePlate || 'Not specified',
      rating: data.rating || 5.0,
      profilePhoto: data.profilePhoto || null,
      availableSeats: data.availableSeats || 4
    };
  }

  extractPassengerDetails(data) {
    return {
      name: data.passengerName || 'Passenger',
      phone: data.passengerPhone || data.userId,
      passengerCount: data.passengerCount || 1,
      profilePhoto: data.passengerPhotoUrl || data.passengerInfo?.photoUrl || null,
      rating: data.rating || 5.0
    };
  }

  calculateDistance(loc1, loc2) {
    if (!loc1 || !loc2) return Infinity;
    
    const toRad = (value) => value * Math.PI / 180;
    
    const lat1 = loc1.latitude;
    const lon1 = loc1.longitude;
    const lat2 = loc2.latitude;
    const lon2 = loc2.longitude;
    
    const R = 6371000; // Earth radius in meters
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
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
      
      const snapshot = await this.firestoreService.queryCollection(
        'scheduled_matches',
        constraints,
        20 // Limit cleanup
      );
      
      if (snapshot.size === 0) return 0;
      
      // OPTIMIZATION: Use batched writes for cleanup
      const batch = this.firestoreService.batch();
      let cleaned = 0;
      
      snapshot.forEach(doc => {
        batch.update('scheduled_matches', doc.id, {
          status: 'expired',
          expiredAt: new Date().toISOString()
        });
        cleaned++;
      });
      
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
      // OPTIMIZATION: Use approximate counts instead of full collection scans
      const counts = await Promise.all([
        this.firestoreService.getApproximateCollectionSize('scheduled_searches_driver'),
        this.firestoreService.getApproximateCollectionSize('scheduled_searches_passenger'),
        this.firestoreService.getApproximateCollectionSize('scheduled_matches')
      ]);
      
      return {
        success: true,
        stats: {
          cycleCount: this.cycleCount,
          driverSearches: counts[0],
          passengerSearches: counts[1],
          matches: counts[2],
          cacheSize: {
            recentMatches: this.recentMatches.size,
            userCache: this.userCache.size
          },
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
