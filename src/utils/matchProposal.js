// utils/matchProposal.js
const admin = require('firebase-admin');

// Create match proposal - UPDATED to match Flutter structure
const createMatchProposal = async (db, match, rideType) => {
  try {
    const matchId = `match_${match.driverId}_${match.passengerId}_${Date.now()}`;
    
    // Calculate match score based on similarity and other factors
    const matchScore = calculateMatchScore(match);
    
    const matchData = {
      // Match identification
      matchId: matchId,
      driverId: match.driverId,
      passengerId: match.passengerId,
      
      // Match details
      similarity: match.similarity,
      matchScore: matchScore,
      status: 'proposed',
      rideType: rideType,
      
      // Location information
      pickupLocation: match.pickupLocation,
      destinationLocation: match.destinationLocation,
      pickupName: match.passengerData?.pickupName || 'Pickup Location',
      destinationName: match.passengerData?.destinationName || 'Destination Location',
      
      // Fare and pricing
      proposedFare: match.proposedFare || calculateProposedFare(match),
      baseFare: 50,
      distanceFare: (match.driverData?.distance || 5) * 15,
      timeFare: (match.driverData?.duration || 15) * 2,
      
      // Passenger information
      passengerCount: match.passengerData?.passengerCount || 1,
      passengerName: match.passengerData?.passengerName || 'Passenger',
      passengerPhone: match.passengerData?.passengerPhone || '',
      passengerPhotoUrl: match.passengerData?.passengerPhotoUrl || '',
      
      // Driver information
      driverName: match.driverData?.driverName || 'Driver',
      driverPhone: match.driverData?.driverPhone || '',
      driverPhotoUrl: match.driverData?.driverPhotoUrl || '',
      vehicleInfo: match.driverData?.vehicleInfo || {},
      
      // Route information
      distance: match.driverData?.distance || match.passengerData?.distance || 5,
      duration: match.driverData?.duration || match.passengerData?.duration || 15,
      routePoints: match.driverData?.routePoints || match.passengerData?.routePoints || [],
      
      // Scheduling
      scheduledTime: match.scheduledTime || null,
      estimatedPickupTime: calculateEstimatedPickupTime(match),
      
      // Response tracking
      driverResponse: null,
      passengerResponse: null,
      acceptedBy: null,
      rejectedBy: null,
      rejectionReason: null,
      
      // Timestamps
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      proposedAt: new Date(),
      expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 5 * 60000)), // 5 minutes
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    // Save to match_proposals collection
    await db.collection('match_proposals').doc(matchId).set(matchData);
    
    // Create notifications for both parties
    await createMatchNotifications(db, matchData);
    
    // Update user documents with match reference
    await updateUserMatchReferences(db, matchData);
    
    console.log(`✅ Match proposal created: ${matchId} with score: ${Math.round(matchScore)}%`);
    return matchData;
    
  } catch (error) {
    console.error('❌ Error creating match proposal:', error);
    throw error;
  }
};

// Calculate comprehensive match score
const calculateMatchScore = (match) => {
  let score = match.similarity * 70; // Base 70% from route similarity
  
  // Add points for capacity match
  const availableSeats = (match.driverData?.passengerCapacity || 4) - (match.driverData?.currentPassengers || 0);
  const passengerCount = match.passengerData?.passengerCount || 1;
  
  if (availableSeats >= passengerCount) {
    score += 15; // Good capacity match
  } else {
    score -= 10; // Capacity mismatch
  }
  
  // Add points for scheduling alignment
  if (match.scheduledTime) {
    const timeDiff = calculateTimeDifference(match);
    if (timeDiff <= 15) { // Within 15 minutes
      score += 10;
    } else if (timeDiff <= 30) { // Within 30 minutes
      score += 5;
    }
  } else {
    score += 5; // Immediate ride bonus
  }
  
  // Add points for fare compatibility
  const driverFare = match.driverData?.estimatedFare;
  const passengerFare = match.passengerData?.estimatedFare;
  
  if (driverFare && passengerFare) {
    const fareDiff = Math.abs(driverFare - passengerFare) / Math.max(driverFare, passengerFare);
    if (fareDiff <= 0.2) { // Within 20% fare difference
      score += 5;
    }
  }
  
  return Math.min(100, Math.max(0, score)); // Ensure score is between 0-100
};

