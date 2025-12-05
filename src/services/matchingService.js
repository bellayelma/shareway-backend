const { TIMEOUTS } = require('../config/constants');
const routeMatching = require('../utils/routeMatching');
const helpers = require('../utils/helpers');
const notificationService = require('./notificationService');

class MatchingService {
  constructor(firestoreService, searchService, websocketServer, admin) {
    this.firestoreService = firestoreService;
    this.searchService = searchService;
    this.websocketServer = websocketServer;
    this.admin = admin;
    this.matchAttempts = 0;
    this.successfulMatches = 0;
    this.failedMatches = 0;
    this.cycleCount = 0;
    
    // FORCE TEST MODE - ALWAYS TRUE
    this.FORCE_TEST_MODE = true;
    console.log(`🧪 FORCED TEST MODE: ${this.FORCE_TEST_MODE ? 'ALWAYS ON' : 'OFF'}`);
  }
  
  // Start matching service
  start() {
    console.log('🔄 Starting FORCED TEST MODE Matching Service...');
    console.log(`🧪 TEST MODE: FORCED ON (Always matching)`);
    console.log(`📏 MAX DISTANCE: UNLIMITED (All distances allowed)`);
    console.log(`⚡ MATCHING: ANY driver ↔ ANY passenger`);
    
    const matchingInterval = TIMEOUTS.MATCHING_INTERVAL;
    
    // Immediate first run
    setTimeout(() => {
      this.performMatchingCycle();
    }, 1000);
    
    // Then regular intervals (every 10 seconds)
    setInterval(async () => {
      await this.performMatchingCycle();
    }, matchingInterval);
    
    // Add cleanup for expired searches
    setInterval(async () => {
      await this.cleanupExpiredSearches();
    }, 5 * 60 * 1000);
    
    // Clean processed matches
    setInterval(() => {
      this.searchService.cleanupOldData();
    }, 60000);
    
    console.log('✅ FORCED TEST MODE Matching Service started');
  }
  
