// src/routes/matching.js - FIXED VERSION
const express = require("express");
const router = express.Router();

const { db } = require("../app");
const { calculateRouteSimilarity, isLocationAlongRoute, generateRouteHash, hasCapacity, updateDriverCapacity } = require("../utils/routeMatching");
const { createMatchProposal } = require("../utils/matchProposal");

// Unified search endpoint for both driver and passenger - FIXED: Simplified queries to avoid index issues
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
      // Passenger searching for drivers - FIXED: Use simplified query
      matches.push(...await findDriversForPassengerSimplified(db, userData, routeHash, rideType));
    } else {
      // Driver searching for passengers - FIXED: Use simplified query
      matches.push(...await findPassengersForDriverSimplified(db, userData, routeHash, rideType));
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
    
    // Better error handling for index issues
    if (error.code === 9 || error.message.includes('index')) {
      return res.status(400).json({ 
        success: false, 
        error: 'Search system is being optimized. Please try again in a moment.',
        details: 'Database index is building'
      });
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Search failed due to server error',
      details: error.message
    });
  }
});

// FIXED: Simplified driver search to avoid composite index requirements
async function findDriversForPassengerSimplified(db, passengerData, routeHash, rideType) {
  const matches = [];

  try {
    console.log(`🔍 Simplified search for passenger: ${passengerData.userId}`);
    
    // Step 1: Get all active drivers first (simple query)
    let driversQuery = db.collection('active_searches')
      .where('isActive', '==', true)
      .where('userType', '==', 'driver');

    const driversSnapshot = await driversQuery.limit(50).get(); // Increased limit for manual filtering

    console.log(`📊 Found ${driversSnapshot.size} active drivers, filtering manually...`);

    for (const driverDoc of driversSnapshot.docs) {
      const driverData = driverDoc.data();

      // Manual filtering for search type
      const driverSearchType = rideType === 'immediate' ? 'real_time' : 'scheduled';
      if (driverData.searchType !== driverSearchType) {
        continue;
      }

      // Manual filtering for capacity
      const availableSeats = driverData.passengerCapacity - (driverData.currentPassengers || 0);
      if (availableSeats < (passengerData.passengerCount || 1)) {
        continue;
      }

      // Manual filtering for scheduled time
      if (rideType === 'scheduled' && passengerData.scheduledTime) {
        if (!driverData.scheduledTime) continue;
        
        const passengerTime = new Date(passengerData.scheduledTime);
        const driverTime = new Date(driverData.scheduledTime);
        const flexibility = passengerData.flexibility || 15; // minutes
        const timeDiff = Math.abs(driverTime - passengerTime) / (1000 * 60); // minutes
        
        if (timeDiff > flexibility) {
          continue;
        }
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
          driverId: driverData.driverId || driverData.userId || driverDoc.id,
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
          status: 'proposed',
          rideType: rideType
        });
      }
    }

    console.log(`✅ Found ${matches.length} suitable drivers for passenger ${passengerData.userId}`);
  } catch (error) {
    console.error('❌ Error in simplified driver search:', error);
  }

  return matches.sort((a, b) => b.similarity - a.similarity);
}

// FIXED: Simplified passenger search to avoid composite index requirements
async function findPassengersForDriverSimplified(db, driverData, routeHash, rideType) {
  const matches = [];

  try {
    console.log(`🔍 Simplified search for driver: ${driverData.userId}`);
    
    // Step 1: Get all active passengers first (simple query)
    let passengersQuery = db.collection('active_searches')
      .where('isActive', '==', true)
      .where('userType', '==', 'passenger');

    const passengersSnapshot = await passengersQuery.limit(50).get(); // Increased limit for manual filtering

    console.log(`📊 Found ${passengersSnapshot.size} active passengers, filtering manually...`);

    for (const passengerDoc of passengersSnapshot.docs) {
      const passengerData = passengerDoc.data();

      // Manual filtering for search type
      const passengerSearchType = rideType === 'immediate' ? 'real_time' : 'scheduled';
      if (passengerData.searchType !== passengerSearchType) {
        continue;
      }

      // Manual filtering for capacity
      const availableSeats = driverData.capacity - (driverData.currentPassengers || 0);
      if ((passengerData.passengerCount || 1) > availableSeats) {
        continue;
      }

      // Manual filtering for scheduled time
      if (rideType === 'scheduled' && driverData.scheduledTime) {
        if (!passengerData.scheduledTime) continue;
        
        const driverTime = new Date(driverData.scheduledTime);
        const passengerTime = new Date(passengerData.scheduledTime);
        const flexibility = driverData.flexibility || 15; // minutes
        const timeDiff = Math.abs(passengerTime - driverTime) / (1000 * 60); // minutes
        
        if (timeDiff > flexibility) {
          continue;
        }
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
          matchId: `match_${Date.now()}_${driverData.userId}_${passengerDoc.id}`,
          driverId: driverData.userId,
          passengerId: passengerData.userId || passengerData.passengerId || passengerDoc.id,
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
          status: 'proposed',
          rideType: rideType
        });
      }
    }

    console.log(`✅ Found ${matches.length} suitable passengers for driver ${driverData.userId}`);
  } catch (error) {
    console.error('❌ Error in simplified passenger search:', error);
  }

  return matches.sort((a, b) => b.similarity - a.similarity);
}