// Calculate proposed fare
const calculateProposedFare = (match) => {
  const baseFare = 50;
  const perKmRate = 15;
  const perMinuteRate = 2;
  
  const distance = match.driverData?.distance || match.passengerData?.distance || 5;
  const duration = match.driverData?.duration || match.passengerData?.duration || 15;
  const passengerCount = match.passengerData?.passengerCount || 1;
  
  let fare = baseFare + (distance * perKmRate) + (duration * perMinuteRate);
  
  // Adjust for multiple passengers
  if (passengerCount > 1) {
    fare *= (1 + (passengerCount - 1) * 0.2); // 20% increase per additional passenger
  }
  
  // Consider driver and passenger estimates
  const driverEstimate = match.driverData?.estimatedFare;
  const passengerEstimate = match.passengerData?.estimatedFare;
  
  if (driverEstimate && passengerEstimate) {
    fare = (fare + driverEstimate + passengerEstimate) / 3;
  } else if (driverEstimate) {
    fare = (fare + driverEstimate) / 2;
  } else if (passengerEstimate) {
    fare = (fare + passengerEstimate) / 2;
  }
  
  return Math.round(fare);
};

// Calculate estimated pickup time
const calculateEstimatedPickupTime = (match) => {
  const now = new Date();
  const baseWaitTime = 5; // 5 minutes base wait time
  
  // For scheduled rides, use scheduled time
  if (match.scheduledTime) {
    return new Date(match.scheduledTime);
  }
  
  // For immediate rides, calculate based on distance and traffic
  const driverToPickupDistance = calculateDistance(
    match.driverData?.currentLocation?.lat || match.driverData?.pickupLocation?.lat,
    match.driverData?.currentLocation?.lng || match.driverData?.pickupLocation?.lng,
    match.pickupLocation.lat,
    match.pickupLocation.lng
  );
  
  const estimatedTravelTime = (driverToPickupDistance / 40) * 60; // Assuming 40 km/h average speed
  
  return new Date(now.getTime() + (baseWaitTime + estimatedTravelTime) * 60000);
};

// Calculate time difference for scheduled rides
const calculateTimeDifference = (match) => {
  if (!match.scheduledTime) return 0;
  
  const driverTime = new Date(match.driverData?.scheduledTime);
  const passengerTime = new Date(match.passengerData?.scheduledTime);
  
  if (!isNaN(driverTime.getTime()) && !isNaN(passengerTime.getTime())) {
    return Math.abs(driverTime.getTime() - passengerTime.getTime()) / (1000 * 60); // Difference in minutes
  }
  
  return 0;
};

// Create notifications for both driver and passenger
const createMatchNotifications = async (db, matchData) => {
  try {
    const notifications = [];
    
    // Driver notification
    notifications.push({
      userId: matchData.driverId,
      userType: 'driver',
      type: 'match_proposed',
      title: matchData.rideType === 'immediate' ? '🚗 New Ride Match!' : '📅 New Scheduled Ride Match',
      body: `Found ${matchData.passengerCount} passenger${matchData.passengerCount > 1 ? 's' : ''} with ${Math.round(matchData.matchScore)}% match score`,
      data: {
        matchId: matchData.matchId,
        passengerId: matchData.passengerId,
        passengerName: matchData.passengerName,
        passengerCount: matchData.passengerCount,
        proposedFare: matchData.proposedFare,
        pickupLocation: matchData.pickupLocation,
        rideType: matchData.rideType,
        matchScore: matchData.matchScore
      },
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: matchData.expiresAt
    });
    
    // Passenger notification
    notifications.push({
      userId: matchData.passengerId,
      userType: 'passenger',
      type: 'match_proposed',
      title: matchData.rideType === 'immediate' ? '🚗 Driver Found!' : '📅 Scheduled Driver Found',
      body: `Found a driver with ${Math.round(matchData.matchScore)}% match score - ETD: ${formatTime(matchData.estimatedPickupTime)}`,
      data: {
        matchId: matchData.matchId,
        driverId: matchData.driverId,
        driverName: matchData.driverName,
        vehicleInfo: matchData.vehicleInfo,
        proposedFare: matchData.proposedFare,
        estimatedPickupTime: matchData.estimatedPickupTime,
        rideType: matchData.rideType,
        matchScore: matchData.matchScore
      },
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: matchData.expiresAt
    });
    
    // Save notifications
    const batch = db.batch();
    notifications.forEach(notification => {
      const notificationRef = db.collection('notifications').doc();
      batch.set(notificationRef, notification);
    });
    await batch.commit();
    
    console.log(`📢 Notifications created for match: ${matchData.matchId}`);
    
  } catch (error) {
    console.error('❌ Error creating match notifications:', error);
    // Don't throw error - notifications are secondary
  }
};

