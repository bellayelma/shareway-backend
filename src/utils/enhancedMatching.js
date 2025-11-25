// utils/enhancedMatching.js
const { calculateRouteSimilarity, isLocationAlongRoute, hasCapacity } = require("./routeMatching");

// Enhanced matching logic
const performMatching = async (db, searchData) => {
  try {
    console.log('🔍 Starting enhanced matching for:', {
      userId: searchData.userId,
      userType: searchData.userType,
      rideType: searchData.rideType
    });

    let matches = [];

    if (searchData.userType === 'passenger') {
      matches = await findMatchingDrivers(db, searchData);
    } else if (searchData.userType === 'driver') {
      matches = await findMatchingPassengers(db, searchData);
    }

    // Create match proposals
    const matchProposals = await createMatchProposals(db, matches, searchData.rideType);
    
    console.log(`✅ Matching completed: ${matchProposals.length} proposals created`);
    return matchProposals;

  } catch (error) {
    console.error('❌ Error in enhanced matching:', error);
    return [];
  }
};

// Find matching drivers for a passenger
async function findMatchingDrivers(db, passengerData) {
  const matches = [];
  
  try {
    console.log(`👤 Finding drivers for passenger: ${passengerData.passengerName || passengerData.userId}`);
    
    // Get all active driver searches
    const driversSnapshot = await db.collection('active_searches')
      .where('userType', '==', 'driver')
      .where('isActive', '==', true)
      .limit(50)
      .get();

    console.log(`📊 Found ${driversSnapshot.size} active drivers`);

    for (const driverDoc of driversSnapshot.docs) {
      const driverData = driverDoc.data();
      
      // Skip if driver data is incomplete
      if (!driverData.driverId || !driverData.pickupLocation) {
        continue;
      }

      // Check ride type compatibility
      if (!isRideTypeCompatible(passengerData.rideType, driverData.searchType)) {
        continue;
      }

      // Check capacity
      const passengerCount = passengerData.passengerCount || 1;
      if (!hasCapacity(driverData, passengerCount)) {
        continue;
      }

      // Check scheduled time for scheduled rides
      if (passengerData.rideType === 'scheduled') {
        if (!isTimeCompatible(passengerData.scheduledTime, driverData.scheduledTime)) {
          continue;
        }
      }

      // Calculate route similarity
      const similarity = calculateRouteSimilarity(
        passengerData.routePoints || [passengerData.pickupLocation, passengerData.destinationLocation],
        driverData.routePoints || [driverData.pickupLocation, driverData.destinationLocation]
      );

      // Check if pickup and destination are along driver's route
      const pickupAlongRoute = isLocationAlongRoute(
        passengerData.pickupLocation,
        driverData.routePoints || [driverData.pickupLocation, driverData.destinationLocation],
        passengerData.maxWalkDistance || 0.5
      );

      const dropoffAlongRoute = isLocationAlongRoute(
        passengerData.destinationLocation,
        driverData.routePoints || [driverData.pickupLocation, driverData.destinationLocation],
        passengerData.maxWalkDistance || 0.5
      );

      // Set similarity threshold based on ride type
      const similarityThreshold = passengerData.rideType === 'immediate' ? 0.6 : 0.7;

      if (similarity >= similarityThreshold && pickupAlongRoute && dropoffAlongRoute) {
        const matchScore = calculateMatchScore(similarity, passengerData, driverData);
        
        matches.push({
          matchId: `match_${Date.now()}_${driverData.driverId}_${passengerData.userId}`,
          driverId: driverData.driverId,
          passengerId: passengerData.userId,
          similarity: similarity,
          matchScore: matchScore,
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
          rideType: passengerData.rideType
        });
      }
    }

    console.log(`✅ Found ${matches.length} matching drivers`);
    return matches.sort((a, b) => b.matchScore - a.matchScore);

  } catch (error) {
    console.error('❌ Error finding matching drivers:', error);
    return [];
  }
}

