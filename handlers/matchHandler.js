// handlers/matchHandler.js
const admin = require('firebase-admin');
const { performIntelligentMatching } = require('../utils/routeMatching');

class MatchHandler {
  constructor(db) {
    this.db = db;
  }

  // Handle new driver search
  async handleNewDriverSearch(driverData) {
    try {
      console.log(`🚗 New driver search: ${driverData.driverId}`);
      
      // Find matching passengers
      const matchingPassengers = await this.findMatchingPassengers(driverData);
      
      if (matchingPassengers.length === 0) {
        console.log('📭 No matching passengers found');
        return [];
      }

      console.log(`🎯 Found ${matchingPassengers.length} potential passenger matches`);
      
      // Create matches
      const createdMatches = [];
      for (const passenger of matchingPassengers) {
        const match = await performIntelligentMatching(this.db, driverData, passenger);
        if (match) {
          createdMatches.push(match);
        }
      }
      
      console.log(`✅ Created ${createdMatches.length} matches for driver ${driverData.driverId}`);
      return createdMatches;
      
    } catch (error) {
      console.error('❌ Error handling new driver search:', error);
      return [];
    }
  }

  // Handle new passenger search
  async handleNewPassengerSearch(passengerData) {
    try {
      console.log(`👤 New passenger search: ${passengerData.passengerId}`);
      
      // Find matching drivers
      const matchingDrivers = await this.findMatchingDrivers(passengerData);
      
      if (matchingDrivers.length === 0) {
        console.log('📭 No matching drivers found');
        return [];
      }

      console.log(`🎯 Found ${matchingDrivers.length} potential driver matches`);
      
      // Create matches
      const createdMatches = [];
      for (const driver of matchingDrivers) {
        const match = await performIntelligentMatching(this.db, driver, passengerData);
        if (match) {
          createdMatches.push(match);
        }
      }
      
      console.log(`✅ Created ${createdMatches.length} matches for passenger ${passengerData.passengerId}`);
      return createdMatches;
      
    } catch (error) {
      console.error('❌ Error handling new passenger search:', error);
      return [];
    }
  }

  // Find matching passengers for a driver
  async findMatchingPassengers(driverData) {
    try {
      const passengersSnapshot = await this.db.collection('active_searches')
        .where('userType', '==', 'passenger')
        .where('isActive', '==', true)
        .get();

      return passengersSnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
    } catch (error) {
      console.error('❌ Error finding matching passengers:', error);
      return [];
    }
  }

  // Find matching drivers for a passenger
  async findMatchingDrivers(passengerData) {
    try {
      const driversSnapshot = await this.db.collection('active_searches')
        .where('userType', '==', 'driver')
        .where('isActive', '==', true)
        .get();

      return driversSnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
    } catch (error) {
      console.error('❌ Error finding matching drivers:', error);
      return [];
    }
  }

  // Handle match decision (accept/reject)
  async handleMatchDecision(matchId, decision, userId) {
    try {
      console.log(`🤝 Handling match decision: ${matchId} - ${decision} by ${userId}`);
      
      const matchRef = this.db.collection('potential_matches').doc(matchId);
      const matchDoc = await matchRef.get();
      
      if (!matchDoc.exists) {
        throw new Error('Match not found');
      }

      const matchData = matchDoc.data();
      
      // Update match status
      await matchRef.update({
        status: decision ? 'accepted' : 'rejected',
        decidedBy: userId,
        decidedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Clean up active match for overlay
      await this.db.collection('active_matches').doc(matchId).delete();

      console.log(`✅ Match ${matchId} ${decision ? 'accepted' : 'rejected'} by ${userId}`);
      
      return {
        success: true,
        matchId,
        status: decision ? 'accepted' : 'rejected'
      };
      
    } catch (error) {
      console.error('❌ Error handling match decision:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Clean up old active matches
  async cleanupExpiredMatches() {
    try {
      const cutoffTime = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes
      
      const expiredMatches = await this.db.collection('active_matches')
        .where('createdAt', '<', cutoffTime)
        .get();

      const batch = this.db.batch();
      expiredMatches.forEach(doc => {
        batch.delete(doc.ref);
      });

      await batch.commit();
      console.log(`🧹 Cleaned up ${expiredMatches.size} expired active matches`);
      
    } catch (error) {
      console.error('❌ Error cleaning up expired matches:', error);
    }
  }
}

module.exports = MatchHandler;
