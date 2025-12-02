// utils/routeMatching.js - COMPLETE SCRIPT WITH DYNAMIC ROUTE UPDATING
const admin = require('firebase-admin');

// TEST MODE - Set to true for immediate testing
const TEST_MODE = true;

// Matching session management
const activeMatchingSessions = new Map();
const MATCHING_DURATION = 5 * 60 * 1000; // 5 minutes

// Duplicate prevention cache
const matchCooldown = new Map();
const COOLDOWN_PERIOD = 2 * 60 * 1000; // 2 minutes cooldown

// Firestore Collection Names - SYMMETRICAL for both drivers AND passengers
const COLLECTIONS = {
  ACTIVE_SEARCHES: 'active_searches', // ✅ GENERIC for both drivers AND passengers
  DRIVER_SCHEDULES: 'driver_schedules',
  ACTIVE_MATCHES: 'active_matches',
  LOCATION_HISTORY: 'location_history',
  NOTIFICATIONS: 'notifications'
};

// ========== DYNAMIC ROUTE UPDATING FUNCTIONS ==========

// 🎯 NEW: Update user's route dynamically based on current location
const updateUserRouteWithCurrentLocation = async (db, userId, userType, currentLocation) => {
  try {
    console.log(`🔄 Updating ${userType} route with current location: ${userId}`);
    
    // 1. Get the current search document
    const activeSearchQuery = await db.collection(COLLECTIONS.ACTIVE_SEARCHES)
      .where('userId', '==', userId)
      .where('userType', '==', userType)
      .where('isSearching', '==', true)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    
    if (activeSearchQuery.empty) {
      console.log(`⚠️ No active search found for ${userType}: ${userId}`);
      return null;
    }
    
    const searchDoc = activeSearchQuery.docs[0];
    const searchData = searchDoc.data();
    
    // 2. Extract the remaining route points (points ahead of current location)
    const originalRoutePoints = searchData.routePoints || [];
    
    if (originalRoutePoints.length === 0) {
      console.log(`⚠️ No route points found for ${userType}: ${userId}`);
      return null;
    }
    
    // 3. Find the closest point in the route to current location
    let closestIndex = 0;
    let minDistance = Infinity;
    
    for (let i = 0; i < originalRoutePoints.length; i++) {
      const point = originalRoutePoints[i];
      const distance = calculateHaversineDistance(
        currentLocation.latitude,
        currentLocation.longitude,
        point.lat,
        point.lng
      );
      
      if (distance < minDistance) {
        minDistance = distance;
        closestIndex = i;
      }
    }
    
    console.log(`📍 Current position closest to route point ${closestIndex}`);
    console.log(`   Distance to closest point: ${minDistance.toFixed(2)}km`);
    
    // 4. Create NEW route starting from current position
    const updatedRoutePoints = originalRoutePoints.slice(closestIndex);
    
    // Add current location as the FIRST point if we're not exactly on a route point
    if (minDistance > 0.001) { // More than 100 meters away from route point
      updatedRoutePoints.unshift({
        lat: currentLocation.latitude,
        lng: currentLocation.longitude
      });
      console.log(`   Added current location as new route point 0`);
    }
    
    // 5. Calculate updated distance and duration (simplified)
    const originalDistance = searchData.distance || 0;
    const originalDuration = searchData.duration || 0;
    
    // Reduce distance/duration proportionally based on progress
    const progress = closestIndex / originalRoutePoints.length;
    const updatedDistance = originalDistance * (1 - progress);
    const updatedDuration = originalDuration * (1 - progress);
    
    // 6. Update Firestore document with DYNAMIC route
    const timestamp = admin.firestore.FieldValue.serverTimestamp();
    
    await searchDoc.ref.update({
      // 🎯 UPDATED ROUTE DATA
      routePoints: updatedRoutePoints,
      
      // 🎯 UPDATED PICKUP LOCATION (current position becomes new pickup)
      pickupLocation: {
        lat: currentLocation.latitude,
        lng: currentLocation.longitude
      },
      
      // 🎯 UPDATED PICKUP NAME (adds "Current Location")
      pickupName: `Current Location (${searchData.pickupName})`,
      
      // 🎯 UPDATED DISTANCE AND DURATION
      distance: Math.round(updatedDistance * 10) / 10,
      duration: Math.round(updatedDuration * 10) / 10,
      
      // 🎯 CURRENT LOCATION (already updated by updateUserLocation)
      currentLocation: {
        latitude: currentLocation.latitude,
        longitude: currentLocation.longitude,
        accuracy: currentLocation.accuracy || 0,
        heading: currentLocation.heading || 0,
        speed: currentLocation.speed || 0,
        timestamp: timestamp
      },
      
      // 🎯 ROUTE PROGRESS TRACKING
      routeProgress: {
        originalPoints: originalRoutePoints.length,
        currentIndex: closestIndex,
        remainingPoints: updatedRoutePoints.length,
        progressPercentage: Math.round(progress * 100),
        distanceTraveled: originalDistance * progress,
        distanceRemaining: updatedDistance
      },
      
      // 🎯 TIMESTAMPS
      locationUpdatedAt: timestamp,
      routeUpdatedAt: timestamp,
      lastUpdated: timestamp
    });
    
    console.log(`✅ DYNAMIC ROUTE UPDATED for ${userType}: ${userId}`);
    console.log(`   - Original route points: ${originalRoutePoints.length}`);
    console.log(`   - Updated route points: ${updatedRoutePoints.length}`);
    console.log(`   - Progress: ${Math.round(progress * 100)}% complete`);
    console.log(`   - Distance remaining: ${updatedDistance.toFixed(1)}km`);
    console.log(`   - Pickup location updated to current position`);
    
    // Return updated search data
    const updatedSearch = {
      ...searchData,
      routePoints: updatedRoutePoints,
      pickupLocation: {
        lat: currentLocation.latitude,
        lng: currentLocation.longitude
      },
      distance: updatedDistance,
      duration: updatedDuration,
      currentLocation: {
        latitude: currentLocation.latitude,
        longitude: currentLocation.longitude,
        accuracy: currentLocation.accuracy || 0
      }
    };
    
    return updatedSearch;
    
  } catch (error) {
    console.error('❌ Error updating user route with current location:', error);
    return null;
  }
};

// ========== SYMMETRICAL FIRESTORE INTEGRATION FUNCTIONS ==========

// 🎯 SYMMETRICAL: Save active search for ANY user (driver OR passenger)
const saveActiveSearch = async (db, searchData) => {
  try {
    const userId = searchData.userId || searchData.driverId || searchData.passengerId;
    const userType = searchData.userType || (searchData.driverId ? 'driver' : 'passenger');
    
    if (!userId) {
      console.error('❌ No userId provided for saving active search');
      return null;
    }

    // Create document ID based on userType + userId
    const docId = `active_search_${userType}_${userId}_${Date.now()}`;
    
    const searchDoc = {
      userId: userId,
      userType: userType,
      
      // ✅ USER PROFILE DATA (same for both)
      name: userType === 'driver' ? 
        (searchData.driverName || 'Unknown Driver') : 
        (searchData.passengerName || 'Unknown Passenger'),
      phone: searchData.phone || searchData.driverPhone || '',
      photoUrl: searchData.photoUrl || searchData.driverPhotoUrl || '',
      rating: searchData.rating || searchData.driverRating || 5.0,
      totalRides: searchData.totalRides || 0,
      isVerified: searchData.isVerified || false,
      
      // ✅ VEHICLE INFO (only for drivers)
      vehicleInfo: userType === 'driver' ? (searchData.vehicleInfo || {}) : null,
      capacity: userType === 'driver' ? (searchData.capacity || 4) : 1,
      vehicleType: userType === 'driver' ? (searchData.vehicleType || 'car') : null,
      
      // ✅ ROUTE INFO (same for both)
      pickupLocation: searchData.pickupLocation,
      destinationLocation: searchData.destinationLocation,
      pickupName: searchData.pickupName || 'Unknown Pickup',
      destinationName: searchData.destinationName || 'Unknown Destination',
      routePoints: searchData.routePoints || [],
      distance: searchData.distance || 0,
      duration: searchData.duration || 0,
      
      // ✅ REAL-TIME LOCATION TRACKING (same for both)
      currentLocation: searchData.currentLocation || null,
      locationUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      
      // ✅ SEARCH METADATA (same for both)
      searchId: searchData.searchId || docId,
      rideType: searchData.rideType || 'immediate',
      scheduledTime: searchData.scheduledTime ? 
        admin.firestore.Timestamp.fromDate(new Date(searchData.scheduledTime)) : null,
      status: 'active',
      isSearching: true,
      isOnline: true,
      passengerCount: searchData.passengerCount || 1,
      matchesFound: searchData.matchesFound || 0,
      
      // ✅ SYSTEM DATA (same for both)
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromDate(
        new Date(Date.now() + 30 * 60 * 1000) // 30 minutes expiry
      )
    };

    // 🎯 SAVE TO GENERIC COLLECTION
    await db.collection(COLLECTIONS.ACTIVE_SEARCHES)
      .doc(docId)
      .set(searchDoc, { merge: true });
    
    console.log(`💾 Saved ${userType} active search to Firestore: ${searchDoc.name}`);
    console.log(`   - ${userType}: ${searchDoc.name}`);
    console.log(`   - Collection: ${COLLECTIONS.ACTIVE_SEARCHES}`);
    console.log(`   - Document ID: ${docId}`);
    
    return searchDoc;
    
  } catch (error) {
    console.error('❌ Error saving active search:', error);
    throw error;
  }
};