// Update user documents with match references
const updateUserMatchReferences = async (db, matchData) => {
  try {
    const batch = db.batch();
    
    // Update driver document
    const driverQuery = await db.collection('drivers')
      .where('driverId', '==', matchData.driverId)
      .limit(1)
      .get();
    
    if (!driverQuery.empty) {
      const driverDoc = driverQuery.docs[0];
      batch.update(driverDoc.ref, {
        currentMatchId: matchData.matchId,
        pendingMatches: admin.firestore.FieldValue.arrayUnion(matchData.matchId),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    
    // Update passenger document
    const passengerQuery = await db.collection('passengers')
      .where('passengerId', '==', matchData.passengerId)
      .limit(1)
      .get();
    
    if (!passengerQuery.empty) {
      const passengerDoc = passengerQuery.docs[0];
      batch.update(passengerDoc.ref, {
        currentMatchId: matchData.matchId,
        pendingMatches: admin.firestore.FieldValue.arrayUnion(matchData.matchId),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    
    await batch.commit();
    
    console.log(`✅ User documents updated for match: ${matchData.matchId}`);
    
  } catch (error) {
    console.error('❌ Error updating user match references:', error);
    // Don't throw error - user updates are secondary
  }
};

// Update match status
const updateMatchStatus = async (db, matchId, updates) => {
  try {
    const matchRef = db.collection('match_proposals').doc(matchId);
    
    await matchRef.update({
      ...updates,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`✅ Match ${matchId} status updated:`, updates.status);
    
    // If match is accepted, create ride session
    if (updates.status === 'accepted') {
      await createRideSession(db, matchId);
    }
    
  } catch (error) {
    console.error('❌ Error updating match status:', error);
    throw error;
  }
};

// Create ride session when match is accepted
const createRideSession = async (db, matchId) => {
  try {
    const matchDoc = await db.collection('match_proposals').doc(matchId).get();
    
    if (!matchDoc.exists) {
      throw new Error('Match not found');
    }
    
    const matchData = matchDoc.data();
    
    const rideSession = {
      rideId: `ride_${matchId}`,
      matchId: matchId,
      driverId: matchData.driverId,
      passengerId: matchData.passengerId,
      
      // Ride details
      status: 'accepted',
      rideType: matchData.rideType,
      passengerCount: matchData.passengerCount,
      proposedFare: matchData.proposedFare,
      
      // Location information
      pickupLocation: matchData.pickupLocation,
      destinationLocation: matchData.destinationLocation,
      pickupName: matchData.pickupName,
      destinationName: matchData.destinationName,
      
      // User information
      driverName: matchData.driverName,
      driverPhone: matchData.driverPhone,
      passengerName: matchData.passengerName,
      passengerPhone: matchData.passengerPhone,
      
      // Vehicle information
      vehicleInfo: matchData.vehicleInfo,
      
      // Timing information
      scheduledTime: matchData.scheduledTime,
      estimatedPickupTime: matchData.estimatedPickupTime,
      acceptedAt: new Date(),
      
      // Timestamps
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    await db.collection('active_rides').doc(rideSession.rideId).set(rideSession);
    
    console.log(`✅ Ride session created: ${rideSession.rideId}`);
    
    // Send acceptance notifications
    await createAcceptanceNotifications(db, rideSession);
    
  } catch (error) {
    console.error('❌ Error creating ride session:', error);
    throw error;
  }
};

// Create notifications for match acceptance
const createAcceptanceNotifications = async (db, rideSession) => {
  try {
    const notifications = [];
    
    // Driver notification
    notifications.push({
      userId: rideSession.driverId,
      userType: 'driver',
      type: 'ride_accepted',
      title: '✅ Ride Accepted!',
      body: `${rideSession.passengerName} accepted your ride offer`,
      data: {
        rideId: rideSession.rideId,
        passengerId: rideSession.passengerId,
        passengerName: rideSession.passengerName,
        pickupLocation: rideSession.pickupLocation,
        proposedFare: rideSession.proposedFare
      },
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Passenger notification
    notifications.push({
      userId: rideSession.passengerId,
      userType: 'passenger',
      type: 'ride_accepted',
      title: '✅ Driver Confirmed!',
      body: `${rideSession.driverName} confirmed your ride request`,
      data: {
        rideId: rideSession.rideId,
        driverId: rideSession.driverId,
        driverName: rideSession.driverName,
        vehicleInfo: rideSession.vehicleInfo,
        estimatedPickupTime: rideSession.estimatedPickupTime
      },
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Save notifications
    const batch = db.batch();
    notifications.forEach(notification => {
      const notificationRef = db.collection('notifications').doc();
      batch.set(notificationRef, notification);
    });
    await batch.commit();
    
    console.log(`📢 Acceptance notifications sent for ride: ${rideSession.rideId}`);
    
  } catch (error) {
    console.error('❌ Error creating acceptance notifications:', error);
    // Don't throw error - notifications are secondary
  }
};

// Helper function to calculate distance between two points
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

// Helper function to format time
const formatTime = (date) => {
  if (!date) return 'Unknown';
  
  const time = new Date(date);
  return time.toLocaleTimeString('en-US', { 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: true 
  });
};

module.exports = {
  createMatchProposal,
  updateMatchStatus,
  calculateMatchScore,
  calculateProposedFare
};
