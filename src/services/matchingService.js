const { TIMEOUTS, TEST_MODE } = require('../config/constants');
const routeMatching = require('../utils/routeMatching');
const helpers = require('../utils/helpers');

class MatchingService {
  constructor(firestoreService, searchService, websocketServer) {
    this.firestoreService = firestoreService;
    this.searchService = searchService;
    this.websocketServer = websocketServer;
  }
  
  // Start matching service
  start() {
    console.log('🔄 Starting Optimized Matching Service...');
    console.log(`🧪 TEST MODE: ${TEST_MODE ? 'ACTIVE' : 'INACTIVE'}`);
    
    const matchingInterval = TIMEOUTS.MATCHING_INTERVAL;
    
    setInterval(async () => {
      await this.performMatchingCycle();
    }, matchingInterval);
    
    // Add cleanup for expired searches
    setInterval(async () => {
      await this.cleanupExpiredSearches();
    }, 5 * 60 * 1000); // Every 5 minutes
    
    // Clean processed matches
    setInterval(() => {
      this.searchService.cleanupOldData();
    }, 60000);
  }
  
  // Perform matching cycle
  async performMatchingCycle() {
    try {
      console.log(`\n📊 ===== MATCHING CYCLE START =====`);
      
      // Clear expired match proposals
      await this.clearExpiredMatchProposals();
      
      // Get active searches from Firestore (cached)
      const { drivers, passengers } = await this.firestoreService.getAllActiveSearches();
      
      console.log(`📊 Matching: ${drivers.length} drivers vs ${passengers.length} passengers`);
      
      if (drivers.length === 0 || passengers.length === 0) {
        console.log(`💤 No matches possible`);
        console.log(`📊 ===== MATCHING CYCLE END =====\n`);
        return;
      }
      
      let matchesCreated = 0;
      
      // Perform matching
      for (const driver of drivers) {
        const driverUserId = driver.driverId || driver.userId;
        
        // Skip if driver already has a match
        if (driver.matchStatus === 'proposed' || driver.matchStatus === 'accepted') {
          continue;
        }
        
        // Check available seats
        const availableSeats = driver.availableSeats || driver.capacity || 4;
        if (availableSeats <= 0) {
          continue;
        }
        
        for (const passenger of passengers) {
          const passengerUserId = passenger.passengerId || passenger.userId;
          
          // Skip if passenger already has a match
          if (passenger.matchStatus === 'proposed' || passenger.matchStatus === 'accepted') {
            continue;
          }
          
          if (!driver.routePoints || driver.routePoints.length === 0) continue;
          if (!passenger.routePoints || passenger.routePoints.length === 0) continue;
          
          // Check passenger count fits in available seats
          const passengerCount = passenger.passengerCount || 1;
          if (passengerCount > availableSeats) {
            continue;
          }
          
          // Use intelligent matching
          const match = await routeMatching.performIntelligentMatching(
            this.firestoreService.db, 
            driver, 
            passenger
          );
          
          if (match) {
            const matchKey = helpers.generateMatchKey(driverUserId, passengerUserId, Date.now());
            
            if (!this.searchService.processedMatches.has(matchKey)) {
              const matchData = {
                matchId: match.matchId,
                driverId: driverUserId,
                driverName: driver.driverName || 'Unknown Driver',
                driverPhone: driver.driverPhone,
                driverPhotoUrl: driver.driverPhotoUrl,
                driverRating: driver.driverRating,
                vehicleInfo: driver.vehicleInfo,
                passengerId: passengerUserId,
                passengerName: passenger.passengerName || 'Unknown Passenger',
                passengerPhone: passenger.passengerPhone,
                passengerPhotoUrl: passenger.passengerPhotoUrl,
                similarityScore: match.similarityScore,
                pickupName: passenger.pickupName || driver.pickupName || 'Unknown Location',
                destinationName: passenger.destinationName || driver.destinationName || 'Unknown Destination',
                pickupLocation: passenger.pickupLocation || driver.pickupLocation,
                destinationLocation: passenger.destinationLocation || driver.destinationLocation,
                passengerCount: passengerCount,
                capacity: driver.capacity || 4,
                vehicleType: driver.vehicleType || 'car',
                rideType: driver.rideType || passenger.rideType || 'immediate',
                scheduledTime: driver.scheduledTime || passenger.scheduledTime,
                timestamp: new Date().toISOString(),
                matchType: 'separate_collections'
              };
              
              // Create match proposal
              const matchCreated = await this.createActiveMatchForOverlay(matchData);
              
              if (matchCreated) {
                matchesCreated++;
                this.searchService.processedMatches.set(matchKey, Date.now());
                console.log(`🎉 MATCH PROPOSAL CREATED: ${driver.driverName} ↔ ${passenger.passengerName}`);
              }
            }
          }
        }
      }
      
      if (matchesCreated > 0) {
        console.log(`📱 Created ${matchesCreated} match proposals`);
      } else {
        console.log(`🔍 No new matches created this cycle`);
      }
      
      console.log(`📊 ===== MATCHING CYCLE END =====\n`);
      
    } catch (error) {
      console.error('❌ Matching error:', error);
    }
  }
  
