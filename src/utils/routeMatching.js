// utils/routeMatching.js - FIXED FOR IMMEDIATE MATCHING
const admin = require('firebase-admin');

// TEST MODE - Set to true for immediate testing
const TEST_MODE = true;

// Matching session management
const activeMatchingSessions = new Map();
const MATCHING_DURATION = 5 * 60 * 1000; // 5 minutes

// Duplicate prevention cache
const matchCooldown = new Map();
const COOLDOWN_PERIOD = 2 * 60 * 1000; // 2 minutes cooldown

// Session management functions
const startMatchingSession = (userId, userType) => {
  const sessionId = `${userType}_${userId}_${Date.now()}`;
  const sessionData = {
    sessionId,
    userId,
    userType,
    startTime: Date.now(),
    endTime: Date.now() + MATCHING_DURATION,
    isActive: true,
    matchesFound: 0
  };
  
  activeMatchingSessions.set(sessionId, sessionData);
  console.log(`🚀 Started matching session: ${sessionId} for ${MATCHING_DURATION/1000} seconds`);
  
  // Auto-cleanup after session duration
  setTimeout(() => {
    endMatchingSession(sessionId);
  }, MATCHING_DURATION);
  
  return sessionId;
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
      matchesFound: 0
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

// 🎯 FIXED: Enhanced duplicate prevention with TEST MODE bypass
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

// 🎯 FIXED: Throttling with TEST MODE bypass
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

// ✅ OPTIMIZED: Single Firestore write for notifications
const createMatchNotifications = async (db, matchData) => {
  try {
    console.log(`📢 Creating notifications for match: ${matchData.matchId}`);
    
    const batch = db.batch();
    const timestamp = admin.firestore.FieldValue.serverTimestamp();
    
    // Shared notification data
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
        driverPhotoUrl: null,
        passengerPhotoUrl: null,
        action: 'view_match'
      }
    };

    // Driver notification
    const driverNotificationRef = db.collection('notifications').doc();
    batch.set(driverNotificationRef, {
      ...notificationData,
      userId: matchData.driverId,
      title: 'Passenger Found! 🚗',
      message: `Passenger ${matchData.passengerName} wants to share your ride. Route similarity: ${(matchData.similarityScore * 100).toFixed(1)}%`
    });

    // Passenger notification
    const passengerNotificationRef = db.collection('notifications').doc();
    batch.set(passengerNotificationRef, {
      ...notificationData,
      userId: matchData.passengerId,
      title: 'Driver Found! 🚗',
      message: `Driver ${matchData.driverName} is going your way. Route similarity: ${(matchData.similarityScore * 100).toFixed(1)}%`
    });

    await batch.commit();
    console.log(`✅ Notifications created for both users: ${matchData.driverName} ↔ ${matchData.passengerName}`);
    
    return true;
  } catch (error) {
    console.error('❌ Error creating match notifications:', error);
    return false;
  }
};

// ✅ OPTIMIZED: Single Firestore write for active match
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
      matchQuality: matchData.matchQuality,
      
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

    await db.collection('active_matches').doc(matchData.matchId).set(activeMatchData);
    console.log(`✅ Active match created for overlay: ${matchData.matchId}`);
    return activeMatchData;
    
  } catch (error) {
    console.error('❌ Error creating active match for overlay:', error);
    return null;
  }
};