  // Perform matching cycle
  async performMatchingCycle() {
    this.cycleCount++;
    console.log(`\n📊 ===== FORCED MATCHING CYCLE #${this.cycleCount} START =====`);
    
    try {
      // Clear expired match proposals
      await this.clearExpiredMatchProposals();
      
      // Get active searches from Firestore (cached)
      const { drivers, passengers } = await this.firestoreService.getAllActiveSearches();
      
      console.log(`📊 Matching: ${drivers.length} drivers vs ${passengers.length} passengers`);
      
      if (drivers.length === 0 || passengers.length === 0) {
        console.log(`💤 No matches possible - missing drivers or passengers`);
        console.log(`📊 ===== MATCHING CYCLE END =====\n`);
        return;
      }
      
      // DEBUG: Log driver and passenger details
      console.log('\n🔍 DEBUG - Active Drivers:');
      drivers.forEach((driver, i) => {
        console.log(`   ${i+1}. ${driver.driverName || 'Unknown'} (${driver.driverId || driver.userId})`);
        console.log(`      Status: ${driver.status}, Match: ${driver.matchStatus || 'none'}`);
        console.log(`      Seats: ${driver.availableSeats || driver.capacity || 4}/${driver.capacity || 4}`);
        console.log(`      From: ${driver.pickupName || 'Unknown'} to ${driver.destinationName || 'Unknown'}`);
      });
      
      console.log('\n🔍 DEBUG - Active Passengers:');
      passengers.forEach((passenger, i) => {
        console.log(`   ${i+1}. ${passenger.passengerName || 'Unknown'} (${passenger.passengerId || passenger.userId})`);
        console.log(`      Status: ${passenger.status}, Match: ${passenger.matchStatus || 'none'}`);
        console.log(`      Count: ${passenger.passengerCount || 1}`);
        console.log(`      From: ${passenger.pickupName || 'Unknown'} to ${passenger.destinationName || 'Unknown'}`);
      });
      
      let matchesCreated = 0;
      let matchAttempts = 0;
      
      // FORCED MATCHING: Match ANY available driver with ANY available passenger
      for (const driver of drivers) {
        const driverUserId = driver.driverId || driver.userId;
        
        // Skip if driver already has a match
        if (driver.matchStatus === 'proposed' || driver.matchStatus === 'accepted') {
          console.log(`   ⏸️ Skipping driver ${driver.driverName} - already matched`);
          continue;
        }
        
        // Check driver is searching
        if (driver.status !== 'searching') {
          console.log(`   ⏸️ Skipping driver ${driver.driverName} - not searching (${driver.status})`);
          continue;
        }
        
        // Check available seats
        const availableSeats = driver.availableSeats || driver.capacity || 4;
        if (availableSeats <= 0) {
          console.log(`   ⏸️ Skipping driver ${driver.driverName} - no available seats`);
          continue;
        }
        
        console.log(`\n🚗 Driver available: ${driver.driverName} (${availableSeats} seats available)`);
        
        for (const passenger of passengers) {
          const passengerUserId = passenger.passengerId || passenger.userId;
          matchAttempts++;
          
          // Skip if passenger already has a match
          if (passenger.matchStatus === 'proposed' || passenger.matchStatus === 'accepted') {
            console.log(`   ⏸️ Skipping passenger ${passenger.passengerName} - already matched`);
            continue;
          }
          
          // Check passenger is searching
          if (passenger.status !== 'searching') {
            console.log(`   ⏸️ Skipping passenger ${passenger.passengerName} - not searching (${passenger.status})`);
            continue;
          }
          
          // Check passenger count fits in available seats
          const passengerCount = passenger.passengerCount || 1;
          if (passengerCount > availableSeats) {
            console.log(`   ⏸️ Skipping passenger ${passenger.passengerName} - needs ${passengerCount} seats, only ${availableSeats} available`);
            continue;
          }
          
          // FORCE MATCH - ALWAYS CREATE MATCH
          console.log(`🎯 FORCED MATCH: ${driver.driverName} ↔ ${passenger.passengerName}`);
          console.log(`   Driver seats: ${availableSeats}, Passenger count: ${passengerCount}`);
          console.log(`   FROM: ${driver.pickupName} → ${passenger.pickupName}`);
          console.log(`   TO: ${driver.destinationName} → ${passenger.destinationName}`);
          
          const matchCreated = await this.createForcedMatch(driver, passenger);
          if (matchCreated) {
            matchesCreated++;
            console.log(`✅ Match created! Moving to next driver...`);
            break; // Driver can only take one passenger at a time
          }
        }
      }
      
      if (matchesCreated > 0) {
        console.log(`\n🎉 SUCCESS: Created ${matchesCreated} match${matchesCreated > 1 ? 'es' : ''} this cycle!`);
        this.successfulMatches += matchesCreated;
      } else {
        console.log(`\n🔍 No new matches created this cycle`);
        console.log(`   Possible reasons:`);
        console.log(`   - All drivers already matched`);
        console.log(`   - All passengers already matched`);
        console.log(`   - Seat capacity mismatch`);
        console.log(`   - Status not 'searching'`);
      }
      
      this.matchAttempts += matchAttempts;
      console.log(`📈 Stats: ${this.successfulMatches} successful, ${this.failedMatches} failed (${this.matchAttempts} total attempts)`);
      
    } catch (error) {
      console.error('❌ Matching cycle error:', error);
      console.error('❌ Error stack:', error.stack);
    }
    
    console.log(`📊 ===== MATCHING CYCLE END =====\n`);
  }
  
