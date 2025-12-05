const { TIMEOUTS, TEST_MODE } = require('../config/constants');
const routeMatching = require('../utils/routeMatching');
const helpers = require('../utils/helpers');

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
  }
  
  // Start matching service
  start() {
    console.log('🔄 Starting Optimized Matching Service...');
    console.log(`🧪 TEST MODE: ${TEST_MODE ? 'ACTIVE' : 'INACTIVE'}`);
    console.log(`📏 MAX DISTANCE: ${TEST_MODE ? 'UNLIMITED (Test Mode)' : '10km'}`);
    
    const matchingInterval = TIMEOUTS.MATCHING_INTERVAL;
    
    // Immediate first run
    setTimeout(() => {
      this.performMatchingCycle();
    }, 1000);
    
    // Then regular intervals
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
    
    console.log('✅ Matching Service started');
  }
  
  // Perform matching cycle
  async performMatchingCycle() {
    this.cycleCount++;
    console.log(`\n📊 ===== MATCHING CYCLE #${this.cycleCount} START =====`);
    
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
        console.log(`      Route points: ${driver.routePoints?.length || 0}`);
      });
      
      console.log('\n🔍 DEBUG - Active Passengers:');
      passengers.forEach((passenger, i) => {
        console.log(`   ${i+1}. ${passenger.passengerName || 'Unknown'} (${passenger.passengerId || passenger.userId})`);
        console.log(`      Status: ${passenger.status}, Match: ${passenger.matchStatus || 'none'}`);
        console.log(`      Count: ${passenger.passengerCount || 1}`);
        console.log(`      From: ${passenger.pickupName || 'Unknown'} to ${passenger.destinationName || 'Unknown'}`);
        console.log(`      Route points: ${passenger.routePoints?.length || 0}`);
      });
      
      let matchesCreated = 0;
      let matchAttempts = 0;
      
      // Perform matching - SIMPLIFIED VERSION THAT WORKS EVEN WITH FAR DISTANCES
      for (const driver of drivers) {
        const driverUserId = driver.driverId || driver.userId;
        
        // Skip if driver already has a match
        if (driver.matchStatus === 'proposed' || driver.matchStatus === 'accepted') {
          continue;
        }
        
        // Check driver is searching
        if (driver.status !== 'searching') {
          continue;
        }
        
        // Check available seats
        const availableSeats = driver.availableSeats || driver.capacity || 4;
        if (availableSeats <= 0) {
          continue;
        }
        
        for (const passenger of passengers) {
          const passengerUserId = passenger.passengerId || passenger.userId;
          matchAttempts++;
          
          // Skip if passenger already has a match
          if (passenger.matchStatus === 'proposed' || passenger.matchStatus === 'accepted') {
            continue;
          }
          
          // Check passenger is searching
          if (passenger.status !== 'searching') {
            continue;
          }
          
          // Check passenger count fits in available seats
          const passengerCount = passenger.passengerCount || 1;
          if (passengerCount > availableSeats) {
            continue;
          }
          
          // SIMPLE CHECK: In test mode, match ANY driver with ANY passenger regardless of distance
          if (TEST_MODE) {
            console.log(`\n🎯 TEST MODE: Matching ${driver.driverName} with ${passenger.passengerName}`);
            console.log(`   Ignoring distance check in test mode`);
            
            const matchCreated = await this.createSimpleMatch(driver, passenger);
            if (matchCreated) {
              matchesCreated++;
              break; // Driver can only take one passenger at a time
            }
          } else {
            // Normal mode: Try route matching
            try {
              const match = await routeMatching.performIntelligentMatching(
                this.firestoreService.db, 
                driver, 
                passenger
              );
              
              if (match) {
                console.log(`\n🎯 Route match found: ${driver.driverName} ↔ ${passenger.passengerName}`);
                console.log(`   Similarity score: ${match.similarityScore}`);
                
                const matchCreated = await this.createSimpleMatch(driver, passenger, match);
                if (matchCreated) {
                  matchesCreated++;
                  break; // Driver can only take one passenger at a time
                }
              }
            } catch (error) {
              console.log(`   ⚠️ Route matching error: ${error.message}`);
            }
          }
        }
      }
      
      if (matchesCreated > 0) {
        console.log(`\n🎉 SUCCESS: Created ${matchesCreated} match${matchesCreated > 1 ? 'es' : ''} this cycle`);
        this.successfulMatches += matchesCreated;
      } else {
        console.log(`\n🔍 No new matches created this cycle`);
      }
      
      this.matchAttempts += matchAttempts;
      console.log(`📈 Stats: ${this.successfulMatches} successful, ${this.failedMatches} failed (${this.matchAttempts} total attempts)`);
      
    } catch (error) {
      console.error('❌ Matching cycle error:', error);
    }
    
    console.log(`📊 ===== MATCHING CYCLE END =====\n`);
  }
  
  // Create simple match (bypasses complex route checking)
  async createSimpleMatch(driver, passenger, routeMatch = null) {
    try {
      const matchId = `match_${Date.now()}_${helpers.generateId(6)}`;
      const driverUserId = driver.driverId || driver.userId;
      const passengerUserId = passenger.passengerId || passenger.userId;
      
      console.log(`🤝 Creating match ${matchId}`);
      console.log(`   Driver: ${driver.driverName} (${driverUserId})`);
      console.log(`   Passenger: ${passenger.passengerName} (${passengerUserId})`);
      
      const matchData = {
        matchId: matchId,
        driverId: driverUserId,
        driverName: driver.driverName || 'Unknown Driver',
        driverPhone: driver.driverPhone || 'Not provided',
        driverPhotoUrl: driver.driverPhotoUrl || '',
        driverRating: driver.driverRating || 5.0,
        vehicleInfo: driver.vehicleInfo || {},
        passengerId: passengerUserId,
        passengerName: passenger.passengerName || 'Unknown Passenger',
        passengerPhone: passenger.passengerPhone || 'Not provided',
        passengerPhotoUrl: passenger.passengerPhotoUrl || '',
        passengerCount: passenger.passengerCount || 1,
        pickupLocation: passenger.pickupLocation || driver.pickupLocation,
        pickupName: passenger.pickupName || driver.pickupName || 'Pickup Location',
        destinationLocation: passenger.destinationLocation || driver.destinationLocation,
        destinationName: passenger.destinationName || driver.destinationName || 'Destination',
        distance: passenger.distance || driver.distance || 0,
        duration: passenger.duration || driver.duration || 0,
        estimatedFare: passenger.estimatedFare || driver.estimatedFare || 0,
        similarityScore: routeMatch?.similarityScore || 0.8, // Default score
        matchScore: 85, // Arbitrary high score
        matchStatus: 'proposed',
        rideType: driver.rideType || passenger.rideType || 'immediate',
        scheduledTime: driver.scheduledTime || passenger.scheduledTime,
        createdAt: new Date(),
        expiresAt: Date.now() + TIMEOUTS.MATCH_PROPOSAL,
        notified: false,
        matchType: 'simple',
        testMode: TEST_MODE,
        distanceIgnored: TEST_MODE
      };
      
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
        lastUpdated: Date.now()
      };
      
      await this.firestoreService.updateDriverSearch(driverUserId, driverUpdates, { immediate: true });
      console.log(`   ✅ Driver updated`);
      
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
        lastUpdated: Date.now()
      };
      
      await this.firestoreService.updatePassengerSearch(passengerUserId, passengerUpdates, { immediate: true });
      console.log(`   ✅ Passenger updated`);
      
      // Send WebSocket notifications
      if (this.websocketServer) {
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
          message: TEST_MODE ? 'TEST MODE: Match found!' : 'New passenger match found!',
          timeout: TIMEOUTS.MATCH_PROPOSAL,
          testMode: TEST_MODE
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
          message: TEST_MODE ? 'TEST MODE: Driver found!' : 'Driver match found!',
          timeout: TIMEOUTS.MATCH_PROPOSAL,
          testMode: TEST_MODE
        });
        
        console.log(`   📱 WebSocket notifications sent`);
      }
      
      // Set timeout for match proposal
      setTimeout(async () => {
        await this.checkAndExpireMatch(matchId);
      }, TIMEOUTS.MATCH_PROPOSAL);
      
      console.log(`✅ Match ${matchId} created successfully!`);
      return true;
      
    } catch (error) {
      console.error(`❌ Error creating match:`, error);
      this.failedMatches++;
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
            updatedAt: new Date()
          });
          
          // Notify users
          if (this.websocketServer) {
            this.websocketServer.sendMatchExpired(match.driverId, {
              matchId: matchId,
              message: 'Match proposal expired - passenger not accepted in time'
            });
            
            this.websocketServer.sendMatchExpired(match.passengerId, {
              matchId: matchId,
              message: 'Match proposal expired'
            });
          }
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
      successRate: this.matchAttempts > 0 ? (this.successfulMatches / this.matchAttempts * 100).toFixed(1) + '%' : '0%'
    };
  }
}

module.exports = MatchingService;
