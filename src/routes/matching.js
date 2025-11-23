// src/routes/matching.js
const express = require("express");
const router = express.Router();

const { db } = require("../app");
const { calculateRouteSimilarity, isLocationAlongRoute, generateRouteHash, hasCapacity, updateDriverCapacity } = require("../utils/routeMatching");
const { createMatchProposal } = require("../utils/matchProposal");

// Unified search endpoint for both driver and passenger
router.post("/search", async (req, res) => {
  try {
    const userData = req.body;
    const { 
      userId, 
      userType, 
      rideType, 
      pickupLocation, 
      destinationLocation, 
      passengerCount = 1,
      capacity = 4,
      currentPassengers = 0
    } = userData;

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

    console.log(`🔍 Search request: ${userType} ${userId} for ${rideType} ride from ${pickupLocation.address} to ${destinationLocation.address}`);

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
    const matchProposals = [];
    const topMatches = matches.slice(0, 5); // Increased to 5 matches
    
    for (const match of topMatches) {
      const proposal = await createMatchProposal(db, match, rideType);
      if (proposal) {
        matchProposals.push(proposal);
      }
    }

    res.json({
      success: true,
      matches: matchProposals,
      totalMatches: matchProposals.length,
      searchId: `search_${Date.now()}_${userId}`,
      userType: userType,
      rideType: rideType
    });

  } catch (error) {
    console.error('❌ Error in unified search:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: 'Search failed due to server error'
    });
  }
});

// Passenger searching for drivers
async function findDriversForPassenger(db, passengerData, routeHash, rideType) {
  const matches = [];

  try {
    let query = db.collection('active_searches')
      .where('isActive', '==', true)
      .where('userType', '==', 'driver')
      .where('searchType', '==', rideType === 'immediate' ? 'real_time' : 'scheduled');

    // Check capacity
    query = query.where('passengerCapacity', '>=', passengerData.passengerCount || 1);

    // For scheduled rides, add time filter
    if (rideType === 'scheduled' && passengerData.scheduledTime) {
      const scheduledTime = new Date(passengerData.scheduledTime);
      const flexibility = passengerData.flexibility || 15; // minutes
      const startTime = new Date(scheduledTime.getTime() - flexibility * 60000);
      const endTime = new Date(scheduledTime.getTime() + flexibility * 60000);
      
      query = query
        .where('scheduledTime', '>=', startTime.toISOString())
        .where('scheduledTime', '<=', endTime.toISOString());
    }

    const driversSnapshot = await query.limit(20).get();

    for (const driverDoc of driversSnapshot.docs) {
      const driverData = driverDoc.data();

      // Check available capacity
      const availableSeats = driverData.passengerCapacity - (driverData.currentPassengers || 0);
      if (availableSeats < (passengerData.passengerCount || 1)) {
        continue;
      }

      // Calculate route similarity
      const passengerRoute = passengerData.routePoints || [
        passengerData.pickupLocation, 
        passengerData.destinationLocation
      ];
      
      const driverRoute = driverData.routePoints || [
        driverData.pickupLocation, 
        driverData.destinationLocation
      ];

      const similarity = calculateRouteSimilarity(passengerRoute, driverRoute);

      // Check if pickup is along driver's route
      const pickupAlongRoute = isLocationAlongRoute(
        passengerData.pickupLocation,
        driverRoute,
        passengerData.maxWalkDistance || 0.5
      );

      // Check if dropoff is along driver's route
      const dropoffAlongRoute = isLocationAlongRoute(
        passengerData.destinationLocation,
        driverRoute,
        passengerData.maxWalkDistance || 0.5
      );

      const similarityThreshold = rideType === 'immediate' ? 0.6 : 0.7;

      if (similarity >= similarityThreshold && pickupAlongRoute && dropoffAlongRoute) {
        matches.push({
          matchId: `match_${Date.now()}_${driverDoc.id}_${passengerData.userId}`,
          driverId: driverData.driverId || driverDoc.id,
          passengerId: passengerData.userId,
          similarity: similarity,
          driverData: {
            ...driverData,
            documentId: driverDoc.id
          },
          passengerData: passengerData,
          pickupLocation: passengerData.pickupLocation,
          destinationLocation: passengerData.destinationLocation,
          proposedFare: calculateProposedFare(driverData, passengerData),
          scheduledTime: passengerData.scheduledTime || driverData.scheduledTime,
          timestamp: new Date(),
          status: 'proposed'
        });
      }
    }

    console.log(`✅ Found ${matches.length} drivers for passenger ${passengerData.userId}`);
  } catch (error) {
    console.error('❌ Error finding drivers for passenger:', error);
  }

  return matches.sort((a, b) => b.similarity - a.similarity);
}