  // Create forced match (always works)
  async createForcedMatch(driver, passenger) {
    try {
      const matchId = `match_${Date.now()}_${helpers.generateId(8)}`;
      const driverUserId = driver.driverId || driver.userId;
      const passengerUserId = passenger.passengerId || passenger.userId;
      
      console.log(`\n🤝 Creating FORCED match ${matchId}`);
      console.log(`   Driver: ${driver.driverName || 'Unknown'} (${driverUserId})`);
      console.log(`   Passenger: ${passenger.passengerName || 'Unknown'} (${passengerUserId})`);
      
      // Calculate distance for display (even though we're ignoring it)
      let distance = 0;
      let duration = 0;
      if (driver.pickupLocation && passenger.pickupLocation) {
        // Simple distance calculation for display only
        const latDiff = Math.abs(driver.pickupLocation.lat - passenger.pickupLocation.lat);
        const lngDiff = Math.abs(driver.pickupLocation.lng - passenger.pickupLocation.lng);
        distance = Math.sqrt(latDiff * latDiff + lngDiff * lngDiff) * 111; // Rough km
        duration = distance * 2; // Rough minutes
      }
      
      const matchData = {
        matchId: matchId,
        driverId: driverUserId,
        driverName: driver.driverName || 'Unknown Driver',
        driverPhone: driver.driverPhone || 'Not provided',
        driverPhotoUrl: driver.driverPhotoUrl || '',
        driverRating: driver.driverRating || 5.0,
        vehicleInfo: driver.vehicleInfo || {
          model: 'Test Vehicle',
          plate: 'TEST123',
          color: 'Test Color',
          type: 'car'
        },
        passengerId: passengerUserId,
        passengerName: passenger.passengerName || 'Unknown Passenger',
        passengerPhone: passenger.passengerPhone || 'Not provided',
        passengerPhotoUrl: passenger.passengerPhotoUrl || '',
        passengerCount: passenger.passengerCount || 1,
        pickupLocation: passenger.pickupLocation || driver.pickupLocation,
        pickupName: passenger.pickupName || driver.pickupName || 'Pickup Location',
        destinationLocation: passenger.destinationLocation || driver.destinationLocation,
        destinationName: passenger.destinationName || driver.destinationName || 'Destination',
        distance: distance,
        duration: duration,
        estimatedFare: passenger.estimatedFare || driver.estimatedFare || 500,
        similarityScore: 0.95, // High score for forced match
        matchScore: 99, // Very high match score
        matchStatus: 'proposed',
        rideType: driver.rideType || passenger.rideType || 'immediate',
        scheduledTime: driver.scheduledTime || passenger.scheduledTime,
        createdAt: new Date(),
        expiresAt: Date.now() + TIMEOUTS.MATCH_PROPOSAL,
        notified: false,
        matchType: 'forced',
        testMode: true,
        distanceIgnored: true,
        forcedMatch: true,
        notes: 'This match was created in FORCED TEST MODE - all checks bypassed'
      };
      
      console.log(`   📝 Match data prepared`);
      
      // Save match to Firestore IMMEDIATELY
      await this.firestoreService.saveMatch(matchData, { immediate: true });
      console.log(`   ✅ Match saved to Firestore`);
      
      // Update driver's document
      const driverUpdates = {
        matchId: matchId,
        matchedWith: passengerUserId,
        matchStatus: 'proposed',
        matchProposedAt: new Date(),
        passenger: {
          passengerId: passengerUserId,
          passengerName: passenger.passengerName,
          passengerPhone: passenger.passengerPhone,
          passengerPhotoUrl: passenger.passengerPhotoUrl,
          passengerCount: passenger.passengerCount || 1,
          pickupLocation: passenger.pickupLocation,
          pickupName: passenger.pickupName,
          destinationLocation: passenger.destinationLocation,
          destinationName: passenger.destinationName
        },
        lastUpdated: Date.now(),
        matchNotes: 'FORCED TEST MODE MATCH'
      };
      
      await this.firestoreService.updateDriverSearch(driverUserId, driverUpdates, { immediate: true });
      console.log(`   ✅ Driver document updated`);
      
      // Update passenger's document
      const passengerUpdates = {
        matchId: matchId,
        matchedWith: driverUserId,
        matchStatus: 'proposed',
        matchProposedAt: new Date(),
        driver: {
          driverId: driverUserId,
          driverName: driver.driverName,
          driverPhone: driver.driverPhone,
          driverPhotoUrl: driver.driverPhotoUrl,
          driverRating: driver.driverRating,
          vehicleInfo: driver.vehicleInfo,
          availableSeats: driver.availableSeats || driver.capacity || 4,
          capacity: driver.capacity || 4
        },
        lastUpdated: Date.now(),
        matchNotes: 'FORCED TEST MODE MATCH'
      };
      
      await this.firestoreService.updatePassengerSearch(passengerUserId, passengerUpdates, { immediate: true });
      console.log(`   ✅ Passenger document updated`);
      
      // CRITICAL FIX: Send notifications with validated userIds
      await this.sendMatchProposals(matchId, driver, passenger, matchData);
      console.log(`   📱 Notifications sent via notificationService`);
      
      // Set timeout for match proposal
      setTimeout(async () => {
        await this.checkAndExpireMatch(matchId);
      }, TIMEOUTS.MATCH_PROPOSAL);
      
      console.log(`✅ FORCED match ${matchId} created successfully!`);
      return true;
      
    } catch (error) {
      console.error(`❌ ERROR creating forced match:`, error);
      console.error(`❌ Error details:`, error.message);
      console.error(`❌ Error stack:`, error.stack);
      this.failedMatches++;
      return false;
    }
  }
  
