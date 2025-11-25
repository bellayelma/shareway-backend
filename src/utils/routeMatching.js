// utils/routeMatching.js
const admin = require('firebase-admin');

// Duplicate prevention cache
const matchCooldown = new Map();
const COOLDOWN_PERIOD = 2 * 60 * 1000; // 2 minutes cooldown

// Check for existing matches to prevent duplicates
const checkExistingMatch = async (db, driverId, passengerId, maxAgeMinutes = 5) => {
  try {
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

// Check if match should be throttled
const shouldThrottleMatch = (driverId, passengerId) => {
  const key = `${driverId}_${passengerId}`;
  const now = Date.now();
  const lastMatchTime = matchCooldown.get(key);
  
  if (lastMatchTime && (now - lastMatchTime) < COOLDOWN_PERIOD) {
    return true;
  }
  
  // Update the cooldown timestamp
  matchCooldown.set(key, now);
  
  // Clean up old entries periodically
  if (matchCooldown.size > 1000) {
    for (const [key, timestamp] of matchCooldown.entries()) {
      if (now - timestamp > COOLDOWN_PERIOD * 2) {
        matchCooldown.delete(key);
      }
    }
  }
  
  return false;
};

// Enhanced matching function with duplicate prevention
const createMatchIfNotExists = async (db, driverData, passengerData, similarityScore, matchQuality) => {
  try {
    const driverId = driverData.driverId || driverData.id;
    const passengerId = passengerData.passengerId || passengerData.id;
    
    if (!driverId || !passengerId) {
      console.error('❌ Missing driverId or passengerId');
      return null;
    }

    // Check cooldown first (in-memory cache for performance)
    if (shouldThrottleMatch(driverId, passengerId)) {
      console.log(`⏸️ Match throttled: ${driverId} + ${passengerId}`);
      return null;
    }

    // Check Firestore for existing matches
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
      passengerData.destination
    );

    const matchData = {
      matchId,
      driverId,
      driverName: driverData.driverName || driverData.name || 'Unknown Driver',
      passengerId,
      passengerName: passengerData.passengerName || passengerData.name || 'Unknown Passenger',
      similarityScore: Math.round(similarityScore * 100) / 100,
      matchQuality,
      status: 'proposed',
      detourDistance,
      optimalPickupPoint: optimalPickup,
      timestamp: new Date(timestamp).toISOString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      notificationSent: false,
      notifiedAt: null
    };

    await db.collection('potential_matches').doc(matchId).set(matchData);
    console.log(`✅ Created new match: ${matchId} (score: ${similarityScore.toFixed(2)})`);
    
    return matchData;
    
  } catch (error) {
    console.error('❌ Error creating match:', error);
    return null;
  }
};

// Main matching function with duplicate prevention
const performIntelligentMatching = async (db, driver, passenger, options = {}) => {
  try {
    const {
      similarityThreshold = 0.3,
      maxDetourDistance = 5.0,
      checkCapacity = true
    } = options;

    // Basic validation
    if (!driver || !passenger) {
      console.log('❌ Missing driver or passenger data');
      return null;
    }

    if (!driver.routePoints || !passenger.routePoints) {
      console.log('❌ Missing route points');
      return null;
    }

    // Check capacity
    if (checkCapacity && !hasCapacity(driver, passenger.passengerCount || 1)) {
      console.log(`❌ No capacity: ${driver.driverId}`);
      return null;
    }

    // Calculate similarity
    const similarityScore = calculateRouteSimilarity(
      passenger.routePoints, 
      driver.routePoints,
      { maxDistanceThreshold: maxDetourDistance }
    );

    if (similarityScore < similarityThreshold) {
      console.log(`📉 Low similarity: ${similarityScore.toFixed(2)} for ${driver.driverId}`);
      return null;
    }

    // Determine match quality
    let matchQuality = 'fair';
    if (similarityScore >= 0.7) matchQuality = 'excellent';
    else if (similarityScore >= 0.5) matchQuality = 'good';
    else if (similarityScore >= 0.3) matchQuality = 'fair';

    // Create match with duplicate prevention
    const match = await createMatchIfNotExists(db, driver, passenger, similarityScore, matchQuality);
    
    return match;

  } catch (error) {
    console.error('❌ Error in intelligent matching:', error);
    return null;
  }
};

// Calculate route similarity with enhanced algorithm
const calculateRouteSimilarity = (passengerRoute, driverRoute, options = {}) => {
  try {
    if (!passengerRoute || !driverRoute || !Array.isArray(passengerRoute) || !Array.isArray(driverRoute)) {
      return 0;
    }
    
    if (passengerRoute.length === 0 || driverRoute.length === 0) return 0;

    const {
      similarityThreshold = 0.001,
      maxDistanceThreshold = 2.0, // km
      useHausdorffDistance = true
    } = options;

    // Method 1: Direct point-to-point comparison (for exact routes)
    const directSimilarity = calculateDirectSimilarity(passengerRoute, driverRoute, similarityThreshold);
    
    // Method 2: Hausdorff distance (for route shape similarity)
    const hausdorffSimilarity = useHausdorffDistance ? 
      calculateHausdorffSimilarity(passengerRoute, driverRoute, maxDistanceThreshold) : 0;
    
    // Method 3: Bounding box overlap (for general area similarity)
    const bboxSimilarity = calculateBoundingBoxSimilarity(passengerRoute, driverRoute);
    
    // Method 4: Start/end point proximity
    const endpointSimilarity = calculateEndpointSimilarity(passengerRoute, driverRoute, maxDistanceThreshold);
    
    // Weighted combination of different similarity measures
    const weights = {
      direct: 0.3,
      hausdorff: 0.4,
      bbox: 0.1,
      endpoints: 0.2
    };
    
    const totalSimilarity = 
      (directSimilarity * weights.direct) +
      (hausdorffSimilarity * weights.hausdorff) +
      (bboxSimilarity * weights.bbox) +
      (endpointSimilarity * weights.endpoints);
    
    return Math.min(1, Math.max(0, totalSimilarity));
    
  } catch (error) {
    console.error('❌ Error calculating route similarity:', error);
    return 0;
  }
};

// Direct point-to-point similarity
const calculateDirectSimilarity = (route1, route2, threshold = 0.001) => {
  const minPoints = Math.min(route1.length, route2.length);
  if (minPoints === 0) return 0;
  
  let matchingPoints = 0;
  for (let i = 0; i < minPoints; i++) {
    if (isPointSimilar(route1[i], route2[i], threshold)) {
      matchingPoints++;
    }
  }
  
  return matchingPoints / Math.max(route1.length, route2.length);
};

// Hausdorff distance for route shape similarity
const calculateHausdorffSimilarity = (route1, route2, maxDistanceThreshold = 2.0) => {
  try {
    const distance1to2 = calculateDirectedHausdorffDistance(route1, route2);
    const distance2to1 = calculateDirectedHausdorffDistance(route2, route1);
    const hausdorffDistance = Math.max(distance1to2, distance2to1);
    
    // Convert distance to similarity (closer distance = higher similarity)
    return Math.max(0, 1 - (hausdorffDistance / maxDistanceThreshold));
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
    
    // Calculate intersection area
    const intersection = {
      minLat: Math.max(bbox1.minLat, bbox2.minLat),
      maxLat: Math.min(bbox1.maxLat, bbox2.maxLat),
      minLng: Math.max(bbox1.minLng, bbox2.minLng),
      maxLng: Math.min(bbox1.maxLng, bbox2.maxLng)
    };
    
    // Check if there's no intersection
    if (intersection.minLat > intersection.maxLat || intersection.minLng > intersection.maxLng) {
      return 0;
    }
    
    const area1 = (bbox1.maxLat - bbox1.minLat) * (bbox1.maxLng - bbox1.minLng);
    const area2 = (bbox2.maxLat - bbox2.minLat) * (bbox2.maxLng - bbox2.minLng);
    const intersectionArea = (intersection.maxLat - intersection.minLat) * (intersection.maxLng - intersection.minLng);
    
    // Use Jaccard similarity (intersection over union)
    const unionArea = area1 + area2 - intersectionArea;
    return intersectionArea / unionArea;
    
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

// Endpoint similarity (pickup and destination proximity)
const calculateEndpointSimilarity = (passengerRoute, driverRoute, maxDistanceThreshold = 2.0) => {
  try {
    if (passengerRoute.length === 0 || driverRoute.length === 0) return 0;
    
    const passengerStart = passengerRoute[0];
    const passengerEnd = passengerRoute[passengerRoute.length - 1];
    const driverStart = driverRoute[0];
    const driverEnd = driverRoute[driverRoute.length - 1];
    
    const startDistance = calculateDistance(passengerStart, driverStart);
    const endDistance = calculateDistance(passengerEnd, driverEnd);
    
    const startSimilarity = Math.max(0, 1 - (startDistance / maxDistanceThreshold));
    const endSimilarity = Math.max(0, 1 - (endDistance / maxDistanceThreshold));
    
    // Average of start and end similarity
    return (startSimilarity + endSimilarity) / 2;
    
  } catch (error) {
    console.error('Error calculating endpoint similarity:', error);
    return 0;
  }
};

// Enhanced location along route check
const isLocationAlongRoute = (location, routePoints, maxDistance = 0.5, options = {}) => {
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
    
    // Check segment proximity (location near route segments, not just points)
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
    
    // Check if location is near route start/end points with different threshold
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
  
  const dx = point.lat - xx;
  const dy = point.lng - yy;
  
  return calculateDistance({ lat: point.lat, lng: point.lng }, { lat: xx, lng: yy });
};

// Enhanced point similarity check
const isPointSimilar = (point1, point2, threshold = 0.001) => {
  if (!point1 || !point2) return false;
  if (typeof point1.lat === 'undefined' || typeof point2.lat === 'undefined') return false;
  
  const latDiff = Math.abs(point1.lat - point2.lat);
  const lngDiff = Math.abs(point1.lng - point2.lng);
  return latDiff < threshold && lngDiff < threshold;
};

// Calculate distance between two points (Haversine formula) - ENHANCED
const calculateDistance = (point1, point2) => {
  try {
    if (!point1 || !point2) return Infinity;
    if (typeof point1.lat === 'undefined' || typeof point2.lat === 'undefined') return Infinity;
    
    const R = 6371; // Earth's radius in kilometers
    const dLat = (point2.lat - point1.lat) * Math.PI / 180;
    const dLng = (point2.lng - point1.lng) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(point1.lat * Math.PI / 180) * Math.cos(point2.lat * Math.PI / 180) *
      Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const distance = R * c;
    
    return Math.round(distance * 1000) / 1000; // Round to 3 decimal places
    
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
    
    // Create a consistent hash regardless of direction
    const coordinates = [
      `${pickupLat},${pickupLng}`,
      `${destLat},${destLng}`
    ].sort(); // Sort to ensure same hash for A→B and B→A
    
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
const findOptimalPickupPoint = (passengerLocation, driverRoute, maxWalkDistance = 0.5) => {
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
    
    // Create new route with pickup and dropoff points
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

module.exports = {
  // Core matching functions
  performIntelligentMatching,
  createMatchIfNotExists,
  checkExistingMatch,
  shouldThrottleMatch,
  
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
  cleanupOldMatches
};
