const express = require("express");
const router = express.Router();

const { db } = require("../app");
const { calculateRouteSimilarity, isLocationAlongRoute, generateRouteHash, hasCapacity } = require("../utils/routeMatching");
const { createMatchProposal } = require("../utils/matchProposal");

// Unified search endpoint for both driver and passenger
router.post("/search", async (req, res) => {
  try {
    const userData = req.body;
    const { userId, userType, rideType, pickupLocation, destinationLocation, passengerCount = 1 } = userData;

    // Validate input
    if (!userId || !userType || !rideType || !pickupLocation || !destinationLocation) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: userId, userType, rideType, pickupLocation, destinationLocation"
      });
    }

    if (!['driver', 'passenger'].includes(userType)) {
      return res.status(400).json({
        success: false,
        error: "userType must be 'driver' or 'passenger'"
      });
    }

    if (!['immediate', 'scheduled'].includes(rideType)) {
      return res.status(400).json({
        success: false,
        error: "rideType must be 'immediate' or 'scheduled'"
      });
    }

    console.log(`Search request: ${userType} ${userId} for ${rideType} ride`);

    const routeHash = generateRouteHash(pickupLocation, destinationLocation);
    const matches = [];

    if (userType === 'passenger') {
      // Passenger searching for drivers
      matches.push(...await findDriversForPassenger(db, userData, routeHash, rideType));
    } else {
      // Driver searching for passengers
      matches.push(...await findPassengersForDriver(db, userData, routeHash, rideType));
    }

    // Create match proposals for top matches
    const topMatches = matches.slice(0, 3);
    for (const match of topMatches) {
      await createMatchProposal(db, match, rideType);
    }

    res.json({
      success: true,
      matchesFound: topMatches.length,
      matches: topMatches,
      userType: userType,
      rideType: rideType
    });

  } catch (error) {
    console.error('Error in unified search:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Passenger searching for drivers
async function findDriversForPassenger(db, passengerData, routeHash, rideType) {
  const collectionName = rideType === 'immediate' ? 'active_drivers' : 'scheduled_drivers';
  const matches = [];

  try {
    let query = db.collection(collectionName)
      .where('status', '==', 'searching')
      .where('routeHash', '==', routeHash)
      .where('capacity', '>=', passengerData.passengerCount || 1);

    // For scheduled rides, add time filter
    if (rideType === 'scheduled' && passengerData.scheduledTime) {
      const scheduledTime = new Date(passengerData.scheduledTime);
      const flexibility = passengerData.flexibility || 15;
      const startTime = new Date(scheduledTime.getTime() - flexibility * 60000);
      const endTime = new Date(scheduledTime.getTime() + flexibility * 60000);
      
      query = query
        .where('scheduledTime', '>=', startTime.toISOString())
        .where('scheduledTime', '<=', endTime.toISOString());
    }

    const driversSnapshot = await query.limit(20).get();

    for (const driverDoc of driversSnapshot.docs) {
      const driverData = driverDoc.data();

      // Check capacity
      if (!hasCapacity(driverData, passengerData.passengerCount || 1)) {
        continue;
      }

      const similarity = calculateRouteSimilarity(
        passengerData.routePoints || [passengerData.pickupLocation, passengerData.destinationLocation],
        driverData.routePoints || [driverData.pickupLocation, driverData.destinationLocation]
      );

      const pickupAlongRoute = isLocationAlongRoute(
        passengerData.pickupLocation,
        driverData.routePoints || [driverData.pickupLocation],
        passengerData.maxWalkDistance || 0.5
      );

      const dropoffAlongRoute = isLocationAlongRoute(
        passengerData.destinationLocation,
        driverData.routePoints || [driverData.destinationLocation],
        passengerData.maxWalkDistance || 0.5
      );

      const similarityThreshold = rideType === 'immediate' ? 0.6 : 0.7;

      if (similarity > similarityThreshold && pickupAlongRoute && dropoffAlongRoute) {
        matches.push({
          driverId: driverDoc.id,
          passengerId: passengerData.userId,
          similarity: similarity,
          driverData: driverData,
          passengerData: passengerData,
          scheduledTime: passengerData.scheduledTime,
          timestamp: new Date()
        });
      }
    }
  } catch (error) {
    console.error('Error finding drivers for passenger:', error);
  }

  return matches.sort((a, b) => b.similarity - a.similarity);
}

// Driver searching for passengers
async function findPassengersForDriver(db, driverData, routeHash, rideType) {
  const collectionName = rideType === 'immediate' ? 'active_passengers' : 'scheduled_passengers';
  const matches = [];

  try {
    let query = db.collection(collectionName)
      .where('status', '==', 'searching')
      .where('routeHash', '==', routeHash)
      .where('passengerCount', '<=', driverData.capacity);

    // For scheduled rides, add time filter
    if (rideType === 'scheduled' && driverData.scheduledTime) {
      const scheduledTime = new Date(driverData.scheduledTime);
      const flexibility = driverData.flexibility || 15;
      const startTime = new Date(scheduledTime.getTime() - flexibility * 60000);
      const endTime = new Date(scheduledTime.getTime() + flexibility * 60000);
      
      query = query
        .where('scheduledTime', '>=', startTime.toISOString())
        .where('scheduledTime', '<=', endTime.toISOString());
    }

    const passengersSnapshot = await query.limit(20).get();

    for (const passengerDoc of passengersSnapshot.docs) {
      const passengerData = passengerDoc.data();

      const similarity = calculateRouteSimilarity(
        passengerData.routePoints || [passengerData.pickupLocation, passengerData.destinationLocation],
        driverData.routePoints || [driverData.pickupLocation, driverData.destinationLocation]
      );

      const pickupAlongRoute = isLocationAlongRoute(
        passengerData.pickupLocation,
        driverData.routePoints || [driverData.pickupLocation],
        passengerData.maxWalkDistance || 0.5
      );

      const dropoffAlongRoute = isLocationAlongRoute(
        passengerData.destinationLocation,
        driverData.routePoints || [driverData.destinationLocation],
        passengerData.maxWalkDistance || 0.5
      );

      const similarityThreshold = rideType === 'immediate' ? 0.6 : 0.7;

      if (similarity > similarityThreshold && pickupAlongRoute && dropoffAlongRoute) {
        matches.push({
          driverId: driverData.userId,
          passengerId: passengerDoc.id,
          similarity: similarity,
          driverData: driverData,
          passengerData: passengerData,
          scheduledTime: driverData.scheduledTime,
          timestamp: new Date()
        });
      }
    }
  } catch (error) {
    console.error('Error finding passengers for driver:', error);
  }

  return matches.sort((a, b) => b.similarity - a.similarity);
}

// Accept match and update capacity
router.post("/accept", async (req, res) => {
  try {
    const { matchId, userId } = req.body;
    
    const matchDoc = await db.collection('ride_matches').doc(matchId).get();
    if (!matchDoc.exists) {
      return res.status(404).json({ success: false, error: 'Match not found' });
    }

    const match = matchDoc.data();
    
    // Update match status
    await db.collection('ride_matches').doc(matchId).update({
      status: 'accepted',
      acceptedAt: new Date()
    });

    // Update driver capacity
    if (match.type === 'immediate') {
      const { updateDriverCapacity } = require("../utils/routeMatching");
      await updateDriverCapacity(db, match.driverId, match.passengerCount, 'add');
    }

    res.json({ success: true, message: 'Match accepted successfully' });
  } catch (error) {
    console.error('Error accepting match:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