  // Create active match for overlay
  async createActiveMatchForOverlay(matchData) {
    try {
      // Store match in Firestore
      await this.firestoreService.saveMatch(matchData);
      
      // Update driver's document with match proposal
      const driverUpdates = {
        matchId: matchData.matchId,
        matchedWith: matchData.passengerId,
        matchStatus: 'proposed',
        matchProposedAt: this.firestoreService.admin.firestore.FieldValue.serverTimestamp(),
        lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
      };
      
      await this.firestoreService.updateDriverSearch(matchData.driverId, driverUpdates, { immediate: true });
      
      // Update passenger's document with match proposal
      const passengerUpdates = {
        matchId: matchData.matchId,
        matchedWith: matchData.driverId,
        matchStatus: 'proposed',
        matchProposedAt: this.firestoreService.admin.firestore.FieldValue.serverTimestamp(),
        lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
      };
      
      await this.firestoreService.updatePassengerSearch(matchData.passengerId, passengerUpdates, { immediate: true });
      
      console.log(`✅ Match proposal created: ${matchData.driverName} ↔ ${matchData.passengerName}`);
      
      // Send WebSocket notifications
      if (this.websocketServer) {
        // Send to driver
        this.websocketServer.sendMatchProposal(matchData.driverId, {
          matchId: matchData.matchId,
          passengerId: matchData.passengerId,
          passengerName: matchData.passengerName,
          passengerPhone: matchData.passengerPhone,
          pickupName: matchData.pickupName,
          destinationName: matchData.destinationName,
          passengerCount: matchData.passengerCount || 1,
          message: 'New passenger match found!',
          timeout: TIMEOUTS.MATCH_PROPOSAL
        });
        
        // Send to passenger
        this.websocketServer.sendMatchProposal(matchData.passengerId, {
          matchId: matchData.matchId,
          driverId: matchData.driverId,
          driverName: matchData.driverName,
          driverPhone: matchData.driverPhone,
          driverPhotoUrl: matchData.driverPhotoUrl,
          driverRating: matchData.driverRating,
          vehicleInfo: matchData.vehicleInfo,
          pickupName: matchData.pickupName,
          destinationName: matchData.destinationName,
          estimatedFare: matchData.estimatedFare,
          message: 'Driver match found! Please wait for driver acceptance.',
          timeout: TIMEOUTS.MATCH_PROPOSAL
        });
      }
      
      // Set timeout for match proposal
      setTimeout(async () => {
        await this.checkAndExpireMatch(matchData.matchId);
      }, TIMEOUTS.MATCH_PROPOSAL);
      
      return true;
      
    } catch (error) {
      console.error('❌ Error creating overlay match:', error);
      return false;
    }
  }
  
  // Check and expire match
  async checkAndExpireMatch(matchId) {
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
          lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
        }, { immediate: true });
        
        await this.firestoreService.updatePassengerSearch(match.passengerId, {
          matchId: null,
          matchedWith: null,
          matchStatus: null,
          driver: null,
          lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
        }, { immediate: true });
        
        // Update match document
        await this.firestoreService.db.collection('active_matches').doc(matchId).update({
          matchStatus: 'expired',
          expiredAt: this.firestoreService.admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
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
            lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
          }, { immediate: true });
          
          // Clear passenger's match status
          await this.firestoreService.updatePassengerSearch(matchData.passengerId, {
            matchId: null,
            matchedWith: null,
            matchStatus: null,
            driver: null,
            lastUpdated: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
          }, { immediate: true });
          
          // Update match document
          await matchDoc.ref.update({
            matchStatus: 'expired',
            expiredAt: this.firestoreService.admin.firestore.FieldValue.serverTimestamp(),
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
        .where('updatedAt', '<', this.firestoreService.admin.firestore.Timestamp.fromDate(expiryTime))
        .where('status', '==', 'searching')
        .get();
      
      let driverCleanupCount = 0;
      driverSnapshot.forEach(async (doc) => {
        await doc.ref.update({
          status: 'expired',
          updatedAt: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
        });
        driverCleanupCount++;
      });
      
      // Clean up expired passenger searches
      const passengerSnapshot = await this.firestoreService.db.collection('active_searches_passenger')
        .where('updatedAt', '<', this.firestoreService.admin.firestore.Timestamp.fromDate(expiryTime))
        .where('status', '==', 'searching')
        .get();
      
      let passengerCleanupCount = 0;
      passengerSnapshot.forEach(async (doc) => {
        await doc.ref.update({
          status: 'expired',
          updatedAt: this.firestoreService.admin.firestore.FieldValue.serverTimestamp()
        });
        passengerCleanupCount++;
      });
      
      if (driverCleanupCount > 0 || passengerCleanupCount > 0) {
        console.log(`🧹 Cleaned up ${driverCleanupCount} driver searches and ${passengerCleanupCount} passenger searches`);
      }
      
    } catch (error) {
      console.error('❌ Error cleaning up expired searches:', error);
    }
  }
}

module.exports = MatchingService;