// Find matching passengers for a driver
async function findMatchingPassengers(db, driverData) {
  const matches = [];
  
  try {
    console.log(`🚗 Finding passengers for driver: ${driverData.driverName || driverData.userId}`);
    
    // Get all active passenger searches
    const passengersSnapshot = await db.collection('active_searches')
      .where('userType', '==', 'passenger')
      .where('isActive', '==', true)
      .limit(50)
      .get();

    console.log(`📊 Found ${passengersSnapshot.size} active passengers`);

    for (const passengerDoc of passengersSnapshot.docs) {
      const passengerData = passengerDoc.data();
      
      // Skip if passenger data is incomplete
      if (!passengerData.userId || !passengerData.pickupLocation) {
        continue;
      }

      // Check ride type compatibility
      if (!isRideTypeCompatible(passengerData.rideType, driverData.searchType)) {
        continue;
      }

      // Check capacity
      const passengerCount = passengerData.passengerCount || 1;
      if (!hasCapacity(driverData, passengerCount)) {
        continue;
      }

      // Check scheduled time for scheduled rides
      if (driverData.rideType === 'scheduled') {
        if (!isTimeCompatible(driverData.scheduledTime, passengerData.scheduledTime)) {
          continue;
        }
      }

      // Calculate route similarity
      const similarity = calculateRouteSimilarity(
        passengerData.routePoints || [passengerData.pickupLocation, passengerData.destinationLocation],
        driverData.routePoints || [driverData.pickupLocation, driverData.destinationLocation]
      );

      // Check if pickup and destination are along driver's route
      const pickupAlongRoute = isLocationAlongRoute(
        passengerData.pickupLocation,
        driverData.routePoints || [driverData.pickupLocation, driverData.destinationLocation],
        passengerData.maxWalkDistance || 0.5
      );

      const dropoffAlongRoute = isLocationAlongRoute(
        passengerData.destinationLocation,
        driverData.routePoints || [driverData.pickupLocation, driverData.destinationLocation],
        passengerData.maxWalkDistance || 0.5
      );

      // Set similarity threshold based on ride type
      const similarityThreshold = driverData.rideType === 'immediate' ? 0.6 : 0.7;

      if (similarity >= similarityThreshold && pickupAlongRoute && dropoffAlongRoute) {
        const matchScore = calculateMatchScore(similarity, passengerData, driverData);
        
        matches.push({
          matchId: `match_${Date.now()}_${driverData.userId}_${passengerData.userId}`,
          driverId: driverData.userId,
          passengerId: passengerData.userId,
          similarity: similarity,
          matchScore: matchScore,
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
          rideType: driverData.rideType
        });
      }
    }

    console.log(`✅ Found ${matches.length} matching passengers`);
    return matches.sort((a, b) => b.matchScore - a.matchScore);

  } catch (error) {
    console.error('❌ Error finding matching passengers:', error);
    return [];
  }
}

// Check ride type compatibility
function isRideTypeCompatible(passengerRideType, driverSearchType) {
  if (passengerRideType === 'immediate' && driverSearchType === 'real_time') {
    return true;
  }
  if (passengerRideType === 'scheduled' && driverSearchType === 'scheduled') {
    return true;
  }
  return false;
}

// Check time compatibility for scheduled rides
function isTimeCompatible(time1, time2, flexibility = 15) {
  if (!time1 || !time2) return false;
  
  try {
    const date1 = new Date(time1);
    const date2 = new Date(time2);
    const timeDiff = Math.abs(date1 - date2) / (1000 * 60); // difference in minutes
    
    return timeDiff <= flexibility;
  } catch (error) {
    console.error('Error comparing times:', error);
    return false;
  }
}