  // CRITICAL FIX: Send match proposals with validated userIds
  async sendMatchProposals(matchId, driver, passenger, matchData) {
    try {
      console.log(`📱 Sending match proposals for match ${matchId}`);
      
      // Validate and fix driver userId
      let driverUserId = driver.userId || driver.driverId;
      if (!driverUserId) {
        console.error(`❌ Driver ${driver.id || driver.driverName} has no userId! Trying to fix...`);
        
        // FIX 1: Try to get userId from Firestore
        const driverDoc = await this.firestoreService.getDriverSearch(driver.driverId || driver.id);
        if (driverDoc && driverDoc.userId) {
          driverUserId = driverDoc.userId;
          console.log(`✅ Retrieved driver userId from Firestore: ${driverUserId}`);
        } else {
          // FIX 2: Use driver.id or driver.driverId as fallback
          driverUserId = driver.driverId || driver.id || `driver_${helpers.generateId(8)}`;
          console.log(`⚠️ Using fallback driver userId: ${driverUserId}`);
        }
      }
      
      // Validate and fix passenger userId
      let passengerUserId = passenger.userId || passenger.passengerId;
      if (!passengerUserId) {
        console.error(`❌ Passenger ${passenger.id || passenger.passengerName} has no userId! Trying to fix...`);
        
        // FIX 1: Try to get userId from Firestore
        const passengerDoc = await this.firestoreService.getPassengerSearch(passenger.passengerId || passenger.id);
        if (passengerDoc && passengerDoc.userId) {
          passengerUserId = passengerDoc.userId;
          console.log(`✅ Retrieved passenger userId from Firestore: ${passengerUserId}`);
        } else {
          // FIX 2: Use passenger.id or passenger.passengerId as fallback
          passengerUserId = passenger.passengerId || passenger.id || `passenger_${helpers.generateId(8)}`;
          console.log(`⚠️ Using fallback passenger userId: ${passengerUserId}`);
        }
      }
      
      // Prepare driver data with validated userId
      const driverWithUserId = {
        ...driver,
        userId: driverUserId,
        driverId: driver.driverId || driverUserId
      };
      
      // Prepare passenger data with validated userId
      const passengerWithUserId = {
        ...passenger,
        userId: passengerUserId,
        passengerId: passenger.passengerId || passengerUserId
      };
      
      // Send notifications via notificationService
      const notificationSent = await notificationService.sendMatchProposals(
        matchId, 
        driverWithUserId, 
        passengerWithUserId,
        matchData
      );
      
      if (!notificationSent) {
        console.error(`❌ Failed to send notifications for match ${matchId}`);
        // Fallback to WebSocket if notificationService fails
        if (this.websocketServer) {
          console.log(`🔄 Falling back to WebSocket notifications`);
          this.sendWebSocketFallbackNotifications(matchId, driverWithUserId, passengerWithUserId, matchData);
        }
      }
      
      return notificationSent;
      
    } catch (error) {
      console.error(`❌ Error sending match proposals:`, error);
      console.error(`❌ Error details:`, error.message);
      
      // Fallback to WebSocket
      if (this.websocketServer) {
        console.log(`🔄 Falling back to WebSocket notifications due to error`);
        this.sendWebSocketFallbackNotifications(matchId, driver, passenger, matchData);
      }
      
      return false;
    }
  }
  