// FIXED: Alternative optimized search with single-field queries
async function findDriversForPassengerOptimized(db, passengerData, routeHash, rideType) {
  const matches = [];

  try {
    console.log(`🔍 Optimized search for passenger: ${passengerData.userId}`);
    
    // Query by single field first, then filter manually
    const driversSnapshot = await db.collection('active_searches')
      .where('isActive', '==', true)
      .limit(100) // Increased limit
      .get();

    const matchingDrivers = [];
    
    driversSnapshot.forEach(doc => {
      const driverData = doc.data();
      
      // Manual filtering for all conditions
      if (driverData.userType === 'driver' &&
          driverData.searchType === (rideType === 'immediate' ? 'real_time' : 'scheduled') &&
          driverData.passengerCapacity >= (passengerData.passengerCount || 1)) {
        
        // Additional filtering for scheduled rides
        if (rideType === 'scheduled' && passengerData.scheduledTime && driverData.scheduledTime) {
          const passengerTime = new Date(passengerData.scheduledTime);
          const driverTime = new Date(driverData.scheduledTime);
          const timeDiff = Math.abs(driverTime - passengerTime) / (1000 * 60);
          
          if (timeDiff > (passengerData.flexibility || 15)) {
            return;
          }
        }

        // Check available capacity
        const availableSeats = driverData.passengerCapacity - (driverData.currentPassengers || 0);
        if (availableSeats >= (passengerData.passengerCount || 1)) {
          matchingDrivers.push({
            driverData: driverData,
            documentId: doc.id
          });
        }
      }
    });

    console.log(`📊 After initial filtering: ${matchingDrivers.length} drivers`);

    // Now calculate route similarity for filtered drivers
    for (const { driverData, documentId } of matchingDrivers) {
      const passengerRoute = passengerData.routePoints || [
        passengerData.pickupLocation, 
        passengerData.destinationLocation
      ];
      
      const driverRoute = driverData.routePoints || [
        driverData.pickupLocation, 
        driverData.destinationLocation
      ];

      const similarity = calculateRouteSimilarity(passengerRoute, driverRoute);

      const pickupAlongRoute = isLocationAlongRoute(
        passengerData.pickupLocation,
        driverRoute,
        passengerData.maxWalkDistance || 0.5
      );

      const dropoffAlongRoute = isLocationAlongRoute(
        passengerData.destinationLocation,
        driverRoute,
        passengerData.maxWalkDistance || 0.5
      );

      const similarityThreshold = rideType === 'immediate' ? 0.6 : 0.7;

      if (similarity >= similarityThreshold && pickupAlongRoute && dropoffAlongRoute) {
        matches.push({
          matchId: `match_${Date.now()}_${documentId}_${passengerData.userId}`,
          driverId: driverData.driverId || driverData.userId || documentId,
          passengerId: passengerData.userId,
          similarity: similarity,
          driverData: { ...driverData, documentId },
          passengerData: passengerData,
          pickupLocation: passengerData.pickupLocation,
          destinationLocation: passengerData.destinationLocation,
          proposedFare: calculateProposedFare(driverData, passengerData),
          scheduledTime: passengerData.scheduledTime || driverData.scheduledTime,
          timestamp: new Date(),
          status: 'proposed',
          rideType: rideType
        });
      }
    }

    console.log(`✅ Found ${matches.length} optimized matches for passenger`);
  } catch (error) {
    console.error('❌ Error in optimized driver search:', error);
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

// FIXED: Get user's active matches with proper query
router.get("/user-matches/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { status = 'proposed', limit = 10 } = req.query;

    console.log(`📋 Getting matches for user: ${userId} with status: ${status}`);

    // FIXED: Use separate queries instead of $or which may require indexes
    const driverMatchesQuery = await db.collection('match_proposals')
      .where('status', '==', status)
      .where('driverId', '==', userId)
      .orderBy('timestamp', 'desc')
      .limit(parseInt(limit))
      .get();

    const passengerMatchesQuery = await db.collection('match_proposals')
      .where('status', '==', status)
      .where('passengerId', '==', userId)
      .orderBy('timestamp', 'desc')
      .limit(parseInt(limit))
      .get();

    const driverMatches = driverMatchesQuery.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    const passengerMatches = passengerMatchesQuery.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    // Combine and sort by timestamp
    const allMatches = [...driverMatches, ...passengerMatches]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, parseInt(limit));

    res.json({
      success: true,
      matches: allMatches,
      total: allMatches.length
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

// Emergency fallback search endpoint
router.post("/search-fallback", async (req, res) => {
  try {
    const userData = req.body;
    const { userId, userType } = userData;

    console.log(`🔄 Using fallback search for: ${userType} ${userId}`);

    // Simple fallback - return empty matches but success response
    res.json({
      success: true,
      matches: [],
      totalMatches: 0,
      searchId: `fallback_${Date.now()}_${userId}`,
      userType: userType,
      message: 'Using fallback search mode while system optimizes'
    });

  } catch (error) {
    console.error('❌ Error in fallback search:', error);
    res.json({
      success: true,
      matches: [],
      totalMatches: 0,
      searchId: `error_${Date.now()}`,
      message: 'Search temporarily unavailable'
    });
  }
});

module.exports = router;