// 🎯 SYMMETRICAL: Update ANY user's location (driver OR passenger)
const updateUserLocation = async (db, userId, userType, locationData) => {
  try {
    console.log(`📍 Updating ${userType} location in Firestore: ${userId}`);
    
    const timestamp = admin.firestore.FieldValue.serverTimestamp();
    
    // 1. Update active_searches with current location
    const activeSearchesQuery = await db.collection(COLLECTIONS.ACTIVE_SEARCHES)
      .where('userId', '==', userId)
      .where('userType', '==', userType)
      .where('isSearching', '==', true)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    
    if (!activeSearchesQuery.empty) {
      const searchDoc = activeSearchesQuery.docs[0];
      await searchDoc.ref.update({
        currentLocation: {
          latitude: locationData.latitude,
          longitude: locationData.longitude,
          accuracy: locationData.accuracy || 0,
          heading: locationData.heading || 0,
          speed: locationData.speed || 0,
          timestamp: timestamp
        },
        locationUpdatedAt: timestamp,
        lastUpdated: timestamp
      });
      
      console.log(`✅ Updated location in active search for ${userType}: ${userId}`);
      
      // Return updated search data for immediate matching
      const updatedSearch = searchDoc.data();
      updatedSearch.currentLocation = {
        latitude: locationData.latitude,
        longitude: locationData.longitude,
        accuracy: locationData.accuracy || 0
      };
      
      return updatedSearch;
    }
    
    return null;
    
  } catch (error) {
    console.error('❌ Error updating user location:', error);
    return null;
  }
};

// 🎯 SYMMETRICAL: Get active searches by user type
const getActiveSearchesByType = async (db, userType, limit = 50) => {
  try {
    console.log(`🔍 Fetching active ${userType} searches from Firestore...`);
    
    const snapshot = await db.collection(COLLECTIONS.ACTIVE_SEARCHES)
      .where('userType', '==', userType)
      .where('isSearching', '==', true)
      .where('expiresAt', '>', admin.firestore.Timestamp.now())
      .orderBy('lastUpdated', 'desc')
      .limit(limit)
      .get();

    const activeSearches = [];
    snapshot.forEach(doc => {
      const searchData = doc.data();
      activeSearches.push({
        ...searchData,
        id: doc.id,
        firestoreDocId: doc.id,
        source: 'firestore_active'
      });
    });

    console.log(`📊 Found ${activeSearches.length} active ${userType} searches in Firestore`);
    
    // Log active users
    activeSearches.forEach(search => {
      const locationText = search.currentLocation ? 
        `📍 (${search.currentLocation.latitude.toFixed(4)}, ${search.currentLocation.longitude.toFixed(4)})` : 
        '📍 No location';
      console.log(`   - ${search.name} ${locationText} - Rating: ${search.rating || 5.0}`);
    });
    
    return activeSearches;
  } catch (error) {
    console.error(`❌ Error getting active ${userType} searches:`, error);
    return [];
  }
};

// 🎯 SYMMETRICAL: Process location update for ANY user WITH DYNAMIC ROUTE UPDATING
const processUserLocationUpdateAndMatch = async (db, userId, userType, locationData, websocketServer = null) => {
  try {
    console.log(`🎯 === PROCESSING ${userType.toUpperCase()} LOCATION UPDATE ===`);
    console.log(`📍 ${userType}: ${userId}`);
    console.log(`📌 Location: ${locationData.latitude}, ${locationData.longitude}`);
    
    // 1. Update user location in Firestore
    const updatedSearch = await updateUserLocation(db, userId, userType, locationData);
    
    if (!updatedSearch) {
      console.log(`⚠️ No active search found for ${userType}: ${userId}`);
      return null;
    }
    
    // 🎯 NEW: Update the route dynamically based on current location
    const updatedSearchWithDynamicRoute = await updateUserRouteWithCurrentLocation(
      db, 
      userId, 
      userType, 
      locationData
    );
    
    // Use the dynamically updated route for matching
    const searchToUse = updatedSearchWithDynamicRoute || updatedSearch;
    
    // 2. Get OPPOSITE user type searches
    const oppositeUserType = userType === 'driver' ? 'passenger' : 'driver';
    const oppositeSearches = await getActiveSearchesByType(db, oppositeUserType);
    
    if (oppositeSearches.length === 0) {
      console.log(`💤 No active ${oppositeUserType}s to match with`);
      return null;
    }
    
    console.log(`👥 Found ${oppositeSearches.length} active ${oppositeUserType}s to match with`);
    
    // 3. Perform immediate matching with current location
    let bestMatch = null;
    let highestScore = 0;
    
    for (const oppositeSearch of oppositeSearches) {
      if (!searchToUse.routePoints || searchToUse.routePoints.length === 0) continue;
      if (!oppositeSearch.routePoints || oppositeSearch.routePoints.length === 0) continue;
      
      // 🎯 SYMMETRICAL MATCHING: Always compare both routes
      const similarity = calculateRouteSimilarity(
        oppositeSearch.routePoints,
        searchToUse.routePoints, // Using DYNAMICALLY UPDATED route
        searchToUse.currentLocation, // Using REAL-TIME location
        { 
          similarityThreshold: 0.001,
          maxDistanceThreshold: 50.0,
          testMode: TEST_MODE
        }
      );
      
      console.log(`🔍 ${searchToUse.name} ↔ ${oppositeSearch.name}: Score=${similarity.toFixed(3)}`);
      
      if (similarity > highestScore && similarity > 0.01) {
        highestScore = similarity;
        bestMatch = {
          user: oppositeSearch,
          similarity: similarity
        };
      }
    }
    
    // 4. Create match if found
    if (bestMatch) {
      console.log(`🎉 BEST MATCH FOUND: ${searchToUse.name} ↔ ${bestMatch.user.name} (Score: ${highestScore.toFixed(3)})`);
      
      // 🎯 SYMMETRICAL: Prepare match data based on user types
      const matchData = {
        matchId: `realtime_match_${userId}_${bestMatch.user.userId}_${Date.now()}`,
        timestamp: new Date().toISOString(),
        similarityScore: highestScore,
        
        // Always store as driver/passenger (even if passenger initiated)
        driverData: userType === 'driver' ? searchToUse : bestMatch.user,
        passengerData: userType === 'passenger' ? searchToUse : bestMatch.user,
        
        // Extract specific fields for clarity
        driverId: userType === 'driver' ? userId : bestMatch.user.userId,
        driverName: userType === 'driver' ? searchToUse.name : bestMatch.user.name,
        passengerId: userType === 'passenger' ? userId : bestMatch.user.userId,
        passengerName: userType === 'passenger' ? searchToUse.name : bestMatch.user.name,
        
        // Route info - using DYNAMICALLY UPDATED pickup location
        pickupName: searchToUse.pickupName || bestMatch.user.pickupName || 'Unknown',
        destinationName: bestMatch.user.destinationName || searchToUse.destinationName || 'Unknown',
        pickupLocation: searchToUse.pickupLocation || bestMatch.user.pickupLocation,
        destinationLocation: bestMatch.user.destinationLocation || searchToUse.destinationLocation,
        
        rideType: 'immediate',
        matchType: 'realtime_location_based',
        initiatedBy: userType,
        locationTriggered: true,
        dynamicRoute: !!updatedSearchWithDynamicRoute // Flag for dynamic route update
      };
      
      // If driver has vehicle info, include it
      if (userType === 'driver') {
        matchData.vehicleInfo = searchToUse.vehicleInfo;
        matchData.driverRating = searchToUse.rating;
      } else if (bestMatch.user.userType === 'driver') {
        matchData.vehicleInfo = bestMatch.user.vehicleInfo;
        matchData.driverRating = bestMatch.user.rating;
      }
      
      // Save match to Firestore
      await createActiveMatchForOverlay(db, matchData);
      
      // Send WebSocket notification
      if (websocketServer) {
        websocketServer.sendMatchToUsers(matchData);
        console.log(`📤 WebSocket notification sent for real-time match`);
      }
      
      return matchData;
    } else {
      console.log(`🔍 No suitable match found for ${userType} ${searchToUse.name}`);
    }
    
    return null;
    
  } catch (error) {
    console.error(`❌ Error in processUserLocationUpdateAndMatch:`, error);
    return null;
  }
};

