// src/app.js - MODIFIED WITH DEDICATED FIRESTORE SCHEDULED ROUTES COLLECTION
const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, '../.env') });

// Import route matching utilities
const routeMatching = require("./utils/routeMatching");
// Import WebSocket Server
const WebSocketServer = require("./websocketServer");

const app = express();

// Basic CORS configuration
app.use(cors({
  origin: true,
  credentials: true
}));

// Body parsing middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ========== ENHANCED REQUEST LOGGING MIDDLEWARE ==========
app.use((req, res, next) => {
  console.log(`🔍 ${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  if (Object.keys(req.body).length > 0 && req.method === 'POST') {
    console.log('📦 Request body keys:', Object.keys(req.body));
    if (req.originalUrl.includes('/api/match/')) {
      console.log('🔎 SEARCH DEBUG - UserType:', req.body.userType);
      console.log('🔎 SEARCH DEBUG - RideType:', req.body.rideType);
      console.log('🔎 SEARCH DEBUG - ScheduledTime:', req.body.scheduledTime);
    }
  }
  next();
});

// ========== TEST MODE CONFIGURATION ==========
const TEST_MODE = true;
const TEST_MATCHING_INTERVAL = 5000;
const UNLIMITED_CAPACITY = true;

// ========== FIRESTORE COLLECTION NAMES ==========
const SCHEDULED_ROUTES_COLLECTION = 'scheduled_routes';
const ACTIVE_MATCHES_COLLECTION = 'active_matches';
const NOTIFICATIONS_COLLECTION = 'notifications';

// Initialize Firebase Admin
let db;
try {
  if (!process.env.FIREBASE_KEY) {
    throw new Error('FIREBASE_KEY environment variable is not set');
  }

  const firebaseConfig = JSON.parse(process.env.FIREBASE_KEY);
  
  if (firebaseConfig.private_key && typeof firebaseConfig.private_key === 'string') {
    firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, '\n');
  }

  admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });

  db = admin.firestore();
  db.settings({ ignoreUndefinedProperties: true });
  
  console.log('✅ Firebase Admin initialized');
  
} catch (error) {
  console.error('❌ Firebase Admin initialization failed:', error.message);
  process.exit(1);
}

// ========== WEB SOCKET SERVER ==========
let websocketServer;

const setupWebSocket = (server) => {
  websocketServer = new WebSocketServer(server);
  console.log('✅ WebSocket server initialized');
};

// ========== OPTIMIZED MATCHING SYSTEM ==========

// In-memory storage for ACTIVE searches only (immediate matching)
const activeSearches = new Map();
const processedMatches = new Map();
const searchTimeouts = new Map();
const userMatches = new Map();

// Timeout constants
const IMMEDIATE_SEARCH_TIMEOUT = 5 * 60 * 1000;
const SCHEDULED_SEARCH_CHECK_INTERVAL = 10000;
const MAX_MATCH_AGE = 300000;

// ========== DEDICATED FIRESTORE SCHEDULED ROUTES MANAGEMENT ==========

// 🎯 Save driver scheduled route to Firestore collection
const saveScheduledRouteToFirestore = async (routeData) => {
  try {
    const routeId = routeData.routeId || `scheduled_route_${routeData.userId}_${Date.now()}`;
    
    const scheduledRoute = {
      routeId: routeId,
      userId: routeData.userId,
      userType: 'driver',
      driverName: routeData.driverName || 'Unknown Driver',
      pickupLocation: routeData.pickupLocation,
      destinationLocation: routeData.destinationLocation,
      pickupName: routeData.pickupName || 'Unknown Pickup',
      destinationName: routeData.destinationName || 'Unknown Destination',
      routePoints: routeData.routePoints || [],
      passengerCount: routeData.passengerCount || 0,
      capacity: routeData.capacity || 4,
      vehicleType: routeData.vehicleType || 'car',
      scheduledTime: admin.firestore.Timestamp.fromDate(new Date(routeData.scheduledTime)),
      status: 'scheduled', // scheduled, active, completed, cancelled
      activateImmediately: routeData.activateImmediately || TEST_MODE,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection(SCHEDULED_ROUTES_COLLECTION).doc(routeId).set(scheduledRoute);
    
    console.log(`💾 Saved scheduled route to Firestore: ${routeData.driverName}`);
    console.log(`   - Route ID: ${routeId}`);
    console.log(`   - Scheduled: ${routeData.scheduledTime}`);
    console.log(`   - Collection: ${SCHEDULED_ROUTES_COLLECTION}`);
    
    return scheduledRoute;
  } catch (error) {
    console.error('❌ Error saving scheduled route to Firestore:', error);
    throw error;
  }
};

// 🎯 Get scheduled route from Firestore by userId
const getScheduledRouteFromFirestore = async (userId) => {
  try {
    console.log(`🔍 Reading scheduled route from Firestore for user: ${userId}`);
    
    const snapshot = await db.collection(SCHEDULED_ROUTES_COLLECTION)
      .where('userId', '==', userId)
      .where('status', 'in', ['scheduled', 'active'])
      .orderBy('scheduledTime', 'desc')
      .limit(1)
      .get();

    if (snapshot.empty) {
      console.log(`📭 No scheduled route found in Firestore for user: ${userId}`);
      return null;
    }

    const routeData = snapshot.docs[0].data();
    console.log(`✅ Found scheduled route in Firestore: ${routeData.routeId}`);
    
    return {
      ...routeData,
      scheduledTime: routeData.scheduledTime.toDate(),
      source: 'firestore'
    };
  } catch (error) {
    console.error('❌ Error reading scheduled route from Firestore:', error);
    return null;
  }
};

// 🎯 Update scheduled route status in Firestore
const updateScheduledRouteStatus = async (routeId, newStatus) => {
  try {
    await db.collection(SCHEDULED_ROUTES_COLLECTION).doc(routeId).update({
      status: newStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`🔄 Updated scheduled route status: ${routeId} -> ${newStatus}`);
    return true;
  } catch (error) {
    console.error('❌ Error updating scheduled route status:', error);
    return false;
  }
};

// 🎯 Get all active scheduled routes from Firestore (for matching)
const getActiveScheduledRoutesFromFirestore = async () => {
  try {
    const now = new Date();
    const snapshot = await db.collection(SCHEDULED_ROUTES_COLLECTION)
      .where('status', '==', 'active')
      .where('scheduledTime', '>=', admin.firestore.Timestamp.fromDate(now))
      .get();

    const activeRoutes = [];
    snapshot.forEach(doc => {
      const routeData = doc.data();
      activeRoutes.push({
        ...routeData,
        scheduledTime: routeData.scheduledTime.toDate(),
        documentId: doc.id
      });
    });

    console.log(`📊 Found ${activeRoutes.length} active scheduled routes in Firestore`);
    return activeRoutes;
  } catch (error) {
    console.error('❌ Error getting active scheduled routes:', error);
    return [];
  }
};

// 🎯 Check and activate scheduled routes (runs periodically)
const checkScheduledRoutesActivation = async () => {
  try {
    console.log(`\n🕒 Checking scheduled routes activation...`);
    
    const now = new Date();
    const activationTime = new Date(now.getTime() + (30 * 60 * 1000)); // 30 minutes from now
    
    const snapshot = await db.collection(SCHEDULED_ROUTES_COLLECTION)
      .where('status', '==', 'scheduled')
      .where('scheduledTime', '<=', admin.firestore.Timestamp.fromDate(activationTime))
      .get();

    let activatedCount = 0;
    
    snapshot.forEach(async (doc) => {
      const routeData = doc.data();
      const scheduledTime = routeData.scheduledTime.toDate();
      
      console.log(`   - ${routeData.driverName}:`);
      console.log(`     Scheduled: ${scheduledTime.toISOString()}`);
      console.log(`     Time until ride: ${Math.round((scheduledTime - now) / 60000)}min`);
      
      // Activate the route
      await doc.ref.update({
        status: 'active',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      activatedCount++;
      console.log(`     ✅ ACTIVATED: Route is now active for matching`);
      
      // Notify driver via WebSocket
      if (websocketServer) {
        websocketServer.sendScheduledSearchActivated(routeData.userId, {
          routeId: routeData.routeId,
          scheduledTime: scheduledTime.toISOString(),
          message: 'Your scheduled route is now active and searching for passengers!'
        });
      }
    });

    if (activatedCount > 0) {
      console.log(`🎯 Activated ${activatedCount} scheduled routes`);
    } else {
      console.log(`⏳ No scheduled routes ready for activation yet`);
    }
    
    return activatedCount;
  } catch (error) {
    console.error('❌ Error checking scheduled routes activation:', error);
    return 0;
  }
};

// Clean old data from memory
setInterval(() => {
  const now = Date.now();
  
  // Clean processed matches
  for (const [key, timestamp] of processedMatches.entries()) {
    if (now - timestamp > MAX_MATCH_AGE) {
      processedMatches.delete(key);
    }
  }
  
  // Clean expired search timeouts
  for (const [userId, timeout] of searchTimeouts.entries()) {
    if (timeout.expiresAt && now > timeout.expiresAt) {
      searchTimeouts.delete(userId);
    }
  }
}, 60000);

// Generate match key for deduplication
const generateMatchKey = (driverId, passengerId, timestamp = Date.now()) => {
  const timeWindow = Math.floor(timestamp / 30000);
  return `${driverId}_${passengerId}_${timeWindow}`;
};

// ========== STOP SEARCHING AFTER MATCH FUNCTIONS ==========

// Stop search for a user and clean up
const stopUserSearch = (userId) => {
  try {
    console.log(`🛑 Stopping search for user: ${userId}`);
    
    // Clear timeout first
    clearSearchTimeout(userId);
    
    // Remove from active searches
    if (activeSearches.has(userId)) {
      const search = activeSearches.get(userId);
      activeSearches.delete(userId);
      console.log(`✅ Stopped search for ${search.driverName || search.passengerName}`);
      
      // Notify user via WebSocket
      if (websocketServer) {
        websocketServer.sendSearchStopped(userId, {
          searchId: search.searchId,
          rideType: search.rideType,
          reason: 'match_found',
          message: 'Search stopped - match found!'
        });
      }
    }
    
    return true;
  } catch (error) {
    console.error('❌ Error stopping user search:', error);
    return false;
  }
};

// Track match for a user
const trackUserMatch = (userId, matchId, matchedUserId) => {
  if (!userMatches.has(userId)) {
    userMatches.set(userId, new Set());
  }
  userMatches.get(userId).add(matchId);
  console.log(`📝 Tracked match ${matchId} for user ${userId}`);
};

// Check if user should stop searching
const shouldStopSearching = (userId, userType) => {
  if (UNLIMITED_CAPACITY && userType === 'driver') {
    console.log(`🎯 UNLIMITED CAPACITY: Driver ${userId} can accept unlimited passengers`);
    return false;
  }
  
  if (userType === 'passenger') {
    return true;
  }
  
  if (userType === 'driver') {
    const search = activeSearches.get(userId);
    if (search) {
      const capacity = search.capacity || 4;
      const currentMatches = userMatches.get(userId)?.size || 0;
      const shouldStop = currentMatches >= capacity;
      if (shouldStop) {
        console.log(`🚗 Driver ${search.driverName} reached capacity: ${currentMatches}/${capacity}`);
      }
      return shouldStop;
    }
  }
  
  return false;
};

// ========== WEB SOCKET CONNECTION HELPER ==========

const waitForWebSocketConnection = (userId, maxWaitTime = 5000) => {
  return new Promise((resolve) => {
    if (!websocketServer) {
      console.log('❌ WebSocket server not available');
      return resolve(false);
    }

    const startTime = Date.now();
    
    const checkConnection = () => {
      const isConnected = websocketServer.isUserConnected(userId);
      
      if (isConnected) {
        console.log(`✅ WebSocket connection confirmed for ${userId}`);
        resolve(true);
        return;
      }
      
      const elapsed = Date.now() - startTime;
      if (elapsed > maxWaitTime) {
        console.log(`⏰ WebSocket connection timeout for ${userId}`);
        resolve(false);
        return;
      }
      
      setTimeout(checkConnection, 100);
    };
    
    checkConnection();
  });
};

// ========== SEARCH TIMEOUT MANAGEMENT ==========

const setImmediateSearchTimeout = (userId, searchId) => {
  const timeoutId = setTimeout(() => {
    console.log(`⏰ IMMEDIATE SEARCH TIMEOUT: Auto-stopping search for user ${userId}`);
    
    if (activeSearches.has(userId)) {
      const search = activeSearches.get(userId);
      activeSearches.delete(userId);
      
      if (websocketServer) {
        websocketServer.sendSearchTimeout(userId, {
          searchId: searchId,
          message: 'Search automatically stopped after 5 minutes',
          duration: '5 minutes',
          rideType: 'immediate'
        });
      }
      
      console.log(`🛑 Auto-stopped immediate search: ${search.driverName || search.passengerName}`);
    }
    
    searchTimeouts.delete(userId);
    
  }, IMMEDIATE_SEARCH_TIMEOUT);

  searchTimeouts.set(userId, {
    timeoutId: timeoutId,
    searchId: searchId,
    type: 'immediate',
    startedAt: Date.now(),
    expiresAt: Date.now() + IMMEDIATE_SEARCH_TIMEOUT
  });

  console.log(`⏰ Set 5-minute timeout for immediate search: ${userId}`);
};

const clearSearchTimeout = (userId) => {
  if (searchTimeouts.has(userId)) {
    const timeout = searchTimeouts.get(userId);
    clearTimeout(timeout.timeoutId);
    searchTimeouts.delete(userId);
    console.log(`🧹 Cleared timeout for user: ${userId}`);
  }
};

// ========== MATCH CREATION WITH AUTO-STOP ==========

const storeMatchInFirestore = async (matchData) => {
  try {
    const activeMatchData = {
      matchId: matchData.matchId,
      driverId: matchData.driverId,
      driverName: matchData.driverName,
      passengerId: matchData.passengerId,
      passengerName: matchData.passengerName,
      similarityScore: matchData.similarityScore,
      pickupName: matchData.pickupName || 'Unknown',
      destinationName: matchData.destinationName || 'Unknown',
      pickupLocation: matchData.pickupLocation,
      destinationLocation: matchData.destinationLocation,
      rideType: matchData.rideType || 'immediate',
      scheduledTime: matchData.scheduledTime,
      overlayTriggered: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection(ACTIVE_MATCHES_COLLECTION).doc(matchData.matchId).set(activeMatchData);
    console.log(`✅ Match stored in Firestore: ${matchData.driverName} ↔ ${matchData.passengerName}`);
    return true;
    
  } catch (error) {
    console.error('❌ Error storing match in Firestore:', error);
    return false;
  }
};

const createActiveMatchForOverlay = async (matchData) => {
  try {
    // 🎯 ESSENTIAL: Log ONLY what driver data passenger receives
    console.log('\n🎯 ==== DRIVER DATA PASSENGER RECEIVES ====');
    console.log('📱 Driver ID:', matchData.driverId);
    console.log('👤 Driver Name:', matchData.driverName);
    console.log('📞 Phone:', matchData.driverProfile?.phoneNumber || 'NOT AVAILABLE');
    console.log('📧 Email:', matchData.driverProfile?.email || 'NOT AVAILABLE');
    console.log('⭐ Rating:', matchData.driverProfile?.rating || 'NOT AVAILABLE');
    console.log('🚗 Vehicle:', matchData.driverProfile?.vehicleDetails || 'NOT AVAILABLE');
    console.log('🛞 Total Rides:', matchData.driverProfile?.totalRides || 'NOT AVAILABLE');
    console.log('🖼️ Profile Pic:', matchData.driverProfile?.profilePicture || 'NOT AVAILABLE');
    
    // 🎯 Log the ACTUAL match data structure
    console.log('\n📦 ACTUAL MATCH DATA SENT:');
    console.log(JSON.stringify({
      driverId: matchData.driverId,
      driverName: matchData.driverName,
      driverProfile: matchData.driverProfile || 'NO PROFILE DATA'
    }, null, 2));

    if (websocketServer) {
      const result = websocketServer.sendMatchToUsers(matchData);
      
      if (result.driverSent || result.passengerSent) {
        console.log(`✅ Match sent to Flutter apps via WebSocket: ${matchData.driverName} ↔ ${matchData.passengerName}`);
        
        trackUserMatch(matchData.driverId, matchData.matchId, matchData.passengerId);
        trackUserMatch(matchData.passengerId, matchData.matchId, matchData.driverId);
        
        const driverSearch = activeSearches.get(matchData.driverId);
        const passengerSearch = activeSearches.get(matchData.passengerId);
        
        if (driverSearch && shouldStopSearching(matchData.driverId, 'driver')) {
          console.log(`🚗 Stopping driver search: ${matchData.driverName} found enough passengers`);
          stopUserSearch(matchData.driverId);
        }
        
        if (passengerSearch && shouldStopSearching(matchData.passengerId, 'passenger')) {
          console.log(`👤 Stopping passenger search: ${matchData.passengerName} found a driver`);
          stopUserSearch(matchData.passengerId);
        }
        
        setTimeout(() => {
          storeMatchInFirestore(matchData).catch(console.error);
        }, 1000);
        
        return true;
      } else {
        console.log(`⚠️ Both users offline, storing in Firestore as backup`);
        return await storeMatchInFirestore(matchData);
      }
    } else {
      console.log('⚠️ WebSocket not available, using Firestore fallback');
      return await storeMatchInFirestore(matchData);
    }
    
  } catch (error) {
    console.error('❌ Error creating overlay match:', error);
    return false;
  }
};

// ========== ENHANCED SEARCH STORAGE WITH FIRESTORE INTEGRATION ==========

const storeSearchInMemory = async (searchData) => {
  const { userId, userType, rideType = 'immediate', activateImmediately = TEST_MODE } = searchData;
  
  if (!userId) throw new Error('userId is required');

  const actualUserType = userType || (searchData.driverId ? 'driver' : 'passenger');
  const driverName = searchData.driverName || 'Unknown Driver';
  const passengerName = searchData.passengerName || 'Unknown Passenger';

  const enhancedSearchData = {
    userId: userId,
    userType: actualUserType,
    driverName: driverName,
    passengerName: passengerName,
    pickupLocation: searchData.pickupLocation || {},
    destinationLocation: searchData.destinationLocation || {},
    pickupName: searchData.pickupName || 'Unknown Pickup',
    destinationName: searchData.destinationName || 'Unknown Destination',
    routePoints: searchData.routePoints || [],
    passengerCount: searchData.passengerCount || 1,
    capacity: searchData.capacity || 4,
    vehicleType: searchData.vehicleType || 'car',
    rideType: rideType,
    scheduledTime: searchData.scheduledTime,
    searchId: searchData.searchId || `${rideType}_${userId}_${Date.now()}`,
    status: 'searching',
    lastUpdated: Date.now(),
    createdAt: searchData.createdAt || new Date().toISOString(),
    activateImmediately: activateImmediately
  };

  // 🎯 SCHEDULED SEARCH: Save to Firestore collection
  if (rideType === 'scheduled' && actualUserType === 'driver') {
    try {
      const savedRoute = await saveScheduledRouteToFirestore({
        ...enhancedSearchData,
        activateImmediately: activateImmediately
      });
      
      console.log(`📅 SCHEDULED ROUTE saved to Firestore: ${driverName}`);
      
      // If activating immediately, also store in memory for immediate matching
      if (activateImmediately) {
        activeSearches.set(userId, enhancedSearchData);
        console.log(`🎯 Scheduled route ACTIVATED IMMEDIATELY for matching`);
        setImmediateSearchTimeout(userId, enhancedSearchData.searchId);
      }
      
    } catch (error) {
      console.error('❌ Error saving scheduled route:', error);
      throw error;
    }
  } else {
    // IMMEDIATE SEARCH: Store in memory only
    activeSearches.set(userId, enhancedSearchData);
    
    if (rideType === 'scheduled') {
      console.log(`🎯 SCHEDULED search ACTIVATED IMMEDIATELY: ${driverName || passengerName}`);
    } else {
      console.log(`🎯 IMMEDIATE search stored: ${driverName || passengerName}`);
    }
    
    setImmediateSearchTimeout(userId, enhancedSearchData.searchId);
  }

  // WebSocket notifications
  const isConnected = await waitForWebSocketConnection(userId);
  if (websocketServer && isConnected) {
    const sent = websocketServer.sendSearchStarted(userId, enhancedSearchData);
    console.log(`📤 WebSocket search notification: ${sent}`);
    
    if (rideType === 'scheduled') {
      websocketServer.sendSearchStatusUpdate(userId, {
        searchId: enhancedSearchData.searchId,
        status: enhancedSearchData.status,
        rideType: 'scheduled',
        scheduledTime: searchData.scheduledTime,
        pickupName: enhancedSearchData.pickupName,
        destinationName: enhancedSearchData.destinationName,
        activatedImmediately: activateImmediately,
        storage: rideType === 'scheduled' && actualUserType === 'driver' ? 'Firestore Collection' : 'Memory',
        matchingStatus: activateImmediately ? 'Starting immediately' : 'Will start 30 minutes before scheduled time',
        autoStop: 'Will stop when match found'
      });
    }
  }
  
  // Debug stats
  const currentDrivers = Array.from(activeSearches.values()).filter(s => s.userType === 'driver');
  const currentPassengers = Array.from(activeSearches.values()).filter(s => s.userType === 'passenger');
  
  console.log(`📊 Memory Stats - Active: ${activeSearches.size} (D:${currentDrivers.length} P:${currentPassengers.length})`);
  console.log(`⏰ Active Timeouts: ${searchTimeouts.size}`);
  console.log(`🎯 User Matches: ${userMatches.size} users with matches`);
  console.log(`🧪 TEST MODE: ${TEST_MODE ? 'ACTIVE' : 'INACTIVE'}`);
  console.log(`🎯 UNLIMITED CAPACITY: ${UNLIMITED_CAPACITY ? 'ACTIVE' : 'INACTIVE'}`);
  console.log(`💾 SCHEDULED ROUTES: Stored in Firestore collection: ${SCHEDULED_ROUTES_COLLECTION}`);
  
  return enhancedSearchData;
};

// ========== SCHEDULED ROUTES ENDPOINT ==========

app.post("/api/match/scheduled-route", async (req, res) => {
  try {
    console.log('📅 === SCHEDULED ROUTE ENDPOINT CALLED ===');
    
    const { 
      userId, 
      driverId,
      driverName,
      pickupLocation,
      destinationLocation,
      pickupName,
      destinationName,
      routePoints,
      capacity,
      passengerCount,
      scheduledTime,
      vehicleType,
      activateImmediately = TEST_MODE
    } = req.body;
    
    const actualUserId = userId || driverId;
    
    if (!actualUserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId or driverId is required' 
      });
    }

    if (!scheduledTime) {
      return res.status(400).json({ 
        success: false, 
        error: 'scheduledTime is required for scheduled routes' 
      });
    }

    // 🎯 Save scheduled route to dedicated Firestore collection
    const routeData = {
      userId: actualUserId,
      driverName: driverName,
      pickupLocation: pickupLocation,
      destinationLocation: destinationLocation,
      pickupName: pickupName,
      destinationName: destinationName,
      routePoints: routePoints,
      capacity: capacity,
      passengerCount: passengerCount,
      scheduledTime: scheduledTime,
      vehicleType: vehicleType,
      activateImmediately: activateImmediately
    };

    const savedRoute = await saveScheduledRouteToFirestore(routeData);

    let immediateSearchData = null;
    
    // If activating immediately, also create immediate search
    if (activateImmediately) {
      immediateSearchData = {
        userId: actualUserId,
        userType: 'driver',
        driverName: driverName,
        pickupLocation: pickupLocation,
        destinationLocation: destinationLocation,
        pickupName: pickupName,
        destinationName: destinationName,
        routePoints: routePoints,
        capacity: capacity,
        passengerCount: passengerCount,
        rideType: 'scheduled',
        scheduledTime: scheduledTime,
        vehicleType: vehicleType,
        activateImmediately: true
      };

      await storeSearchInMemory(immediateSearchData);
    }

    res.json({
      success: true,
      message: activateImmediately ? 
        'Scheduled route created and ACTIVATED IMMEDIATELY!' : 
        'Scheduled route created successfully',
      routeId: savedRoute.routeId,
      userId: actualUserId,
      scheduledTime: scheduledTime,
      status: activateImmediately ? 'active' : 'scheduled',
      activationTime: activateImmediately ? 'IMMEDIATELY' : '30 minutes before scheduled time',
      storage: 'Firestore Collection: scheduled_routes',
      immediateSearch: activateImmediately ? 'Created' : 'Not created',
      testMode: TEST_MODE,
      unlimitedCapacity: UNLIMITED_CAPACITY
    });
    
  } catch (error) {
    console.error('❌ Error creating scheduled route:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== GET SCHEDULED ROUTE STATUS ENDPOINT ==========

app.get("/api/match/scheduled-route/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    
    console.log(`🔍 Checking scheduled route from Firestore for: ${userId}`);
    
    const route = await getScheduledRouteFromFirestore(userId);
    
    if (!route) {
      return res.json({
        success: true,
        exists: false,
        message: 'No scheduled route found',
        userId: userId
      });
    }

    const now = new Date();
    const timeUntilRide = route.scheduledTime.getTime() - now.getTime();
    
    res.json({
      success: true,
      exists: true,
      routeId: route.routeId,
      userId: route.userId,
      driverName: route.driverName,
      scheduledTime: route.scheduledTime.toISOString(),
      status: route.status,
      timeUntilRide: Math.round(timeUntilRide / 60000),
      pickupName: route.pickupName,
      destinationName: route.destinationName,
      capacity: route.capacity,
      storage: 'Firestore Collection',
      testMode: TEST_MODE,
      source: route.source
    });
    
  } catch (error) {
    console.error('❌ Error getting scheduled route:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== IMMEDIATE MATCH SEARCH ENDPOINT ==========

app.post("/api/match/search", async (req, res) => {
  try {
    console.log('🎯 === IMMEDIATE MATCH SEARCH ENDPOINT CALLED ===');
    
    const { 
      userId, 
      userType, 
      driverId,
      driverName,
      passengerName,
      pickupLocation,
      destinationLocation,
      pickupName,
      destinationName,
      routePoints,
      capacity,
      passengerCount,
      rideType = 'immediate',
      scheduledTime,
      searchId
    } = req.body;
    
    const actualUserId = userId || driverId;
    
    if (!actualUserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId or driverId is required' 
      });
    }

    // Clear any existing search
    if (activeSearches.has(actualUserId)) {
      console.log(`🔄 Clearing existing search for user: ${actualUserId}`);
      clearSearchTimeout(actualUserId);
      activeSearches.delete(actualUserId);
    }

    const searchData = {
      userId: actualUserId,
      userType: userType,
      driverName: driverName,
      passengerName: passengerName,
      pickupLocation: pickupLocation,
      destinationLocation: destinationLocation,
      pickupName: pickupName,
      destinationName: destinationName,
      routePoints: routePoints,
      capacity: capacity,
      passengerCount: passengerCount,
      rideType: rideType,
      scheduledTime: scheduledTime,
      searchId: searchId || `search_${actualUserId}_${Date.now()}`
    };

    await storeSearchInMemory(searchData);

    res.json({
      success: true,
      message: 'Immediate search started successfully',
      searchId: searchData.searchId,
      userId: actualUserId,
      rideType: rideType,
      timeout: '5 minutes (or until match found)',
      matches: [],
      matchCount: 0,
      storage: 'Memory only',
      websocketConnected: websocketServer ? websocketServer.isUserConnected(actualUserId) : false,
      testMode: TEST_MODE,
      unlimitedCapacity: UNLIMITED_CAPACITY,
      autoStop: UNLIMITED_CAPACITY ? 
        'Drivers: NEVER (unlimited mode) | Passengers: After first match' : 
        'Search will stop automatically when match is found'
    });
    
  } catch (error) {
    console.error('❌ Error in immediate match search:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== OPTIMIZED MATCHING SERVICE WITH FIRESTORE INTEGRATION ==========

const startOptimizedMatching = () => {
  console.log('🔄 Starting Optimized Matching Service...');
  console.log(`🧪 TEST MODE: ${TEST_MODE ? 'ACTIVE' : 'INACTIVE'}`);
  console.log(`🎯 UNLIMITED CAPACITY: ${UNLIMITED_CAPACITY ? 'ACTIVE' : 'INACTIVE'}`);
  console.log(`💾 STORAGE: Immediate searches → Memory | Scheduled routes → Firestore collection`);
  
  const matchingInterval = TEST_MODE ? TEST_MATCHING_INTERVAL : 30000;
  
  setInterval(async () => {
    try {
      console.log(`\n📊 ===== MATCHING CYCLE START =====`);
      console.log(`🧪 TEST MODE: ${TEST_MODE ? 'ACTIVE' : 'INACTIVE'}`);
      
      // 🎯 Check and activate scheduled routes from Firestore
      await checkScheduledRoutesActivation();

      // Get drivers from both memory and active scheduled routes
      const memoryDrivers = Array.from(activeSearches.values())
        .filter(search => search.userType === 'driver' && search.status === 'searching');
      
      const scheduledDrivers = await getActiveScheduledRoutesFromFirestore();
      
      const allDrivers = [...memoryDrivers, ...scheduledDrivers];
      const passengers = Array.from(activeSearches.values())
        .filter(search => search.userType === 'passenger' && search.status === 'searching');

      console.log(`📊 Matching: ${allDrivers.length} drivers (Memory: ${memoryDrivers.length}, Scheduled: ${scheduledDrivers.length}) vs ${passengers.length} passengers`);
      
      if (allDrivers.length === 0 || passengers.length === 0) {
        console.log(`💤 No matches possible`);
        console.log(`📊 ===== MATCHING CYCLE END =====\n`);
        return;
      }

      // Log search details
      console.log('🚗 Active Drivers:');
      allDrivers.forEach(driver => {
        const matchCount = userMatches.get(driver.userId)?.size || 0;
        const source = driver.documentId ? 'Firestore' : 'Memory';
        console.log(`   - ${driver.driverName} (${source}) - Matches: ${matchCount}/${UNLIMITED_CAPACITY ? '∞' : driver.capacity || 4}`);
      });

      console.log('👤 Active Passengers:');
      passengers.forEach(passenger => {
        const matchCount = userMatches.get(passenger.userId)?.size || 0;
        console.log(`   - ${passenger.passengerName} - Matches: ${matchCount}/1`);
      });
      
      let matchesCreated = 0;
      
      // Perform matching
      for (const driver of allDrivers) {
        if (!UNLIMITED_CAPACITY) {
          const driverMatchCount = userMatches.get(driver.userId)?.size || 0;
          if (driverMatchCount >= (driver.capacity || 4)) {
            console.log(`⏭️ Skipping driver ${driver.driverName} - reached capacity`);
            continue;
          }
        }
        
        for (const passenger of passengers) {
          const passengerMatchCount = userMatches.get(passenger.userId)?.size || 0;
          if (passengerMatchCount >= 1) {
            console.log(`⏭️ Skipping passenger ${passenger.passengerName} - already has match`);
            continue;
          }

          if (!driver.routePoints || driver.routePoints.length === 0) continue;
          if (!passenger.routePoints || passenger.routePoints.length === 0) continue;

          if (!UNLIMITED_CAPACITY) {
            const passengerCount = passenger.passengerCount || 1;
            const hasSeats = routeMatching.hasCapacity(driver, passengerCount);
            if (!hasSeats) continue;
          }

          const similarity = routeMatching.calculateRouteSimilarity(
            passenger.routePoints,
            driver.routePoints,
            { 
              similarityThreshold: 0.001, 
              maxDistanceThreshold: 50.0
            }
          );

          console.log(`🔍 ${driver.driverName} ↔ ${passenger.passengerName}: Score=${similarity.toFixed(3)}`);

          if (similarity > 0.01) {
            const matchKey = generateMatchKey(driver.userId, passenger.userId, Date.now());
            
            if (!processedMatches.has(matchKey)) {
              const matchData = {
                matchId: `match_${driver.userId}_${passenger.userId}_${Date.now()}`,
                driverId: driver.userId,
                driverName: driver.driverName || 'Unknown Driver',
                passengerId: passenger.userId,
                passengerName: passenger.passengerName || 'Unknown Passenger',
                similarityScore: similarity,
                pickupName: passenger.pickupName || driver.pickupName || 'Unknown Location',
                destinationName: passenger.destinationName || driver.destinationName || 'Unknown Destination',
                pickupLocation: passenger.pickupLocation || driver.pickupLocation,
                destinationLocation: passenger.destinationLocation || driver.destinationLocation,
                passengerCount: passenger.passengerCount || 1,
                capacity: driver.capacity || 4,
                vehicleType: driver.vehicleType || 'car',
                rideType: driver.rideType || passenger.rideType || 'immediate',
                scheduledTime: driver.scheduledTime || passenger.scheduledTime,
                timestamp: new Date().toISOString(),
                matchType: driver.documentId ? 'scheduled_route_match' : 'immediate_match',
                unlimitedMode: UNLIMITED_CAPACITY,
                source: driver.documentId ? 'Firestore' : 'Memory'
              };

              const matchCreated = await createActiveMatchForOverlay(matchData);
              
              if (matchCreated) {
                matchesCreated++;
                processedMatches.set(matchKey, Date.now());
                console.log(`🎉 MATCH CREATED: ${driver.driverName} ↔ ${passenger.passengerName}`);
                
                if (driver.documentId) {
                  console.log(`   📅 SCHEDULED ROUTE MATCH from Firestore!`);
                }
              }
            }
          }
        }
      }

      if (matchesCreated > 0) {
        console.log(`📱 Created ${matchesCreated} matches`);
      }
      
      console.log(`📊 ===== MATCHING CYCLE END =====\n`);
      
    } catch (error) {
      console.error('❌ Matching error:', error);
    }
  }, matchingInterval);

  // Check scheduled routes every 10 seconds
  setInterval(checkScheduledRoutesActivation, SCHEDULED_SEARCH_CHECK_INTERVAL);
};

// ========== ADDITIONAL ENDPOINTS ==========

// [Previous endpoints for stop-search, search-status, debug, etc. remain the same]
// ... (include all the previous endpoints like stop-search, search-status, debug, etc.)

// ========== START SERVER ==========

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 ShareWay DEDICATED FIRESTORE SCHEDULED ROUTES Server Started!
📍 Port: ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
🔥 Firebase: Hybrid Storage Mode
💾 Memory Cache: Immediate searches only
💾 Firestore: Scheduled routes collection
🔌 WebSocket: CONNECTION TIMING FIXED

🎯 STORAGE STRATEGY:
   - Immediate searches: Memory only (fast)
   - Scheduled driver routes: Firestore collection (persistent)
   - Cost optimization: Matching FREE, Persistence CHEAP

🧪 TEST MODE: ${TEST_MODE ? 'ACTIVE' : 'INACTIVE'}
🎯 UNLIMITED CAPACITY: ${UNLIMITED_CAPACITY ? 'ACTIVE 🚀' : 'INACTIVE'}

📊 Current Stats:
- Active Searches: ${activeSearches.size} (in memory)
- Processed Matches: ${processedMatches.size} (in memory)
- Active Timeouts: ${searchTimeouts.size} (in memory)
- Users with Matches: ${userMatches.size} (in memory)
- WebSocket Connections: ${websocketServer ? websocketServer.getConnectedCount() : 0}

💾 FIRESTORE COLLECTIONS:
- ${SCHEDULED_ROUTES_COLLECTION}: Driver scheduled routes
- ${ACTIVE_MATCHES_COLLECTION}: Active matches
- ${NOTIFICATIONS_COLLECTION}: User notifications

✅ SCHEDULED DRIVER ROUTES NOW STORED IN DEDICATED FIRESTORE COLLECTION! 🎉
    `);
  });

  setupWebSocket(server);
  startOptimizedMatching();

  server.on('error', (error) => {
    console.error('❌ Server error:', error);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    for (const [userId, timeout] of searchTimeouts.entries()) {
      clearTimeout(timeout.timeoutId);
    }
    searchTimeouts.clear();
    
    if (websocketServer) {
      websocketServer.broadcast({
        type: 'SERVER_SHUTDOWN',
        message: 'Server is shutting down'
      });
    }
    server.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
  });
}

module.exports = { app, db, admin, websocketServer };