  // Fallback WebSocket notification method
  sendWebSocketFallbackNotifications(matchId, driver, passenger, matchData) {
    try {
      const driverUserId = driver.userId || driver.driverId;
      const passengerUserId = passenger.userId || passenger.passengerId;
      
      // Send to driver
      this.websocketServer.sendMatchProposal(driverUserId, {
        matchId: matchId,
        passengerId: passengerUserId,
        passengerName: passenger.passengerName,
        passengerPhone: passenger.passengerPhone,
        passengerPhotoUrl: passenger.passengerPhotoUrl,
        pickupName: passenger.pickupName || driver.pickupName,
        destinationName: passenger.destinationName || driver.destinationName,
        passengerCount: passenger.passengerCount || 1,
        estimatedFare: matchData.estimatedFare,
        message: '🚨 FORCED TEST MODE: Match found! (All checks bypassed)',
        timeout: TIMEOUTS.MATCH_PROPOSAL,
        testMode: true,
        forcedMatch: true
      });
      
      // Send to passenger
      this.websocketServer.sendMatchProposal(passengerUserId, {
        matchId: matchId,
        driverId: driverUserId,
        driverName: driver.driverName,
        driverPhone: driver.driverPhone,
        driverPhotoUrl: driver.driverPhotoUrl,
        driverRating: driver.driverRating,
        vehicleInfo: driver.vehicleInfo,
        pickupName: passenger.pickupName || driver.pickupName,
        destinationName: passenger.destinationName || driver.destinationName,
        estimatedFare: matchData.estimatedFare,
        message: '🚨 FORCED TEST MODE: Driver found! (All checks bypassed)',
        timeout: TIMEOUTS.MATCH_PROPOSAL,
        testMode: true,
        forcedMatch: true
      });
      
      console.log(`   📱 WebSocket fallback notifications sent`);
      return true;
      
    } catch (error) {
      console.error(`❌ Error in WebSocket fallback notifications:`, error);
      return false;
    }
  }
  
  // Check and expire match
  async checkAndExpireMatch(matchId) {
    try {
      const match = await this.firestoreService.getMatch(matchId);
      if (!match) return;
      
      const driverData = await this.firestoreService.getDriverSearch(match.driverId);
      const passengerData = await this.firestoreService.getPassengerSearch(match.passengerId);
      
      if (driverData && passengerData) {
        if (driverData.matchStatus === 'proposed' && driverData.matchId === matchId) {
          console.log(`⏰ Match proposal expired: ${matchId}`);
          
          // Reset match status
          await this.firestoreService.updateDriverSearch(match.driverId, {
            matchId: null,
            matchedWith: null,
            matchStatus: null,
            passenger: null,
            lastUpdated: Date.now()
          }, { immediate: true });
          
          await this.firestoreService.updatePassengerSearch(match.passengerId, {
            matchId: null,
            matchedWith: null,
            matchStatus: null,
            driver: null,
            lastUpdated: Date.now()
          }, { immediate: true });
          
          // Update match document
          await this.firestoreService.db.collection('active_matches').doc(matchId).update({
            matchStatus: 'expired',
            expiredAt: new Date(),
            updatedAt: new Date(),
            expiryReason: 'timeout'
          });
          
          // Notify users via notificationService
          await notificationService.sendMatchExpired(
            matchId,
            match.driverId,
            match.passengerId,
            'Match proposal expired'
          );
        }
      }
    } catch (error) {
      console.error('❌ Error expiring match:', error);
    }
  }
  