// 🎯 SYMMETRICAL: Cleanup expired searches for BOTH types
const cleanupExpiredSearches = async (db) => {
  try {
    const now = admin.firestore.Timestamp.now();
    
    // Clean expired searches for both drivers AND passengers
    const expiredSearches = await db.collection(COLLECTIONS.ACTIVE_SEARCHES)
      .where('expiresAt', '<', now)
      .where('isSearching', '==', true)
      .get();
    
    expiredSearches.forEach(async (doc) => {
      await doc.ref.update({
        isSearching: false,
        status: 'expired',
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    
    console.log(`🧹 Cleaned up ${expiredSearches.size} expired searches (drivers + passengers)`);
    
  } catch (error) {
    console.error('❌ Error cleaning up expired searches:', error);
  }
};

// ========== LOCATION-BASED FUNCTIONS ==========

// 🎯 Haversine distance calculation for proximity
const calculateHaversineDistance = (lat1, lon1, lat2, lon2) => {
  try {
    const R = 6371; // Earth's radius in kilometers
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const distance = R * c;
    return Math.round(distance * 1000) / 1000; // Return in km with 3 decimals
  } catch (error) {
    console.error('❌ Error calculating Haversine distance:', error);
    return Infinity;
  }
};

// 🎯 Calculate proximity score based on current driver location
const calculateProximityScore = (driverLocation, pickupLocation, maxDistance = 2000) => {
  try {
    // If no location data, return 0
    if (!driverLocation || !pickupLocation) return 0;
    
    // If coordinates are missing, return 0
    if (!driverLocation.latitude || !driverLocation.longitude || 
        !pickupLocation.latitude || !pickupLocation.longitude) {
      console.log('⚠️ Missing coordinates for proximity calculation');
      return 0;
    }
    
    const distance = calculateHaversineDistance(
      driverLocation.latitude,
      driverLocation.longitude,
      pickupLocation.latitude,
      pickupLocation.longitude
    );
    
    // Return a score from 0-1, where 1 is very close, 0 is far
    // Convert maxDistance from meters to kilometers if needed
    const maxDistanceKm = maxDistance > 100 ? maxDistance / 1000 : maxDistance;
    
    if (distance > maxDistanceKm) {
      console.log(`📍 Proximity distance ${distance.toFixed(2)}km exceeds max ${maxDistanceKm}km`);
      return 0;
    }
    
    // Exponential decay for proximity score (closer = much better)
    const score = Math.exp(-distance / (maxDistanceKm / 3));
    console.log(`📍 Proximity: ${distance.toFixed(2)}km, Score: ${score.toFixed(3)}`);
    
    return Math.min(1, Math.max(0, score));
  } catch (error) {
    console.error('❌ Error calculating proximity score:', error);
    return 0;
  }
};

// 🎯 Enhanced location tracking for users
const getUserCurrentLocation = async (db, userId, userType) => {
  try {
    // Try to get from active_searches first (most current)
    const activeSearchQuery = await db.collection(COLLECTIONS.ACTIVE_SEARCHES)
      .where('userId', '==', userId)
      .where('userType', '==', userType)
      .where('isSearching', '==', true)
      .orderBy('lastUpdated', 'desc')
      .limit(1)
      .get();

    if (!activeSearchQuery.empty) {
      const searchData = activeSearchQuery.docs[0].data();
      if (searchData.currentLocation) {
        return searchData.currentLocation;
      }
    }

    // Fall back to specific collections for backward compatibility
    const collectionName = userType === 'driver' ? 'drivers' : 'passengers';
    const userQuery = await db.collection(collectionName)
      .where('userId', '==', userId)
      .limit(1)
      .get();

    if (!userQuery.empty) {
      const userData = userQuery.docs[0].data();
      if (userData.currentLocation) {
        return userData.currentLocation;
      }
    }

    // Fall back to last known location from location_history
    const locationQuery = await db.collection(COLLECTIONS.LOCATION_HISTORY)
      .where('userId', '==', userId)
      .where('userType', '==', userType)
      .orderBy('timestamp', 'desc')
      .limit(1)
      .get();

    if (!locationQuery.empty) {
      const locationData = locationQuery.docs[0].data();
      return {
        latitude: locationData.latitude,
        longitude: locationData.longitude,
        accuracy: locationData.accuracy,
        timestamp: locationData.timestamp
      };
    }

    return null;
  } catch (error) {
    console.error('❌ Error getting user current location:', error);
    return null;
  }
};

// 🎯 Calculate ETA based on distance
const calculateETA = (distanceKm, avgSpeedKph = 30) => {
  const timeHours = distanceKm / avgSpeedKph;
  const timeMinutes = Math.ceil(timeHours * 60);
  return timeMinutes;
};

// ========== SESSION MANAGEMENT ==========

const startMatchingSession = (userId, userType, initialLocation = null) => {
  const sessionId = `${userType}_${userId}_${Date.now()}`;
  const sessionData = {
    sessionId,
    userId,
    userType,
    startTime: Date.now(),
    endTime: Date.now() + MATCHING_DURATION,
    isActive: true,
    matchesFound: 0,
    currentLocation: initialLocation
  };
  
  activeMatchingSessions.set(sessionId, sessionData);
  console.log(`🚀 Started matching session: ${sessionId} for ${MATCHING_DURATION/1000} seconds`);
  
  // Auto-cleanup after session duration
  setTimeout(() => {
    endMatchingSession(sessionId);
  }, MATCHING_DURATION);
  
  return sessionId;
};

const updateSessionLocation = (userId, userType, location) => {
  for (const [sessionId, session] of activeMatchingSessions.entries()) {
    if (session.userId === userId && session.userType === userType && session.isActive) {
      session.currentLocation = location;
      session.locationUpdated = Date.now();
      console.log(`📍 Updated location for session ${sessionId}`);
      return true;
    }
  }
  return false;
};

const endMatchingSession = (sessionId) => {
  const session = activeMatchingSessions.get(sessionId);
  if (session) {
    session.isActive = false;
    activeMatchingSessions.delete(sessionId);
    console.log(`🛑 Ended matching session: ${sessionId}. Found ${session.matchesFound} matches`);
  }
};

const isMatchingSessionActive = (userId, userType) => {
  // IN TEST MODE: Always return true to bypass session checks
  if (TEST_MODE) return true;
  
  for (const [sessionId, session] of activeMatchingSessions.entries()) {
    if (session.userId === userId && session.userType === userType && session.isActive) {
      return true;
    }
  }
  return false;
};

const getActiveSession = (userId, userType) => {
  // IN TEST MODE: Return a dummy session
  if (TEST_MODE) {
    return {
      sessionId: `test_session_${userId}`,
      userId,
      userType,
      startTime: Date.now(),
      endTime: Date.now() + MATCHING_DURATION,
      isActive: true,
      matchesFound: 0,
      currentLocation: { latitude: 0, longitude: 0 }
    };
  }
  
  for (const [sessionId, session] of activeMatchingSessions.entries()) {
    if (session.userId === userId && session.userType === userType && session.isActive) {
      return session;
    }
  }
  return null;
};

const getAllActiveSessions = () => {
  return Array.from(activeMatchingSessions.values()).filter(session => session.isActive);
};

// ========== DUPLICATE PREVENTION ==========

const checkExistingMatch = async (db, driverId, passengerId, maxAgeMinutes = 5) => {
  try {
    // IN TEST MODE: Skip duplicate checking for immediate testing
    if (TEST_MODE) {
      console.log('🧪 TEST MODE: Skipping duplicate match check');
      return false;
    }
    
    const now = admin.firestore.Timestamp.now();
    const cutoffTime = new Date(now.toDate().getTime() - maxAgeMinutes * 60 * 1000);
    
    const existingMatches = await db.collection('potential_matches')
      .where('driverId', '==', driverId)
      .where('passengerId', '==', passengerId)
      .where('createdAt', '>', cutoffTime)
      .where('status', 'in', ['proposed', 'pending', 'accepted'])
      .limit(1)
      .get();
    
    return !existingMatches.empty;
  } catch (error) {
    console.error('❌ Error checking existing matches:', error);
    return false;
  }
};

const shouldThrottleMatch = (driverId, passengerId) => {
  // IN TEST MODE: Skip throttling for immediate testing
  if (TEST_MODE) {
    console.log('🧪 TEST MODE: Skipping match throttling');
    return false;
  }
  
  const key = `${driverId}_${passengerId}`;
  const now = Date.now();
  const lastMatchTime = matchCooldown.get(key);
  
  if (lastMatchTime && (now - lastMatchTime) < COOLDOWN_PERIOD) {
    return true;
  }
  
  matchCooldown.set(key, now);
  
  // Clean up old entries
  if (matchCooldown.size > 1000) {
    for (const [key, timestamp] of matchCooldown.entries()) {
      if (now - timestamp > COOLDOWN_PERIOD * 2) {
        matchCooldown.delete(key);
      }
    }
  }
  
  return false;
};

// ========== NOTIFICATION FUNCTIONS ==========

const createMatchNotifications = async (db, matchData) => {
  try {
    console.log(`📢 Creating notifications for match: ${matchData.matchId}`);
    
    const batch = db.batch();
    const timestamp = admin.firestore.FieldValue.serverTimestamp();
    
    // 🎯 Enhanced notification with location info
    const notificationData = {
      type: 'match_proposal',
      read: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      data: {
        matchId: matchData.matchId,
        driverId: matchData.driverId,
        passengerId: matchData.passengerId,
        driverName: matchData.driverName,
        passengerName: matchData.passengerName,
        similarityScore: matchData.similarityScore,
        matchQuality: matchData.matchQuality,
        optimalPickupPoint: matchData.optimalPickupPoint,
        detourDistance: matchData.detourDistance,
        driverPhotoUrl: matchData.driverPhotoUrl || null,
        passengerPhotoUrl: matchData.passengerPhotoUrl || null,
        action: 'view_match',
        // 🎯 New location-based info
        driverCurrentLocation: matchData.driverCurrentLocation,
        proximityScore: matchData.proximityScore,
        distanceToPickup: matchData.distanceToPickup,
        estimatedArrivalTime: matchData.estimatedArrivalTime
      }
    };

    // Driver notification
    const driverNotificationRef = db.collection(COLLECTIONS.NOTIFICATIONS).doc();
    batch.set(driverNotificationRef, {
      ...notificationData,
      userId: matchData.driverId,
      title: 'Passenger Found! 🚗',
      message: `Passenger ${matchData.passengerName} wants to share your ride. ${matchData.distanceToPickup ? `Distance: ${matchData.distanceToPickup.toFixed(1)}km` : ''}`
    });

    // Passenger notification
    const passengerNotificationRef = db.collection(COLLECTIONS.NOTIFICATIONS).doc();
    batch.set(passengerNotificationRef, {
      ...notificationData,
      userId: matchData.passengerId,
      title: 'Driver Found! 🚗',
      message: `Driver ${matchData.driverName} is going your way. ${matchData.estimatedArrivalTime ? `ETA: ${matchData.estimatedArrivalTime} min` : ''}`
    });

    await batch.commit();
    console.log(`✅ Notifications created for both users: ${matchData.driverName} ↔ ${matchData.passengerName}`);
    
    return true;
  } catch (error) {
    console.error('❌ Error creating match notifications:', error);
    return false;
  }
};

// ========== MATCH CREATION ==========

const createMatchIfNotExists = async (db, driverData, passengerData, similarityScore, matchQuality, sessionData = {}) => {
  try {
    const driverId = driverData.driverId || driverData.userId;
    const passengerId = passengerData.passengerId || passengerData.userId;
    
    if (!driverId || !passengerId) {
      console.error('❌ Missing driverId or passengerId');
      return null;
    }

    console.log(`🎯 Creating match: ${driverId} ↔ ${passengerId}`);

    // Check cooldown first (with TEST MODE bypass)
    if (shouldThrottleMatch(driverId, passengerId)) {
      console.log(`⏸️ Match throttled: ${driverId} + ${passengerId}`);
      return null;
    }

    // Check Firestore for existing matches (with TEST MODE bypass)
    const existingMatch = await checkExistingMatch(db, driverId, passengerId);
    if (existingMatch) {
      console.log(`⏸️ Existing match found: ${driverId} + ${passengerId}`);
      return null;
    }

    // 🎯 NEW: Get driver's current location for proximity scoring
    let driverCurrentLocation = null;
    if (driverData.currentLocation) {
      driverCurrentLocation = driverData.currentLocation;
    } else {
      driverCurrentLocation = await getUserCurrentLocation(db, driverId, 'driver');
    }

    // Create new match
    const timestamp = Date.now();
    const matchId = `match_${driverId}_${passengerId}_${timestamp}`;
    
    const optimalPickup = findOptimalPickupPoint(
      passengerData.pickupLocation, 
      driverData.routePoints
    );
    
    const detourDistance = calculateDetourDistance(
      driverData.routePoints,
      optimalPickup,
      passengerData.destinationLocation
    );

    // 🎯 Calculate proximity bonus
    let proximityScore = 0;
    let proximityBonus = 0;
    let distanceToPickup = null;
    
    if (driverCurrentLocation && passengerData.pickupLocation) {
      proximityScore = calculateProximityScore(driverCurrentLocation, passengerData.pickupLocation);
      proximityBonus = proximityScore * 0.3; // 30% weight for proximity
      
      // Calculate actual distance
      distanceToPickup = calculateHaversineDistance(
        driverCurrentLocation.latitude,
        driverCurrentLocation.longitude,
        passengerData.pickupLocation.latitude,
        passengerData.pickupLocation.longitude
      );
    }

    // Adjust final score with proximity bonus
    const finalSimilarityScore = Math.min(1, similarityScore + proximityBonus);

    const matchData = {
      matchId,
      driverId,
      driverName: driverData.name || driverData.driverName || 'Unknown Driver',
      passengerId,
      passengerName: passengerData.name || passengerData.passengerName || 'Unknown Passenger',
      similarityScore: Math.round(finalSimilarityScore * 100) / 100,
      originalSimilarityScore: Math.round(similarityScore * 100) / 100,
      proximityScore: Math.round(proximityScore * 100) / 100,
      matchQuality,
      
      // 🎯 Location data for tracking
      driverCurrentLocation,
      passengerPickupLocation: passengerData.pickupLocation,
      distanceToPickup,
      estimatedArrivalTime: distanceToPickup ? calculateETA(distanceToPickup) : null,
      
      // Route information for overlay
      pickupName: passengerData.pickupName || driverData.pickupName || 'Unknown Location',
      destinationName: passengerData.destinationName || driverData.destinationName || 'Unknown Destination',
      pickupLocation: passengerData.pickupLocation || driverData.pickupLocation,
      destinationLocation: passengerData.destinationLocation || driverData.destinationLocation,
      
      // Session data
      driverSessionId: sessionData.driverSessionId,
      passengerSessionId: sessionData.passengerSessionId,
      
      status: 'proposed',
      detourDistance,
      optimalPickupPoint: optimalPickup,
      timestamp: new Date(timestamp).toISOString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      notificationSent: false,
      testMode: TEST_MODE // Flag for testing
    };

    // Single Firestore write for match
    await db.collection('potential_matches').doc(matchId).set(matchData);
    console.log(`✅ Created new match: ${matchId} (score: ${finalSimilarityScore.toFixed(2)}, proximity: ${proximityScore.toFixed(2)})`);
    
    // Create notifications in single batch
    await createMatchNotifications(db, matchData);
    
    // Update match with notification status in single operation
    await db.collection('potential_matches').doc(matchId).update({
      notificationSent: true
    });
    
    return matchData;
    
  } catch (error) {
    console.error('❌ Error creating match:', error);
    return null;
  }
};

const createActiveMatchForOverlay = async (db, matchData) => {
  try {
    console.log(`🎯 Creating active match for overlay: ${matchData.matchId}`);
    
    const activeMatchData = {
      matchId: matchData.matchId,
      driverId: matchData.driverId,
      driverName: matchData.driverName,
      passengerId: matchData.passengerId,
      passengerName: matchData.passengerName,
      similarityScore: matchData.similarityScore,
      originalSimilarityScore: matchData.originalSimilarityScore,
      proximityScore: matchData.proximityScore,
      matchQuality: matchData.matchQuality,
      
      // 🎯 Location data for real-time tracking
      driverCurrentLocation: matchData.driverCurrentLocation,
      passengerPickupLocation: matchData.passengerPickupLocation,
      distanceToPickup: matchData.distanceToPickup,
      estimatedArrivalTime: matchData.estimatedArrivalTime,
      
      // Route information for overlay display
      pickupName: matchData.pickupName || 'Unknown Location',
      destinationName: matchData.destinationName || 'Unknown Destination',
      pickupLocation: matchData.pickupLocation,
      destinationLocation: matchData.destinationLocation,
      
      // Session information
      driverSessionId: matchData.driverSessionId,
      passengerSessionId: matchData.passengerSessionId,
      
      // Overlay trigger flag
      overlayTriggered: true,
      processedAt: null,
      
      // Single timestamp
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection(COLLECTIONS.ACTIVE_MATCHES).doc(matchData.matchId).set(activeMatchData);
    console.log(`✅ Active match created for overlay: ${matchData.matchId}`);
    return activeMatchData;
    
  } catch (error) {
    console.error('❌ Error creating active match for overlay:', error);
    return null;
  }
};

// ========== MAIN MATCHING FUNCTION ==========

const performIntelligentMatching = async (db, driver, passenger, options = {}) => {
  try {
    console.log('🎯 STARTING INTELLIGENT MATCHING...');
    console.log(`🧪 TEST MODE: ${TEST_MODE ? 'ACTIVE' : 'INACTIVE'}`);
    
    // TEST MODE: Skip session validation
    let driverSession, passengerSession;
    if (TEST_MODE) {
      driverSession = getActiveSession(driver.driverId || driver.userId, 'driver');
      passengerSession = getActiveSession(passenger.passengerId || passenger.userId, 'passenger');
      console.log('🧪 TEST MODE: Using dummy sessions for testing');
    } else {
      driverSession = getActiveSession(driver.driverId || driver.userId, 'driver');
      passengerSession = getActiveSession(passenger.passengerId || passenger.userId, 'passenger');
      
      if (!driverSession || !passengerSession) {
        console.log('❌ Matching session expired or not active');
        return null;
      }
    }

    const {
      // 🎯 LOWER THRESHOLDS FOR TESTING
      similarityThreshold = TEST_MODE ? 0.001 : 0.01,
      maxDetourDistance = TEST_MODE ? 100.0 : 50.0,
      maxProximityDistance = 2000, // meters
      checkCapacity = false
    } = options;

    console.log(`🎯 Matching thresholds - Similarity: ${similarityThreshold}, Detour: ${maxDetourDistance}km, Proximity: ${maxProximityDistance}m`);

    // Basic validation
    if (!driver || !passenger) {
      console.log('❌ Missing driver or passenger data');
      return null;
    }

    if (!driver.routePoints || !passenger.routePoints) {
      console.log('❌ Missing route points');
      return null;
    }

    console.log(`📊 Route points - Driver: ${driver.routePoints.length}, Passenger: ${passenger.routePoints.length}`);

    // Skip capacity check for testing
    if (checkCapacity && !hasCapacity(driver, passenger.passengerCount || 1)) {
      console.log(`❌ No capacity: ${driver.driverId}`);
      return null;
    }

    // 🎯 Get driver's current location
    let driverCurrentLocation = null;
    if (driver.currentLocation) {
      driverCurrentLocation = driver.currentLocation;
    } else {
      driverCurrentLocation = await getUserCurrentLocation(db, driver.driverId || driver.userId, 'driver');
    }

    // Calculate similarity with location-based proximity
    const similarityScore = calculateRouteSimilarity(
      passenger.routePoints, 
      driver.routePoints,
      driverCurrentLocation,
      { 
        maxDistanceThreshold: maxDetourDistance,
        maxProximityDistance: maxProximityDistance,
        testMode: TEST_MODE
      }
    );

    console.log(`🎯 Final similarity score: ${similarityScore.toFixed(3)} (threshold: ${similarityThreshold})`);

    // 🎯 TEST MODE: Force match if routes are somewhat similar
    if (TEST_MODE && similarityScore < similarityThreshold) {
      console.log(`📉 Low similarity but TEST MODE: ${similarityScore.toFixed(3)}`);
      // In test mode, we'll still try to create a match with lower threshold
      if (similarityScore < 0.0001) {
        console.log('❌ Similarity too low even for test mode');
        return null;
      }
    } else if (!TEST_MODE && similarityScore < similarityThreshold) {
      console.log(`📉 Low similarity: ${similarityScore.toFixed(3)} for ${driver.driverId}`);
      return null;
    }

    // Determine match quality based on combined score
    let matchQuality = 'fair';
    if (similarityScore >= 0.7) matchQuality = 'excellent';
    else if (similarityScore >= 0.5) matchQuality = 'good';
    else if (similarityScore >= 0.1) matchQuality = 'fair';
    else matchQuality = 'poor';

    console.log(`🎯 Match quality: ${matchQuality}`);

    // Create match with session data
    const match = await createMatchIfNotExists(db, driver, passenger, similarityScore, matchQuality, {
      driverSessionId: driverSession.sessionId,
      passengerSessionId: passengerSession.sessionId
    });
    
    if (match) {
      console.log(`🎉 SUCCESS: Created match - ${match.driverName} ↔ ${match.passengerName} (${similarityScore.toFixed(3)})`);
      
      // Update session match count
      if (driverSession) driverSession.matchesFound++;
      if (passengerSession) passengerSession.matchesFound++;
      
      // Create active match for overlay
      const activeMatch = await createActiveMatchForOverlay(db, {
        ...match,
        driverSessionId: driverSession.sessionId,
        passengerSessionId: passengerSession.sessionId
      });
      
      if (activeMatch) {
        console.log(`📱 Overlay match ready: ${activeMatch.matchId}`);
      }
    } else {
      console.log('❌ Failed to create match');
    }
    
    return match;

  } catch (error) {
    console.error('❌ Error in intelligent matching:', error);
    return null;
  }
};

// ========== ROUTE SIMILARITY CALCULATION ==========

const calculateRouteSimilarity = (passengerRoute, driverRoute, driverCurrentLocation = null, options = {}) => {
  try {
    if (!passengerRoute || !driverRoute || !Array.isArray(passengerRoute) || !Array.isArray(driverRoute)) {
      return 0;
    }
    
    if (passengerRoute.length === 0 || driverRoute.length === 0) return 0;

    const {
      similarityThreshold = 0.001,
      maxDistanceThreshold = 50.0,
      maxProximityDistance = 2000, // meters
      useHausdorffDistance = true,
      testMode = false
    } = options;

    console.log(`🧪 Similarity calculation - Test Mode: ${testMode}`);

    // Method 1: Direct point-to-point comparison
    const directSimilarity = calculateDirectSimilarity(passengerRoute, driverRoute, similarityThreshold);
    
    // Method 2: Hausdorff distance
    const hausdorffSimilarity = useHausdorffDistance ? 
      calculateHausdorffSimilarity(passengerRoute, driverRoute, maxDistanceThreshold) : 0;
    
    // Method 3: Bounding box overlap
    const bboxSimilarity = calculateBoundingBoxSimilarity(passengerRoute, driverRoute);
    
    // Method 4: Start/end point proximity
    const endpointSimilarity = calculateEndpointSimilarity(passengerRoute, driverRoute, maxDistanceThreshold);
    
    // 🎯 Method 5: Current location proximity (if available)
    let proximitySimilarity = 0;
    if (driverCurrentLocation && passengerRoute.length > 0) {
      const passengerPickup = passengerRoute[0];
      proximitySimilarity = calculateProximityScore(
        driverCurrentLocation, 
        { latitude: passengerPickup.lat, longitude: passengerPickup.lng },
        maxProximityDistance
      );
      console.log(`📍 Location proximity similarity: ${proximitySimilarity.toFixed(3)}`);
    }
    
    // 🎯 TEST MODE: Boost all similarity components
    const boostFactor = testMode ? 2.0 : 1.0;
    
    // 🎯 ENHANCED: Adjusted weights to include proximity
    const weights = {
      direct: 0.25,    // Reduced from 0.3
      hausdorff: 0.35, // Reduced from 0.4
      bbox: 0.1,
      endpoints: 0.2,
      proximity: 0.1   // NEW: 10% weight for current location proximity
    };
    
    const totalSimilarity = 
      (directSimilarity * weights.direct * boostFactor) +
      (hausdorffSimilarity * weights.hausdorff * boostFactor) +
      (bboxSimilarity * weights.bbox * boostFactor) +
      (endpointSimilarity * weights.endpoints * boostFactor) +
      (proximitySimilarity * weights.proximity * boostFactor); // 🎯 NEW
    
    // Ensure similarity is between 0 and 1
    const finalSimilarity = Math.min(1, Math.max(0, totalSimilarity));
    
    console.log(`🎯 Similarity breakdown - Direct: ${directSimilarity.toFixed(3)}, Hausdorff: ${hausdorffSimilarity.toFixed(3)}, BBox: ${bboxSimilarity.toFixed(3)}, Endpoints: ${endpointSimilarity.toFixed(3)}, Proximity: ${proximitySimilarity.toFixed(3)}`);
    console.log(`🎯 Total: ${totalSimilarity.toFixed(3)}, Final: ${finalSimilarity.toFixed(3)}, Boost Factor: ${boostFactor}`);
    
    return finalSimilarity;
    
  } catch (error) {
    console.error('❌ Error calculating route similarity:', error);
    return 0;
  }
};

const calculateDirectSimilarity = (route1, route2, threshold = 0.1) => {
  const minPoints = Math.min(route1.length, route2.length);
  if (minPoints === 0) return 0;
  
  let matchingPoints = 0;
  
  // Use a more relaxed threshold for testing
  const actualThreshold = TEST_MODE ? 1.0 : threshold; // 1.0 degree = ~111km
  
  for (let i = 0; i < minPoints; i++) {
    if (isPointSimilar(route1[i], route2[i], actualThreshold)) {
      matchingPoints++;
    }
  }
  
  const similarity = matchingPoints / Math.max(route1.length, route2.length);
  console.log(`🎯 Direct similarity: ${matchingPoints}/${Math.max(route1.length, route2.length)} = ${similarity.toFixed(3)}`);
  return similarity;
};

const calculateHausdorffSimilarity = (route1, route2, maxDistanceThreshold = 50.0) => {
  try {
    const distance1to2 = calculateDirectedHausdorffDistance(route1, route2);
    const distance2to1 = calculateDirectedHausdorffDistance(route2, route1);
    const hausdorffDistance = Math.max(distance1to2, distance2to1);
    
    // Use more relaxed threshold in test mode
    const actualThreshold = TEST_MODE ? maxDistanceThreshold * 5 : maxDistanceThreshold;
    const similarity = Math.max(0, 1 - (hausdorffDistance / actualThreshold));
    
    console.log(`🎯 Hausdorff distance: ${hausdorffDistance.toFixed(3)}km, similarity: ${similarity.toFixed(3)} (threshold: ${actualThreshold}km)`);
    return similarity;
  } catch (error) {
    console.error('Error calculating Hausdorff distance:', error);
    return 0;
  }
};

const calculateDirectedHausdorffDistance = (routeA, routeB) => {
  let maxMinDistance = 0;
  
  for (const pointA of routeA) {
    let minDistance = Infinity;
    
    for (const pointB of routeB) {
      const distance = calculateDistance(pointA, pointB);
      if (distance < minDistance) {
        minDistance = distance;
      }
    }
    
    if (minDistance > maxMinDistance) {
      maxMinDistance = minDistance;
    }
  }
  
  return maxMinDistance;
};

const calculateBoundingBoxSimilarity = (route1, route2) => {
  try {
    const bbox1 = calculateBoundingBox(route1);
    const bbox2 = calculateBoundingBox(route2);
    
    const intersection = {
      minLat: Math.max(bbox1.minLat, bbox2.minLat),
      maxLat: Math.min(bbox1.maxLat, bbox2.maxLat),
      minLng: Math.max(bbox1.minLng, bbox2.minLng),
      maxLng: Math.min(bbox1.maxLng, bbox2.maxLng)
    };
    
    if (intersection.minLat > intersection.maxLat || intersection.minLng > intersection.maxLng) {
      return 0;
    }
    
    const area1 = (bbox1.maxLat - bbox1.minLat) * (bbox1.maxLng - bbox1.minLng);
    const area2 = (bbox2.maxLat - bbox2.minLat) * (bbox2.maxLng - bbox2.minLng);
    const intersectionArea = (intersection.maxLat - intersection.minLat) * (intersection.maxLng - intersection.minLng);
    
    const similarity = intersectionArea / (area1 + area2 - intersectionArea);
    console.log(`🎯 BBox similarity: ${similarity.toFixed(3)}`);
    return similarity;
    
  } catch (error) {
    console.error('Error calculating bounding box similarity:', error);
    return 0;
  }
};

const calculateBoundingBox = (route) => {
  if (!route || route.length === 0) {
    return { minLat: 0, maxLat: 0, minLng: 0, maxLng: 0 };
  }
  
  let minLat = route[0].lat;
  let maxLat = route[0].lat;
  let minLng = route[0].lng;
  let maxLng = route[0].lng;
  
  for (const point of route) {
    if (point.lat < minLat) minLat = point.lat;
    if (point.lat > maxLat) maxLat = point.lat;
    if (point.lng < minLng) minLng = point.lng;
    if (point.lng > maxLng) maxLng = point.lng;
  }
  
  return { minLat, maxLat, minLng, maxLng };
};

const calculateEndpointSimilarity = (passengerRoute, driverRoute, maxDistanceThreshold = 50.0) => {
  try {
    if (passengerRoute.length === 0 || driverRoute.length === 0) return 0;
    
    const passengerStart = passengerRoute[0];
    const passengerEnd = passengerRoute[passengerRoute.length - 1];
    const driverStart = driverRoute[0];
    const driverEnd = driverRoute[driverRoute.length - 1];
    
    const startDistance = calculateDistance(passengerStart, driverStart);
    const endDistance = calculateDistance(passengerEnd, driverEnd);
    
    // Use more relaxed threshold in test mode
    const actualThreshold = TEST_MODE ? maxDistanceThreshold * 3 : maxDistanceThreshold;
    const startSimilarity = Math.max(0, 1 - (startDistance / actualThreshold));
    const endSimilarity = Math.max(0, 1 - (endDistance / actualThreshold));
    
    const similarity = (startSimilarity + endSimilarity) / 2;
    console.log(`🎯 Endpoint similarity - Start: ${startSimilarity.toFixed(3)}, End: ${endSimilarity.toFixed(3)}, Avg: ${similarity.toFixed(3)} (threshold: ${actualThreshold}km)`);
    return similarity;
    
  } catch (error) {
    console.error('Error calculating endpoint similarity:', error);
    return 0;
  }
};

// ========== LOCATION UTILITIES ==========

const isLocationAlongRoute = (location, routePoints, maxDistance = 5.0, options = {}) => {
  try {
    if (!location || !routePoints || !Array.isArray(routePoints)) return false;
    if (typeof location.lat === 'undefined') return false;
    
    if (routePoints.length === 0) return false;
    
    const {
      checkSegmentProximity = true,
      includeRouteEnds = true
    } = options;
    
    // Check direct point proximity
    for (const point of routePoints) {
      if (!point) continue;
      const distance = calculateDistance(location, point);
      if (distance <= maxDistance) {
        return true;
      }
    }
    
    // Check segment proximity
    if (checkSegmentProximity && routePoints.length >= 2) {
      for (let i = 0; i < routePoints.length - 1; i++) {
        const segmentStart = routePoints[i];
        const segmentEnd = routePoints[i + 1];
        
        if (!segmentStart || !segmentEnd) continue;
        
        const distanceToSegment = calculateDistanceToSegment(location, segmentStart, segmentEnd);
        if (distanceToSegment <= maxDistance) {
          return true;
        }
      }
    }
    
    // Check if location is near route start/end points
    if (includeRouteEnds) {
      const startPoint = routePoints[0];
      const endPoint = routePoints[routePoints.length - 1];
      
      if (startPoint && calculateDistance(location, startPoint) <= maxDistance * 1.5) {
        return true;
      }
      if (endPoint && calculateDistance(location, endPoint) <= maxDistance * 1.5) {
        return true;
      }
    }
    
    return false;
    
  } catch (error) {
    console.error('❌ Error checking location along route:', error);
    return false;
  }
};

const calculateDistanceToSegment = (point, segmentStart, segmentEnd) => {
  const A = point.lat - segmentStart.lat;
  const B = point.lng - segmentStart.lng;
  const C = segmentEnd.lat - segmentStart.lat;
  const D = segmentEnd.lng - segmentStart.lng;
  
  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let param = -1;
  
  if (lenSq !== 0) {
    param = dot / lenSq;
  }
  
  let xx, yy;
  
  if (param < 0) {
    xx = segmentStart.lat;
    yy = segmentStart.lng;
  } else if (param > 1) {
    xx = segmentEnd.lat;
    yy = segmentEnd.lng;
  } else {
    xx = segmentStart.lat + param * C;
    yy = segmentStart.lng + param * D;
  }
  
  return calculateDistance({ lat: point.lat, lng: point.lng }, { lat: xx, lng: yy });
};

const isPointSimilar = (point1, point2, threshold = 0.1) => {
  if (!point1 || !point2) return false;
  if (typeof point1.lat === 'undefined' || typeof point2.lat === 'undefined') return false;
  
  const latDiff = Math.abs(point1.lat - point2.lat);
  const lngDiff = Math.abs(point1.lng - point2.lng);
  
  // In test mode, use much more relaxed thresholds
  const actualThreshold = TEST_MODE ? 10.0 : threshold; // 10 degrees = ~1110km
  
  const isSimilar = latDiff < actualThreshold && lngDiff < actualThreshold;
  
  if (TEST_MODE && isSimilar) {
    console.log(`🧪 Points similar: (${point1.lat},${point1.lng}) vs (${point2.lat},${point2.lng}) - diff: (${latDiff.toFixed(3)},${lngDiff.toFixed(3)})`);
  }
  
  return isSimilar;
};

const calculateDistance = (point1, point2) => {
  try {
    if (!point1 || !point2) return Infinity;
    if (typeof point1.lat === 'undefined' || typeof point2.lat === 'undefined') return Infinity;
    
    const R = 6371;
    const dLat = (point2.lat - point1.lat) * Math.PI / 180;
    const dLng = (point2.lng - point1.lng) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(point1.lat * Math.PI / 180) * Math.cos(point2.lat * Math.PI / 180) *
      Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const distance = R * c;
    
    return Math.round(distance * 1000) / 1000;
    
  } catch (error) {
    console.error('❌ Error calculating distance:', error);
    return Infinity;
  }
};

// ========== ROUTE UTILITIES ==========

const generateRouteHash = (pickup, destination, precision = 3) => {
  try {
    if (!pickup || !destination) return 'invalid_route';
    if (typeof pickup.lat === 'undefined' || typeof destination.lat === 'undefined') return 'invalid_coordinates';
    
    const pickupLat = Number(pickup.lat).toFixed(precision);
    const pickupLng = Number(pickup.lng).toFixed(precision);
    const destLat = Number(destination.lat).toFixed(precision);
    const destLng = Number(destination.lng).toFixed(precision);
    
    const coordinates = [
      `${pickupLat},${pickupLng}`,
      `${destLat},${destLng}`
    ].sort();
    
    return `route_${coordinates.join('_')}_p${precision}`;
    
  } catch (error) {
    console.error('❌ Error generating route hash:', error);
    return 'error_hash';
  }
};

const hasCapacity = (driverData, passengerCount) => {
  try {
    if (!driverData) return false;
    
    const capacity = driverData.passengerCapacity || driverData.capacity || 4;
    const currentPassengers = driverData.currentPassengers || 0;
    const availableSeats = capacity - currentPassengers;
    
    return availableSeats >= passengerCount;
    
  } catch (error) {
    console.error('❌ Error checking capacity:', error);
    return false;
  }
};

const updateDriverCapacity = async (db, driverId, passengerCount, operation = 'add') => {
  try {
    // Update active_searches collection
    const activeSearchQuery = await db.collection(COLLECTIONS.ACTIVE_SEARCHES)
      .where('userId', '==', driverId)
      .where('userType', '==', 'driver')
      .where('isSearching', '==', true)
      .limit(1)
      .get();

    if (!activeSearchQuery.empty) {
      const searchDoc = activeSearchQuery.docs[0];
      const searchData = searchDoc.data();
      
      let currentPassengers = searchData.currentPassengers || 0;
      
      if (operation === 'add') {
        currentPassengers += passengerCount;
      } else if (operation === 'remove') {
        currentPassengers = Math.max(0, currentPassengers - passengerCount);
      }
      
      await searchDoc.ref.update({ 
        currentPassengers,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      console.log(`✅ Updated driver ${driverId} capacity: ${currentPassengers}`);
    }

    // Also update drivers collection for backward compatibility
    const driverQuery = await db.collection('drivers')
      .where('driverId', '==', driverId)
      .limit(1)
      .get();

    if (!driverQuery.empty) {
      const driverDoc = driverQuery.docs[0];
      const driverData = driverDoc.data();
      
      let currentPassengers = driverData.currentPassengers || 0;
      
      if (operation === 'add') {
        currentPassengers += passengerCount;
      } else if (operation === 'remove') {
        currentPassengers = Math.max(0, currentPassengers - passengerCount);
      }
      
      await driverDoc.ref.update({ 
        currentPassengers,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    
    return true;
    
  } catch (error) {
    console.error('❌ Error updating driver capacity:', error);
    return false;
  }
};

const findOptimalPickupPoint = (passengerLocation, driverRoute, maxWalkDistance = 5.0) => {
  try {
    if (!driverRoute || driverRoute.length < 2) return passengerLocation;
    
    let optimalPoint = driverRoute[0];
    let minDeviation = calculateDistance(passengerLocation, driverRoute[0]);
    
    // Check route segments for closer points
    for (let i = 0; i < driverRoute.length - 1; i++) {
      const segmentStart = driverRoute[i];
      const segmentEnd = driverRoute[i + 1];
      
      const closestPoint = findClosestPointOnSegment(passengerLocation, segmentStart, segmentEnd);
      const deviation = calculateDistance(passengerLocation, closestPoint);
      
      if (deviation < minDeviation && deviation <= maxWalkDistance) {
        minDeviation = deviation;
        optimalPoint = closestPoint;
      }
    }
    
    // Also check the last point
    const lastPointDeviation = calculateDistance(passengerLocation, driverRoute[driverRoute.length - 1]);
    if (lastPointDeviation < minDeviation && lastPointDeviation <= maxWalkDistance) {
      optimalPoint = driverRoute[driverRoute.length - 1];
    }
    
    return optimalPoint;
    
  } catch (error) {
    console.error('❌ Error finding optimal pickup point:', error);
    return passengerLocation;
  }
};

const findClosestPointOnSegment = (point, segmentStart, segmentEnd) => {
  const A = point.lat - segmentStart.lat;
  const B = point.lng - segmentStart.lng;
  const C = segmentEnd.lat - segmentStart.lat;
  const D = segmentEnd.lng - segmentStart.lng;
  
  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let param = -1;
  
  if (lenSq !== 0) {
    param = dot / lenSq;
  }
  
  if (param < 0) {
    return segmentStart;
  } else if (param > 1) {
    return segmentEnd;
  } else {
    return {
      lat: segmentStart.lat + param * C,
      lng: segmentStart.lng + param * D
    };
  }
};

const calculateDetourDistance = (driverRoute, pickupPoint, dropoffPoint) => {
  try {
    if (!driverRoute || driverRoute.length < 2) return 0;
    
    const originalDistance = calculateRouteDistance(driverRoute);
    const newRoute = insertPointsInRoute(driverRoute, pickupPoint, dropoffPoint);
    const newDistance = calculateRouteDistance(newRoute);
    
    return Math.max(0, newDistance - originalDistance);
    
  } catch (error) {
    console.error('❌ Error calculating detour distance:', error);
    return 0;
  }
};

const calculateRouteDistance = (route) => {
  if (!route || route.length < 2) return 0;
  
  let totalDistance = 0;
  for (let i = 0; i < route.length - 1; i++) {
    totalDistance += calculateDistance(route[i], route[i + 1]);
  }
  
  return totalDistance;
};

const insertPointsInRoute = (originalRoute, pickupPoint, dropoffPoint) => {
  const pickupIndex = findBestInsertionIndex(originalRoute, pickupPoint);
  const dropoffIndex = findBestInsertionIndex(originalRoute, dropoffPoint);
  
  const newRoute = [...originalRoute];
  
  // Ensure pickup comes before dropoff
  if (pickupIndex <= dropoffIndex) {
    newRoute.splice(pickupIndex, 0, pickupPoint);
    newRoute.splice(dropoffIndex + 1, 0, dropoffPoint);
  } else {
    newRoute.splice(dropoffIndex, 0, dropoffPoint);
    newRoute.splice(pickupIndex + 1, 0, pickupPoint);
  }
  
  return newRoute;
};

const findBestInsertionIndex = (route, point) => {
  let bestIndex = 0;
  let minDistance = Infinity;
  
  for (let i = 0; i < route.length - 1; i++) {
    const segmentStart = route[i];
    const segmentEnd = route[i + 1];
    const distance = calculateDistanceToSegment(point, segmentStart, segmentEnd);
    
    if (distance < minDistance) {
      minDistance = distance;
      bestIndex = i + 1;
    }
  }
  
  return bestIndex;
};

// ========== REAL-TIME LOCATION FUNCTIONS ==========

const processLocationUpdate = async (db, userId, userType, location) => {
  try {
    console.log(`📍 Processing location update for ${userType}: ${userId}`);
    
    // Update session location if active
    updateSessionLocation(userId, userType, location);
    
    // Update user's current location in Firestore
    const timestamp = admin.firestore.FieldValue.serverTimestamp();
    
    // Update location_history collection
    await db.collection(COLLECTIONS.LOCATION_HISTORY).add({
      userId,
      userType,
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy: location.accuracy || 0,
      address: location.address || '',
      timestamp: timestamp,
      source: 'mobile_app'
    });
    
    // Update active_searches collection for active searches
    const activeSearchQuery = await db.collection(COLLECTIONS.ACTIVE_SEARCHES)
      .where('userId', '==', userId)
      .where('userType', '==', userType)
      .where('isSearching', '==', true)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();

    if (!activeSearchQuery.empty) {
      const searchDoc = activeSearchQuery.docs[0];
      await searchDoc.ref.update({
        currentLocation: {
          latitude: location.latitude,
          longitude: location.longitude,
          accuracy: location.accuracy || 0,
          heading: location.heading || 0,
          speed: location.speed || 0,
          timestamp: timestamp
        },
        locationUpdatedAt: timestamp,
        lastUpdated: timestamp
      });
      
      console.log(`✅ Updated location in active search for ${userType}: ${userId}`);
      
      // Return updated search data for immediate matching
      const updatedSearch = searchDoc.data();
      updatedSearch.currentLocation = {
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.accuracy || 0
      };
      
      return updatedSearch;
    }
    
    console.log(`✅ Location updated for ${userType}: ${userId}`);
    return true;
    
  } catch (error) {
    console.error('❌ Error processing location update:', error);
    return false;
  }
};

const findNearbyDrivers = async (db, passengerLocation, maxDistance = 2000, limit = 10) => {
  try {
    console.log(`📍 Finding nearby drivers within ${maxDistance}m`);
    
    // Get active drivers from Firestore
    const activeDrivers = await getActiveSearchesByType(db, 'driver', 50);
    
    const nearbyDrivers = [];
    
    activeDrivers.forEach(driver => {
      if (driver.currentLocation) {
        const distance = calculateHaversineDistance(
          passengerLocation.latitude,
          passengerLocation.longitude,
          driver.currentLocation.latitude,
          driver.currentLocation.longitude
        ) * 1000; // Convert to meters
        
        if (distance <= maxDistance) {
          nearbyDrivers.push({
            driverId: driver.userId,
            distance: Math.round(distance),
            location: driver.currentLocation,
            ...driver
          });
        }
      }
    });
    
    // Sort by distance
    nearbyDrivers.sort((a, b) => a.distance - b.distance);
    
    console.log(`📍 Found ${nearbyDrivers.length} nearby drivers`);
    return nearbyDrivers.slice(0, limit);
    
  } catch (error) {
    console.error('❌ Error finding nearby drivers:', error);
    return [];
  }
};

const createMatchWithRealTimeLocation = async (db, driverData, passengerData, driverCurrentLocation = null) => {
  try {
    console.log('🎯 Creating match with real-time location...');
    
    // Get driver's current location if not provided
    if (!driverCurrentLocation) {
      driverCurrentLocation = await getUserCurrentLocation(db, driverData.driverId || driverData.userId, 'driver');
    }
    
    // Calculate proximity score
    let proximityScore = 0;
    if (driverCurrentLocation && passengerData.pickupLocation) {
      proximityScore = calculateProximityScore(driverCurrentLocation, passengerData.pickupLocation);
    }
    
    // Calculate route similarity with proximity
    const similarityScore = calculateRouteSimilarity(
      passengerData.routePoints,
      driverData.routePoints,
      driverCurrentLocation,
      { testMode: TEST_MODE }
    );
    
    // Create match with enhanced data
    const match = await createMatchIfNotExists(db, driverData, passengerData, similarityScore, 'good', {
      driverSessionId: `realtime_${Date.now()}`,
      passengerSessionId: `realtime_${Date.now()}`
    });
    
    return match;
    
  } catch (error) {
    console.error('❌ Error creating match with real-time location:', error);
    return null;
  }
};

// ========== TESTING FUNCTIONS ==========

const forceCreateTestMatch = async (db, driverData, passengerData) => {
  try {
    console.log('🎯 FORCE CREATING TEST MATCH...');
    
    const driverId = driverData.driverId || driverData.userId;
    const passengerId = passengerData.passengerId || passengerData.userId;
    
    const timestamp = Date.now();
    const matchId = `test_match_${driverId}_${passengerId}_${timestamp}`;
    
    const matchData = {
      matchId,
      driverId,
      driverName: driverData.name || driverData.driverName || 'Test Driver',
      passengerId,
      passengerName: passengerData.name || passengerData.passengerName || 'Test Passenger',
      similarityScore: 0.85,
      matchQuality: 'excellent',
      status: 'proposed',
      detourDistance: 0.5,
      optimalPickupPoint: driverData.routePoints ? driverData.routePoints[0] : { lat: 0, lng: 0 },
      timestamp: new Date(timestamp).toISOString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      notificationSent: false
    };

    // Single Firestore write
    await db.collection('potential_matches').doc(matchId).set(matchData);
    console.log(`✅ Created test match: ${matchId}`);
    
    // Create notifications
    await createMatchNotifications(db, matchData);
    
    // Update notification status
    await db.collection('potential_matches').doc(matchId).update({
      notificationSent: true
    });
    
    console.log(`🎉 TEST MATCH CREATED: ${matchData.driverName} ↔ ${matchData.passengerName}`);
    return matchData;
    
  } catch (error) {
    console.error('❌ Error creating test match:', error);
    return null;
  }
};

const forceImmediateMatching = async (db, driverData, passengerData) => {
  console.log('🎯 FORCE IMMEDIATE MATCHING ACTIVATED!');
  
  try {
    // Create a test match immediately without any checks
    const timestamp = Date.now();
    const driverId = driverData.driverId || driverData.userId;
    const passengerId = passengerData.passengerId || passengerData.userId;
    const matchId = `force_match_${driverId}_${passengerId}_${timestamp}`;
    
    const matchData = {
      matchId,
      driverId,
      driverName: driverData.name || driverData.driverName || 'Test Driver',
      passengerId,
      passengerName: passengerData.name || passengerData.passengerName || 'Test Passenger',
      similarityScore: 0.95,
      matchQuality: 'excellent',
      
      // Route information
      pickupName: passengerData.pickupName || driverData.pickupName || 'Test Pickup',
      destinationName: passengerData.destinationName || driverData.destinationName || 'Test Destination',
      pickupLocation: passengerData.pickupLocation || driverData.pickupLocation,
      destinationLocation: passengerData.destinationLocation || driverData.destinationLocation,
      
      status: 'proposed',
      detourDistance: 0.1,
      optimalPickupPoint: passengerData.pickupLocation || { lat: 0, lng: 0 },
      timestamp: new Date(timestamp).toISOString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      notificationSent: false,
      forceCreated: true,
      testMode: true
    };

    // Create the match
    await db.collection('potential_matches').doc(matchId).set(matchData);
    console.log(`✅ FORCE CREATED MATCH: ${matchId}`);
    
    // Create notifications
    await createMatchNotifications(db, matchData);
    
    // Update notification status
    await db.collection('potential_matches').doc(matchId).update({
      notificationSent: true
    });
    
    console.log(`🎉 FORCE MATCH SUCCESS: ${matchData.driverName} ↔ ${matchData.passengerName}`);
    return matchData;
    
  } catch (error) {
    console.error('❌ Error in force matching:', error);
    return null;
  }
};

const forceImmediateMatchingWithLocation = async (db, driverData, passengerData) => {
  console.log('🎯 FORCE IMMEDIATE MATCHING WITH LOCATION ACTIVATED!');
  
  try {
    // Get or generate current location
    let driverCurrentLocation = driverData.currentLocation || {
      latitude: driverData.routePoints[0]?.lat || 37.7749,
      longitude: driverData.routePoints[0]?.lng || -122.4194,
      accuracy: 50,
      timestamp: new Date().toISOString()
    };
    
    // Create a test match immediately with location data
    const timestamp = Date.now();
    const driverId = driverData.driverId || driverData.userId;
    const passengerId = passengerData.passengerId || passengerData.userId;
    const matchId = `force_loc_match_${driverId}_${passengerId}_${timestamp}`;
    
    // Calculate proximity
    const proximityScore = calculateProximityScore(
      driverCurrentLocation,
      passengerData.pickupLocation || { latitude: 0, longitude: 0 }
    );
    
    const matchData = {
      matchId,
      driverId,
      driverName: driverData.name || driverData.driverName || 'Test Driver',
      passengerId,
      passengerName: passengerData.name || passengerData.passengerName || 'Test Passenger',
      similarityScore: 0.85 + (proximityScore * 0.15), // Base score + proximity bonus
      originalSimilarityScore: 0.85,
      proximityScore: proximityScore,
      matchQuality: 'excellent',
      
      // 🎯 Location data
      driverCurrentLocation,
      passengerPickupLocation: passengerData.pickupLocation,
      
      // Route information
      pickupName: passengerData.pickupName || driverData.pickupName || 'Test Pickup',
      destinationName: passengerData.destinationName || driverData.destinationName || 'Test Destination',
      pickupLocation: passengerData.pickupLocation || driverData.pickupLocation,
      destinationLocation: passengerData.destinationLocation || driverData.destinationLocation,
      
      status: 'proposed',
      detourDistance: 0.1,
      optimalPickupPoint: passengerData.pickupLocation || { lat: 0, lng: 0 },
      timestamp: new Date(timestamp).toISOString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      notificationSent: false,
      forceCreated: true,
      testMode: true,
      locationBased: true
    };

    // Create the match
    await db.collection('potential_matches').doc(matchId).set(matchData);
    console.log(`✅ FORCE CREATED LOCATION-BASED MATCH: ${matchId}`);
    
    // Create notifications
    await createMatchNotifications(db, matchData);
    
    // Update notification status
    await db.collection('potential_matches').doc(matchId).update({
      notificationSent: true
    });
    
    console.log(`🎉 FORCE MATCH SUCCESS WITH LOCATION: ${matchData.driverName} ↔ ${matchData.passengerName}`);
    return matchData;
    
  } catch (error) {
    console.error('❌ Error in force matching with location:', error);
    return null;
  }
};

// ========== MAINTENANCE FUNCTIONS ==========

const cleanupOldMatches = async (db, olderThanMinutes = 30) => {
  try {
    const cutoffTime = new Date(Date.now() - olderThanMinutes * 60 * 1000);
    const oldMatches = await db.collection('potential_matches')
      .where('createdAt', '<', cutoffTime)
      .where('status', 'in', ['proposed', 'pending'])
      .get();

    const batch = db.batch();
    oldMatches.forEach(doc => {
      batch.delete(doc.ref);
    });

    await batch.commit();
    console.log(`🧹 Cleaned up ${oldMatches.size} old matches`);
  } catch (error) {
    console.error('❌ Error cleaning up old matches:', error);
  }
};

const cleanupExpiredSessions = () => {
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [sessionId, session] of activeMatchingSessions.entries()) {
    if (now > session.endTime) {
      activeMatchingSessions.delete(sessionId);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`🧹 Cleaned up ${cleanedCount} expired sessions`);
  }
};

// ========== EXPORT ALL FUNCTIONS ==========

module.exports = {
  // Session management
  startMatchingSession,
  endMatchingSession,
  isMatchingSessionActive,
  getActiveSession,
  getAllActiveSessions,
  cleanupExpiredSessions,
  updateSessionLocation,
  
  // 🎯 Location-based functions
  calculateProximityScore,
  getUserCurrentLocation,
  processLocationUpdate,
  findNearbyDrivers,
  createMatchWithRealTimeLocation,
  forceImmediateMatchingWithLocation,
  calculateHaversineDistance,
  calculateETA,
  
  // 🎯 SYMMETRICAL Firestore functions (for BOTH drivers AND passengers)
  saveActiveSearch,                    // ✅ For BOTH drivers AND passengers
  updateUserLocation,                  // ✅ For BOTH drivers AND passengers
  getActiveSearchesByType,             // ✅ For BOTH drivers AND passengers
  processUserLocationUpdateAndMatch,   // ✅ SYMMETRICAL location matching
  cleanupExpiredSearches,
  
  // 🎯 NEW: Dynamic route updating
  updateUserRouteWithCurrentLocation,  // 🎯 DYNAMIC ROUTE UPDATING
  
  // Backward compatibility aliases
  saveActiveDriverSearch: saveActiveSearch,
  getActiveDriverSearches: async (db, limit) => getActiveSearchesByType(db, 'driver', limit),
  getActivePassengerSearches: async (db, limit) => getActiveSearchesByType(db, 'passenger', limit),
  
  // Core matching functions
  performIntelligentMatching,
  createMatchIfNotExists,
  createActiveMatchForOverlay,
  checkExistingMatch,
  shouldThrottleMatch,
  createMatchNotifications,
  forceCreateTestMatch,
  forceImmediateMatching,
  
  // Route calculation functions
  calculateRouteSimilarity,
  isLocationAlongRoute,
  generateRouteHash,
  calculateDistance,
  
  // Capacity functions
  hasCapacity,
  updateDriverCapacity,
  
  // Route optimization functions
  findOptimalPickupPoint,
  calculateDetourDistance,
  calculateRouteDistance,
  
  // Similarity components
  calculateDirectSimilarity,
  calculateHausdorffSimilarity,
  calculateBoundingBoxSimilarity,
  calculateEndpointSimilarity,
  
  // Maintenance
  cleanupOldMatches,
  
  // Test mode flag
  TEST_MODE
};