// Driver searching for passengers
async function findPassengersForDriver(db, driverData, routeHash, rideType) {
  const matches = [];

  try {
    let query = db.collection('active_searches')
      .where('isActive', '==', true)
      .where('userType', '==', 'passenger')
      .where('searchType', '==', rideType === 'immediate' ? 'real_time' : 'scheduled');

    // Check passenger count doesn't exceed capacity
    const availableSeats = driverData.capacity - (driverData.currentPassengers || 0);
    query = query.where('passengerCount', '<=', availableSeats);

    // For scheduled rides, add time filter
    if (rideType === 'scheduled' && driverData.scheduledTime) {
      const scheduledTime = new Date(driverData.scheduledTime);
      const flexibility = driverData.flexibility || 15; // minutes
      const startTime = new Date(scheduledTime.getTime() - flexibility * 60000);
      const endTime = new Date(scheduledTime.getTime() + flexibility * 60000);
      
      query = query
        .where('scheduledTime', '>=', startTime.toISOString())
        .where('scheduledTime', '<=', endTime.toISOString());
    }

    const passengersSnapshot = await query.limit(20).get();

    for (const passengerDoc of passengersSnapshot.docs) {
      const passengerData = passengerDoc.data();

      // Calculate route similarity
      const passengerRoute = passengerData.routePoints || [
        passengerData.pickupLocation, 
        passengerData.destinationLocation
      ];
      
      const driverRoute = driverData.routePoints || [
        driverData.pickupLocation, 
        driverData.destinationLocation
      ];

      const similarity = calculateRouteSimilarity(passengerRoute, driverRoute);

      // Check if pickup is along driver's route
      const pickupAlongRoute = isLocationAlongRoute(
        passengerData.pickupLocation,
        driverRoute,
        passengerData.maxWalkDistance || 0.5
      );

      // Check if dropoff is along driver's route
      const dropoffAlongRoute = isLocationAlongRoute(
        passengerData.destinationLocation,
        driverRoute,
        passengerData.maxWalkDistance || 0.5
      );

      const similarityThreshold = rideType === 'immediate' ? 0.6 : 0.7;

      if (similarity >= similarityThreshold && pickupAlongRoute && dropoffAlongRoute) {
        matches.push({
          matchId: `match_${Date.now()}_${driverData.userId}_${passengerDoc.id}`,
          driverId: driverData.userId,
          passengerId: passengerData.userId || passengerDoc.id,
          similarity: similarity,
          driverData: driverData,
          passengerData: {
            ...passengerData,
            documentId: passengerDoc.id
          },
          pickupLocation: passengerData.pickupLocation,
          destinationLocation: passengerData.destinationLocation,
          proposedFare: calculateProposedFare(driverData, passengerData),
          scheduledTime: driverData.scheduledTime || passengerData.scheduledTime,
          timestamp: new Date(),
          status: 'proposed'
        });
      }
    }

    console.log(`✅ Found ${matches.length} passengers for driver ${driverData.userId}`);
  } catch (error) {
    console.error('❌ Error finding passengers for driver:', error);
  }

  return matches.sort((a, b) => b.similarity - a.similarity);
}

// Calculate proposed fare based on distance, time, and preferences
function calculateProposedFare(driverData, passengerData) {
  const baseFare = 50; // Base fare
  const perKmRate = 15; // Per kilometer rate
  const perMinuteRate = 2; // Per minute rate
  
  const distance = driverData.distance || passengerData.distance || 5; // Default 5km
  const duration = driverData.duration || passengerData.duration || 15; // Default 15min
  
  let fare = baseFare + (distance * perKmRate) + (duration * perMinuteRate);
  
  // Adjust based on driver's estimated fare if available
  if (driverData.estimatedFare) {
    fare = (fare + driverData.estimatedFare) / 2;
  }
  
  // Adjust based on passenger's estimated fare if available
  if (passengerData.estimatedFare) {
    fare = (fare + passengerData.estimatedFare) / 2;
  }
  
  return Math.round(fare);
}

