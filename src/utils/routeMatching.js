const { COLLECTIONS, TIMEOUTS, MATCHING_THRESHOLDS, TEST_MODE } = require('../config/constants');
const helpers = require('./helpers');
const cache = require('./cache');

// In-memory tracking for sessions
const activeMatchingSessions = new Map();
const MATCHING_DURATION = 5 * 60 * 1000;

// Duplicate prevention cache
const matchCooldown = new Map();
const COOLDOWN_PERIOD = 2 * 60 * 1000;

module.exports = {
  // Session management
  startMatchingSession: (userId, userType, initialLocation = null) => {
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
    
    setTimeout(() => {
      module.exports.endMatchingSession(sessionId);
    }, MATCHING_DURATION);
    
    return sessionId;
  },

  endMatchingSession: (sessionId) => {
    const session = activeMatchingSessions.get(sessionId);
    if (session) {
      session.isActive = false;
      activeMatchingSessions.delete(sessionId);
      console.log(`🛑 Ended matching session: ${sessionId}. Found ${session.matchesFound} matches`);
    }
  },

  isMatchingSessionActive: (userId, userType) => {
    if (TEST_MODE) return true;
    
    for (const [, session] of activeMatchingSessions.entries()) {
      if (session.userId === userId && session.userType === userType && session.isActive) {
        return true;
      }
    }
    return false;
  },

  getActiveSession: (userId, userType) => {
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
    
    for (const [, session] of activeMatchingSessions.entries()) {
      if (session.userId === userId && session.userType === userType && session.isActive) {
        return session;
      }
    }
    return null;
  },

  // Main matching function
  performIntelligentMatching: async (db, driver, passenger, options = {}) => {
    try {
      console.log('🎯 STARTING INTELLIGENT MATCHING...');
      
      // Get sessions
      const driverSession = module.exports.getActiveSession(driver.driverId || driver.userId, 'driver');
      const passengerSession = module.exports.getActiveSession(passenger.passengerId || passenger.userId, 'passenger');
      
      if (!driverSession || !passengerSession) {
        console.log('❌ Matching session expired or not active');
        return null;
      }

      const {
        similarityThreshold = MATCHING_THRESHOLDS.SIMILARITY,
        maxDetourDistance = MATCHING_THRESHOLDS.MAX_DETOUR_DISTANCE,
        maxProximityDistance = MATCHING_THRESHOLDS.MAX_PROXIMITY_DISTANCE,
        checkCapacity = true
      } = options;

      console.log(`🎯 Matching thresholds - Similarity: ${similarityThreshold}, Detour: ${maxDetourDistance}km`);

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

      // Check capacity
      const passengerCount = passenger.passengerCount || 1;
      if (checkCapacity && !module.exports.hasCapacity(driver, passengerCount)) {
        console.log(`❌ No capacity: Driver ${driver.driverId || driver.userId} has ${driver.availableSeats || 0} seats, need ${passengerCount}`);
        return null;
      }

      // Calculate similarity
      const similarityScore = module.exports.calculateRouteSimilarity(
        passenger.routePoints,
        driver.routePoints,
        driver.currentLocation,
        { 
          maxDistanceThreshold: maxDetourDistance,
          maxProximityDistance: maxProximityDistance
        }
      );

      console.log(`🎯 Final similarity score: ${similarityScore.toFixed(3)} (threshold: ${similarityThreshold})`);

      if (TEST_MODE && similarityScore < similarityThreshold) {
        console.log(`📉 Low similarity but TEST MODE: ${similarityScore.toFixed(3)}`);
        if (similarityScore < MATCHING_THRESHOLDS.MIN_SIMILARITY_TEST) {
          console.log('❌ Similarity too low even for test mode');
          return null;
        }
      } else if (!TEST_MODE && similarityScore < similarityThreshold) {
        console.log(`📉 Low similarity: ${similarityScore.toFixed(3)} for ${driver.driverId}`);
        return null;
      }

      // Determine match quality
      let matchQuality = 'fair';
      if (similarityScore >= 0.7) matchQuality = 'excellent';
      else if (similarityScore >= 0.5) matchQuality = 'good';
      else if (similarityScore >= 0.1) matchQuality = 'fair';
      else matchQuality = 'poor';

      console.log(`🎯 Match quality: ${matchQuality}`);

      // Create match
      const match = await module.exports.createMatchIfNotExists(db, driver, passenger, similarityScore, matchQuality, {
        driverSessionId: driverSession.sessionId,
        passengerSessionId: passengerSession.sessionId
      });
      
      if (match) {
        console.log(`🎉 SUCCESS: Created match - ${match.driverName} ↔ ${match.passengerName} (${similarityScore.toFixed(3)})`);
        
        // Update session match count
        if (driverSession) driverSession.matchesFound++;
        if (passengerSession) passengerSession.matchesFound++;
      } else {
        console.log('❌ Failed to create match');
      }
      
      return match;

    } catch (error) {
      console.error('❌ Error in intelligent matching:', error);
      return null;
    }
  },

  // Route similarity calculation
  calculateRouteSimilarity: (passengerRoute, driverRoute, driverCurrentLocation = null, options = {}) => {
    try {
      if (!passengerRoute || !driverRoute || !Array.isArray(passengerRoute) || !Array.isArray(driverRoute)) {
        return 0;
      }
      
      if (passengerRoute.length === 0 || driverRoute.length === 0) return 0;

      const {
        similarityThreshold = 0.001,
        maxDistanceThreshold = 50.0,
        maxProximityDistance = 2000,
        useHausdorffDistance = true
      } = options;

      // Method 1: Direct point-to-point comparison
      const directSimilarity = module.exports.calculateDirectSimilarity(passengerRoute, driverRoute, similarityThreshold);
      
      // Method 2: Hausdorff distance
      const hausdorffSimilarity = useHausdorffDistance ? 
        module.exports.calculateHausdorffSimilarity(passengerRoute, driverRoute, maxDistanceThreshold) : 0;
      
      // Method 3: Bounding box overlap
      const bboxSimilarity = module.exports.calculateBoundingBoxSimilarity(passengerRoute, driverRoute);
      
      // Method 4: Start/end point proximity
      const endpointSimilarity = module.exports.calculateEndpointSimilarity(passengerRoute, driverRoute, maxDistanceThreshold);
      
      // Method 5: Current location proximity
      let proximitySimilarity = 0;
      if (driverCurrentLocation && passengerRoute.length > 0) {
        const passengerPickup = passengerRoute[0];
        proximitySimilarity = module.exports.calculateProximityScore(
          driverCurrentLocation, 
          { latitude: passengerPickup.lat, longitude: passengerPickup.lng },
          maxProximityDistance
        );
      }
      
      // Enhanced weights
      const weights = {
        direct: 0.25,
        hausdorff: 0.35,
        bbox: 0.1,
        endpoints: 0.2,
        proximity: 0.1
      };
      
      const totalSimilarity = 
        (directSimilarity * weights.direct) +
        (hausdorffSimilarity * weights.hausdorff) +
        (bboxSimilarity * weights.bbox) +
        (endpointSimilarity * weights.endpoints) +
        (proximitySimilarity * weights.proximity);
      
      const finalSimilarity = Math.min(1, Math.max(0, totalSimilarity));
      
      return finalSimilarity;
      
    } catch (error) {
      console.error('❌ Error calculating route similarity:', error);
      return 0;
    }
  },

  // Similarity components
  calculateDirectSimilarity: (route1, route2, threshold = 0.1) => {
    const minPoints = Math.min(route1.length, route2.length);
    if (minPoints === 0) return 0;
    
    let matchingPoints = 0;
    const actualThreshold = TEST_MODE ? 1.0 : threshold;
    
    for (let i = 0; i < minPoints; i++) {
      if (module.exports.isPointSimilar(route1[i], route2[i], actualThreshold)) {
        matchingPoints++;
      }
    }
    
    return matchingPoints / Math.max(route1.length, route2.length);
  },

  calculateHausdorffSimilarity: (route1, route2, maxDistanceThreshold = 50.0) => {
    try {
      const distance1to2 = module.exports.calculateDirectedHausdorffDistance(route1, route2);
      const distance2to1 = module.exports.calculateDirectedHausdorffDistance(route2, route1);
      const hausdorffDistance = Math.max(distance1to2, distance2to1);
      
      const actualThreshold = TEST_MODE ? maxDistanceThreshold * 5 : maxDistanceThreshold;
      const similarity = Math.max(0, 1 - (hausdorffDistance / actualThreshold));
      
      return similarity;
    } catch (error) {
      console.error('Error calculating Hausdorff distance:', error);
      return 0;
    }
  },

  calculateDirectedHausdorffDistance: (routeA, routeB) => {
    let maxMinDistance = 0;
    
    for (const pointA of routeA) {
      let minDistance = Infinity;
      
      for (const pointB of routeB) {
        const distance = helpers.calculateHaversineDistance(pointA.lat, pointA.lng, pointB.lat, pointB.lng);
        if (distance < minDistance) {
          minDistance = distance;
        }
      }
      
      if (minDistance > maxMinDistance) {
        maxMinDistance = minDistance;
      }
    }
    
    return maxMinDistance;
  },

  calculateBoundingBoxSimilarity: (route1, route2) => {
    try {
      const bbox1 = module.exports.calculateBoundingBox(route1);
      const bbox2 = module.exports.calculateBoundingBox(route2);
      
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
      
      return intersectionArea / (area1 + area2 - intersectionArea);
      
    } catch (error) {
      console.error('Error calculating bounding box similarity:', error);
      return 0;
    }
  },

  calculateBoundingBox: (route) => {
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
  },

  calculateEndpointSimilarity: (passengerRoute, driverRoute, maxDistanceThreshold = 50.0) => {
    try {
      if (passengerRoute.length === 0 || driverRoute.length === 0) return 0;
      
      const passengerStart = passengerRoute[0];
      const passengerEnd = passengerRoute[passengerRoute.length - 1];
      const driverStart = driverRoute[0];
      const driverEnd = driverRoute[driverRoute.length - 1];
      
      const startDistance = helpers.calculateHaversineDistance(
        passengerStart.lat, passengerStart.lng,
        driverStart.lat, driverStart.lng
      );
      const endDistance = helpers.calculateHaversineDistance(
        passengerEnd.lat, passengerEnd.lng,
        driverEnd.lat, driverEnd.lng
      );
      
      const actualThreshold = TEST_MODE ? maxDistanceThreshold * 3 : maxDistanceThreshold;
      const startSimilarity = Math.max(0, 1 - (startDistance / actualThreshold));
      const endSimilarity = Math.max(0, 1 - (endDistance / actualThreshold));
      
      return (startSimilarity + endSimilarity) / 2;
      
    } catch (error) {
      console.error('Error calculating endpoint similarity:', error);
      return 0;
    }
  },

  // Proximity scoring
  calculateProximityScore: (driverLocation, pickupLocation, maxDistance = 2000) => {
    try {
      if (!driverLocation || !pickupLocation) return 0;
      
      if (!driverLocation.latitude || !driverLocation.longitude || 
          !pickupLocation.latitude || !pickupLocation.longitude) {
        return 0;
      }
      
      const distance = helpers.calculateHaversineDistance(
        driverLocation.latitude,
        driverLocation.longitude,
        pickupLocation.latitude,
        pickupLocation.longitude
      );
      
      const maxDistanceKm = maxDistance > 100 ? maxDistance / 1000 : maxDistance;
      
      if (distance > maxDistanceKm) {
        return 0;
      }
      
      const score = Math.exp(-distance / (maxDistanceKm / 3));
      return Math.min(1, Math.max(0, score));
    } catch (error) {
      console.error('❌ Error calculating proximity score:', error);
      return 0;
    }
  },

  // Capacity checking
  hasCapacity: (driverData, passengerCount) => {
    try {
      if (!driverData) return false;
      
      const capacity = driverData.passengerCapacity || driverData.capacity || 4;
      const currentPassengers = driverData.currentPassengers || 0;
      const availableSeats = driverData.availableSeats || (capacity - currentPassengers);
      
      return availableSeats >= passengerCount;
      
    } catch (error) {
      console.error('❌ Error checking capacity:', error);
      return false;
    }
  },

  // Point similarity
  isPointSimilar: (point1, point2, threshold = 0.1) => {
    if (!point1 || !point2) return false;
    if (typeof point1.lat === 'undefined' || typeof point2.lat === 'undefined') return false;
    
    const latDiff = Math.abs(point1.lat - point2.lat);
    const lngDiff = Math.abs(point1.lng - point2.lng);
    
    const actualThreshold = TEST_MODE ? 10.0 : threshold;
    return latDiff < actualThreshold && lngDiff < actualThreshold;
  },

  // Match creation with duplicate prevention
  createMatchIfNotExists: async (db, driverData, passengerData, similarityScore, matchQuality, sessionData = {}) => {
    try {
      const driverId = driverData.driverId || driverData.userId;
      const passengerId = passengerData.passengerId || passengerData.userId;
      
      if (!driverId || !passengerId) {
        console.error('❌ Missing driverId or passengerId');
        return null;
      }

      console.log(`🎯 Creating match: ${driverId} ↔ ${passengerId}`);

      // Check cooldown
      if (module.exports.shouldThrottleMatch(driverId, passengerId)) {
        console.log(`⏸️ Match throttled: ${driverId} + ${passengerId}`);
        return null;
      }

      // Check for existing matches
      const existingMatch = await module.exports.checkExistingMatch(db, driverId, passengerId);
      if (existingMatch) {
        console.log(`⏸️ Existing match found: ${driverId} + ${passengerId}`);
        return null;
      }

      // Create new match
      const timestamp = Date.now();
      const matchId = `match_${driverId}_${passengerId}_${timestamp}`;
      
      const matchData = {
        matchId,
        driverId,
        driverName: driverData.name || driverData.driverName || 'Unknown Driver',
        passengerId,
        passengerName: passengerData.name || passengerData.passengerName || 'Unknown Passenger',
        similarityScore: Math.round(similarityScore * 100) / 100,
        matchQuality,
        status: 'proposed',
        timestamp: new Date(timestamp).toISOString(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        notificationSent: false,
        testMode: TEST_MODE
      };

      // Save to Firestore
      await db.collection(COLLECTIONS.POTENTIAL_MATCHES).doc(matchId).set(matchData);
      console.log(`✅ Created new match: ${matchId} (score: ${similarityScore.toFixed(2)})`);
      
      return matchData;
      
    } catch (error) {
      console.error('❌ Error creating match:', error);
      return null;
    }
  },

  // Duplicate prevention
  shouldThrottleMatch: (driverId, passengerId) => {
    if (TEST_MODE) {
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
  },

  checkExistingMatch: async (db, driverId, passengerId, maxAgeMinutes = 5) => {
    try {
      if (TEST_MODE) {
        return false;
      }
      
      const now = admin.firestore.Timestamp.now();
      const cutoffTime = new Date(now.toDate().getTime() - maxAgeMinutes * 60 * 1000);
      
      const existingMatches = await db.collection(COLLECTIONS.POTENTIAL_MATCHES)
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
  },

  // Cleanup functions
  cleanupExpiredSessions: () => {
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
  },

  // Get all active sessions
  getAllActiveSessions: () => {
    return Array.from(activeMatchingSessions.values()).filter(session => session.isActive);
  },

  // Update session location
  updateSessionLocation: (userId, userType, location) => {
    for (const [, session] of activeMatchingSessions.entries()) {
      if (session.userId === userId && session.userType === userType && session.isActive) {
        session.currentLocation = location;
        session.locationUpdated = Date.now();
        return true;
      }
    }
    return false;
  }
};