  // Clear expired match proposals
  async clearExpiredMatchProposals() {
    try {
      const now = Date.now();
      const expiryTime = new Date(now - TIMEOUTS.MATCH_PROPOSAL);
      
      // Find all proposed matches
      const matchesSnapshot = await this.firestoreService.db.collection('active_matches')
        .where('matchStatus', '==', 'proposed')
        .get();
      
      let clearedCount = 0;
      
      for (const matchDoc of matchesSnapshot.docs) {
        const matchData = matchDoc.data();
        const matchId = matchData.matchId;
        
        let createdAt = null;
        
        if (matchData.createdAt) {
          if (matchData.createdAt.toDate) {
            createdAt = matchData.createdAt.toDate();
          } else if (matchData.createdAt._seconds) {
            createdAt = new Date(matchData.createdAt._seconds * 1000);
          } else if (matchData.createdAt instanceof Date) {
            createdAt = matchData.createdAt;
          }
        }
        
        if (!createdAt) {
          createdAt = new Date(0);
        }
        
        const ageMs = now - createdAt.getTime();
        
        if (ageMs > TIMEOUTS.MATCH_PROPOSAL) {
          // Clear driver's match status
          await this.firestoreService.updateDriverSearch(matchData.driverId, {
            matchId: null,
            matchedWith: null,
            matchStatus: null,
            passenger: null,
            lastUpdated: Date.now()
          }, { immediate: true });
          
          // Clear passenger's match status
          await this.firestoreService.updatePassengerSearch(matchData.passengerId, {
            matchId: null,
            matchedWith: null,
            matchStatus: null,
            driver: null,
            lastUpdated: Date.now()
          }, { immediate: true });
          
          // Update match document
          await matchDoc.ref.update({
            matchStatus: 'expired',
            expiredAt: new Date(),
            expiryReason: 'timeout'
          });
          
          // Send expiration notifications
          await notificationService.sendMatchExpired(
            matchId,
            matchData.driverId,
            matchData.passengerId,
            'Match proposal expired - timeout'
          );
          
          clearedCount++;
        }
      }
      
      if (clearedCount > 0) {
        console.log(`🎉 Cleared ${clearedCount} expired match proposals`);
      }
      
      return clearedCount;
      
    } catch (error) {
      console.error('❌ Error clearing expired match proposals:', error);
      return 0;
    }
  }
  
  // Cleanup expired searches
  async cleanupExpiredSearches() {
    try {
      const now = new Date();
      const expiryTime = new Date(now.getTime() - (30 * 60 * 1000));
      
      // Clean up expired driver searches
      const driverSnapshot = await this.firestoreService.db.collection('active_searches_driver')
        .where('updatedAt', '<', expiryTime)
        .where('status', '==', 'searching')
        .get();
      
      let driverCleanupCount = 0;
      for (const doc of driverSnapshot.docs) {
        await doc.ref.update({
          status: 'expired',
          updatedAt: new Date()
        });
        driverCleanupCount++;
      }
      
      // Clean up expired passenger searches
      const passengerSnapshot = await this.firestoreService.db.collection('active_searches_passenger')
        .where('updatedAt', '<', expiryTime)
        .where('status', '==', 'searching')
        .get();
      
      let passengerCleanupCount = 0;
      for (const doc of passengerSnapshot.docs) {
        await doc.ref.update({
          status: 'expired',
          updatedAt: new Date()
        });
        passengerCleanupCount++;
      }
      
      if (driverCleanupCount > 0 || passengerCleanupCount > 0) {
        console.log(`🧹 Cleaned up ${driverCleanupCount} driver searches and ${passengerCleanupCount} passenger searches`);
      }
      
    } catch (error) {
      console.error('❌ Error cleaning up expired searches:', error);
    }
  }
  
  // Get service statistics
  getStats() {
    return {
      cycles: this.cycleCount,
      successfulMatches: this.successfulMatches,
      failedMatches: this.failedMatches,
      totalAttempts: this.matchAttempts,
      successRate: this.matchAttempts > 0 ? (this.successfulMatches / this.matchAttempts * 100).toFixed(1) + '%' : '0%',
      forcedTestMode: this.FORCE_TEST_MODE
    };
  }
  
  // Manual match function for testing
  async manualMatch(driverId, passengerId) {
    console.log(`\n🔧 MANUAL MATCH REQUESTED: ${driverId} ↔ ${passengerId}`);
    
    try {
      // Get driver and passenger data
      const driver = await this.firestoreService.getDriverSearch(driverId);
      const passenger = await this.firestoreService.getPassengerSearch(passengerId);
      
      if (!driver || !passenger) {
        console.log(`❌ Driver or passenger not found`);
        return false;
      }
      
      console.log(`   Driver: ${driver.driverName}`);
      console.log(`   Passenger: ${passenger.passengerName}`);
      
      const result = await this.createForcedMatch(driver, passenger);
      console.log(`   Result: ${result ? '✅ Success' : '❌ Failed'}`);
      return result;
      
    } catch (error) {
      console.error('❌ Error in manual match:', error);
      return false;
    }
  }
}

module.exports = MatchingService;