// 🎯 FIXED: Create match with TEST MODE optimizations
const createMatchIfNotExists = async (db, driverData, passengerData, similarityScore, matchQuality, sessionData = {}) => {
  try {
    const driverId = driverData.driverId || driverData.id;
    const passengerId = passengerData.passengerId || passengerData.id;
    
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

    const matchData = {
      matchId,
      driverId,
      driverName: driverData.driverName || driverData.name || 'Unknown Driver',
      passengerId,
      passengerName: passengerData.passengerName || passengerData.name || 'Unknown Passenger',
      similarityScore: Math.round(similarityScore * 100) / 100,
      matchQuality,
      
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
    console.log(`✅ Created new match: ${matchId} (score: ${similarityScore.toFixed(2)})`);
    
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

// 🎯 FIXED: Main matching function with TEST MODE optimizations
const performIntelligentMatching = async (db, driver, passenger, options = {}) => {
  try {
    console.log('🎯 STARTING INTELLIGENT MATCHING...');
    console.log(`🧪 TEST MODE: ${TEST_MODE ? 'ACTIVE' : 'INACTIVE'}`);
    
    // TEST MODE: Skip session validation
    let driverSession, passengerSession;
    if (TEST_MODE) {
      driverSession = getActiveSession(driver.driverId, 'driver');
      passengerSession = getActiveSession(passenger.passengerId, 'passenger');
      console.log('🧪 TEST MODE: Using dummy sessions for testing');
    } else {
      driverSession = getActiveSession(driver.driverId, 'driver');
      passengerSession = getActiveSession(passenger.passengerId, 'passenger');
      
      if (!driverSession || !passengerSession) {
        console.log('❌ Matching session expired or not active');
        return null;
      }
    }

    const {
      // 🎯 LOWER THRESHOLDS FOR TESTING
      similarityThreshold = TEST_MODE ? 0.001 : 0.01,
      maxDetourDistance = TEST_MODE ? 100.0 : 50.0,
      checkCapacity = false
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

    // Skip capacity check for testing
    if (checkCapacity && !hasCapacity(driver, passenger.passengerCount || 1)) {
      console.log(`❌ No capacity: ${driver.driverId}`);
      return null;
    }

    // Calculate similarity with TEST MODE boost
    const similarityScore = calculateRouteSimilarity(
      passenger.routePoints, 
      driver.routePoints,
      { 
        maxDistanceThreshold: maxDetourDistance,
        testMode: TEST_MODE // Pass test mode to similarity calculation
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

    // Determine match quality
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

// 🎯 FIXED: Calculate route similarity with VERY LOW requirements for testing
const calculateRouteSimilarity = (passengerRoute, driverRoute, options = {}) => {
  try {
    if (!passengerRoute || !driverRoute || !Array.isArray(passengerRoute) || !Array.isArray(driverRoute)) {
      return 0;
    }
    
    if (passengerRoute.length === 0 || driverRoute.length === 0) return 0;

    const {
      similarityThreshold = 0.001,
      maxDistanceThreshold = 50.0,
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
    
    // 🎯 TEST MODE: Boost all similarity components
    const boostFactor = testMode ? 2.0 : 1.0;
    
    const weights = {
      direct: 0.3,
      hausdorff: 0.4,
      bbox: 0.1,
      endpoints: 0.2
    };
    
    const totalSimilarity = 
      (directSimilarity * weights.direct * boostFactor) +
      (hausdorffSimilarity * weights.hausdorff * boostFactor) +
      (bboxSimilarity * weights.bbox * boostFactor) +
      (endpointSimilarity * weights.endpoints * boostFactor);
    
    // Ensure similarity is between 0 and 1
    const finalSimilarity = Math.min(1, Math.max(0, totalSimilarity));
    
    console.log(`🎯 Similarity breakdown - Direct: ${directSimilarity.toFixed(3)}, Hausdorff: ${hausdorffSimilarity.toFixed(3)}, BBox: ${bboxSimilarity.toFixed(3)}, Endpoints: ${endpointSimilarity.toFixed(3)}`);
    console.log(`🎯 Total: ${totalSimilarity.toFixed(3)}, Final: ${finalSimilarity.toFixed(3)}, Boost Factor: ${boostFactor}`);
    
    return finalSimilarity;
    
  } catch (error) {
    console.error('❌ Error calculating route similarity:', error);
    return 0;
  }
};

// 🎯 FIXED: Direct point-to-point similarity with relaxed thresholds
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

// 🎯 FIXED: Hausdorff distance with relaxed thresholds
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

// Directed Hausdorff distance
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

// Bounding box similarity
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

// Calculate bounding box for a route
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

// 🎯 FIXED: Endpoint similarity with relaxed thresholds
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

// Enhanced location along route check
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

// Calculate distance from point to line segment
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

// 🎯 FIXED: Enhanced point similarity check with relaxed thresholds
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

// Calculate distance between two points (Haversine formula)
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

// Enhanced route hash generation
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

// Enhanced capacity check
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

// Enhanced driver capacity update
const updateDriverCapacity = async (db, driverId, passengerCount, operation = 'add') => {
  try {
    // Update active_searches collection
    const activeSearchQuery = await db.collection('active_searches')
      .where('driverId', '==', driverId)
      .where('isActive', '==', true)
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

    // Also update drivers collection
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

// Calculate optimal pickup point along driver's route
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

// Find closest point on a line segment to a given point
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

// Calculate detour distance for driver
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

// Calculate total distance of a route
const calculateRouteDistance = (route) => {
  if (!route || route.length < 2) return 0;
  
  let totalDistance = 0;
  for (let i = 0; i < route.length - 1; i++) {
    totalDistance += calculateDistance(route[i], route[i + 1]);
  }
  
  return totalDistance;
};

// Insert pickup and dropoff points into driver's route
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

// Find best index to insert a point in the route
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

// Cleanup function for old matches
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

// Cleanup expired sessions
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

// 🎯 TEST FUNCTION: Force create a match for testing
const forceCreateTestMatch = async (db, driverData, passengerData) => {
  try {
    console.log('🎯 FORCE CREATING TEST MATCH...');
    
    const driverId = driverData.driverId || driverData.id;
    const passengerId = passengerData.passengerId || passengerData.id;
    
    const timestamp = Date.now();
    const matchId = `test_match_${driverId}_${passengerId}_${timestamp}`;
    
    const matchData = {
      matchId,
      driverId,
      driverName: driverData.driverName || driverData.name || 'Test Driver',
      passengerId,
      passengerName: passengerData.passengerName || passengerData.name || 'Test Passenger',
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

// 🎯 NEW: Force matching function for immediate testing
const forceImmediateMatching = async (db, driverData, passengerData) => {
  console.log('🎯 FORCE IMMEDIATE MATCHING ACTIVATED!');
  
  try {
    // Create a test match immediately without any checks
    const timestamp = Date.now();
    const driverId = driverData.driverId || driverData.id;
    const passengerId = passengerData.passengerId || passengerData.id;
    const matchId = `force_match_${driverId}_${passengerId}_${timestamp}`;
    
    const matchData = {
      matchId,
      driverId,
      driverName: driverData.driverName || driverData.name || 'Test Driver',
      passengerId,
      passengerName: passengerData.passengerName || passengerData.name || 'Test Passenger',
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

// Export all functions
module.exports = {
  // Session management
  startMatchingSession,
  endMatchingSession,
  isMatchingSessionActive,
  getActiveSession,
  getAllActiveSessions,
  cleanupExpiredSessions,
  
  // Core matching functions
  performIntelligentMatching,
  createMatchIfNotExists,
  createActiveMatchForOverlay,
  checkExistingMatch,
  shouldThrottleMatch,
  createMatchNotifications,
  forceCreateTestMatch,
  forceImmediateMatching, // 🎯 NEW: Force matching function
  
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