// Accept match and update capacity
router.post("/accept", async (req, res) => {
  try {
    const { matchId, userId, userType } = req.body;
    
    console.log(`✅ Accepting match: ${matchId} for user: ${userId} (${userType})`);

    // Find the match proposal
    const matchQuery = await db.collection('match_proposals')
      .where('matchId', '==', matchId)
      .limit(1)
      .get();

    if (matchQuery.empty) {
      return res.status(404).json({ 
        success: false, 
        error: 'Match proposal not found' 
      });
    }

    const matchDoc = matchQuery.docs[0];
    const match = matchDoc.data();

    // Update match status to accepted
    await matchDoc.ref.update({
      status: 'accepted',
      acceptedBy: userId,
      acceptedAt: new Date(),
      updatedAt: new Date()
    });

    // Update driver capacity for immediate rides
    if (match.rideType === 'immediate' && userType === 'driver') {
      const passengerCount = match.passengerData?.passengerCount || 1;
      await updateDriverCapacity(db, match.driverId, passengerCount, 'add');
    }

    // Create ride session
    const rideSession = {
      rideId: `ride_${Date.now()}_${match.driverId}_${match.passengerId}`,
      driverId: match.driverId,
      passengerId: match.passengerId,
      matchId: matchId,
      pickupLocation: match.pickupLocation,
      destinationLocation: match.destinationLocation,
      proposedFare: match.proposedFare,
      status: 'accepted',
      rideType: match.rideType,
      scheduledTime: match.scheduledTime,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await db.collection('active_rides').doc(rideSession.rideId).set(rideSession);

    // Notify both parties (you can implement push notifications here)
    await notifyMatchAcceptance(match, userId);

    res.json({ 
      success: true, 
      message: 'Match accepted successfully',
      rideId: rideSession.rideId,
      match: {
        ...match,
        status: 'accepted'
      }
    });

  } catch (error) {
    console.error('❌ Error accepting match:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Reject match
router.post("/reject", async (req, res) => {
  try {
    const { matchId, userId, reason } = req.body;

    console.log(`❌ Rejecting match: ${matchId} by user: ${userId}`);

    const matchQuery = await db.collection('match_proposals')
      .where('matchId', '==', matchId)
      .limit(1)
      .get();

    if (matchQuery.empty) {
      return res.status(404).json({ 
        success: false, 
        error: 'Match proposal not found' 
      });
    }

    const matchDoc = matchQuery.docs[0];
    
    await matchDoc.ref.update({
      status: 'rejected',
      rejectedBy: userId,
      rejectionReason: reason || 'No reason provided',
      rejectedAt: new Date(),
      updatedAt: new Date()
    });

    res.json({ 
      success: true, 
      message: 'Match rejected successfully' 
    });

  } catch (error) {
    console.error('❌ Error rejecting match:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get user's active matches
router.get("/user-matches/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { status = 'proposed', limit = 10 } = req.query;

    console.log(`📋 Getting matches for user: ${userId} with status: ${status}`);

    const matchesQuery = await db.collection('match_proposals')
      .where('status', '==', status)
      .where('$or', [
        { driverId: userId },
        { passengerId: userId }
      ])
      .orderBy('timestamp', 'desc')
      .limit(parseInt(limit))
      .get();

    const matches = matchesQuery.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({
      success: true,
      matches: matches,
      total: matches.length
    });

  } catch (error) {
    console.error('❌ Error getting user matches:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get match details
router.get("/details/:matchId", async (req, res) => {
  try {
    const { matchId } = req.params;

    const matchQuery = await db.collection('match_proposals')
      .where('matchId', '==', matchId)
      .limit(1)
      .get();

    if (matchQuery.empty) {
      return res.status(404).json({ 
        success: false, 
        error: 'Match not found' 
      });
    }

    const match = matchQuery.docs[0].data();

    // Get additional user details if needed
    const driverDetails = await getUserDetails(db, match.driverId, 'driver');
    const passengerDetails = await getUserDetails(db, match.passengerId, 'passenger');

    res.json({
      success: true,
      match: {
        ...match,
        driverDetails: driverDetails,
        passengerDetails: passengerDetails
      }
    });

  } catch (error) {
    console.error('❌ Error getting match details:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Helper function to get user details
async function getUserDetails(db, userId, userType) {
  try {
    if (userType === 'driver') {
      const driverQuery = await db.collection('drivers')
        .where('driverId', '==', userId)
        .limit(1)
        .get();

      if (!driverQuery.empty) {
        return driverQuery.docs[0].data();
      }
    }

    // For passengers, you might have a passengers collection
    const userQuery = await db.collection('users')
      .where('userId', '==', userId)
      .limit(1)
      .get();

    return userQuery.empty ? null : userQuery.docs[0].data();
  } catch (error) {
    console.error(`Error getting ${userType} details:`, error);
    return null;
  }
}

// Helper function to notify match acceptance
async function notifyMatchAcceptance(match, acceptedByUserId) {
  try {
    // Implement your notification logic here
    // This could be Firebase Cloud Messaging, WebSockets, etc.
    
    const notification = {
      type: 'match_accepted',
      matchId: match.matchId,
      acceptedBy: acceptedByUserId,
      timestamp: new Date(),
      rideDetails: {
        pickup: match.pickupLocation?.address,
        destination: match.destinationLocation?.address,
        fare: match.proposedFare
      }
    };

    console.log('📢 Match acceptance notification:', notification);
    
    // Example: Send to both users
    // await sendPushNotification(match.driverId, notification);
    // await sendPushNotification(match.passengerId, notification);
    
  } catch (error) {
    console.error('Error sending match acceptance notification:', error);
  }
}

module.exports = router;