// Calculate comprehensive match score
function calculateMatchScore(similarity, passengerData, driverData) {
  let score = similarity * 70; // Base score from route similarity

  // Capacity match bonus
  const availableSeats = (driverData.passengerCapacity || driverData.capacity || 4) - (driverData.currentPassengers || 0);
  const passengerCount = passengerData.passengerCount || 1;
  
  if (availableSeats >= passengerCount) {
    score += 15;
  }

  // Fare compatibility bonus
  const driverFare = driverData.estimatedFare;
  const passengerFare = passengerData.estimatedFare;
  
  if (driverFare && passengerFare) {
    const fareDiff = Math.abs(driverFare - passengerFare) / Math.max(driverFare, passengerFare);
    if (fareDiff <= 0.2) {
      score += 10;
    }
  }

  // Vehicle type preference match
  const preferredVehicle = passengerData.preferredVehicleType;
  const driverVehicle = driverData.vehicleInfo?.type || driverData.preferredVehicleType;
  
  if (preferredVehicle && driverVehicle && preferredVehicle === driverVehicle) {
    score += 5;
  }

  return Math.min(100, Math.max(0, score));
}

// Calculate proposed fare
function calculateProposedFare(driverData, passengerData) {
  const baseFare = 50;
  const perKmRate = 15;
  const perMinuteRate = 2;
  
  // Use provided data or defaults
  const distance = driverData.distance || passengerData.distance || 5;
  const duration = driverData.duration || passengerData.duration || 15;
  const passengerCount = passengerData.passengerCount || 1;
  
  let fare = baseFare + (distance * perKmRate) + (duration * perMinuteRate);
  
  // Adjust for multiple passengers
  if (passengerCount > 1) {
    fare *= (1 + (passengerCount - 1) * 0.2);
  }
  
  // Consider both estimates if available
  const driverEstimate = driverData.estimatedFare;
  const passengerEstimate = passengerData.estimatedFare;
  
  if (driverEstimate && passengerEstimate) {
    fare = (fare + driverEstimate + passengerEstimate) / 3;
  } else if (driverEstimate) {
    fare = (fare + driverEstimate) / 2;
  } else if (passengerEstimate) {
    fare = (fare + passengerEstimate) / 2;
  }
  
  return Math.round(fare);
}

// Create match proposals in database
async function createMatchProposals(db, matches, rideType) {
  const proposals = [];
  
  try {
    for (const match of matches.slice(0, 5)) { // Limit to top 5 matches
      const proposalData = {
        matchId: match.matchId,
        driverId: match.driverId,
        passengerId: match.passengerId,
        similarity: match.similarity,
        matchScore: match.matchScore,
        status: 'proposed',
        rideType: rideType,
        
        // Location information
        pickupLocation: match.pickupLocation,
        destinationLocation: match.destinationLocation,
        pickupName: match.passengerData.pickupName || 'Pickup Location',
        destinationName: match.passengerData.destinationName || 'Destination Location',
        
        // Fare and pricing
        proposedFare: match.proposedFare,
        
        // Passenger information
        passengerCount: match.passengerData.passengerCount || 1,
        passengerName: match.passengerData.passengerName || 'Passenger',
        passengerPhone: match.passengerData.passengerPhone || '',
        
        // Driver information
        driverName: match.driverData.driverName || 'Driver',
        driverPhone: match.driverData.driverPhone || '',
        vehicleInfo: match.driverData.vehicleInfo || {},
        
        // Route information
        distance: match.driverData.distance || match.passengerData.distance || 0,
        duration: match.driverData.duration || match.passengerData.duration || 0,
        
        // Scheduling
        scheduledTime: match.scheduledTime,
        
        // Timestamps
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 5 * 60000), // 5 minutes
        updatedAt: new Date()
      };

      // Save to match_proposals collection
      await db.collection('match_proposals').doc(match.matchId).set(proposalData);
      proposals.push(proposalData);
      
      console.log(`✅ Created match proposal: ${match.matchId} with score: ${Math.round(match.matchScore)}%`);
    }
    
    return proposals;
    
  } catch (error) {
    console.error('❌ Error creating match proposals:', error);
    return proposals;
  }
}

module.exports = { performMatching };
