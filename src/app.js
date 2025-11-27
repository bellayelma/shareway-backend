// src/app.js - MODIFIED TO STOP SEARCHING AFTER PASSENGER IS FOUND
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
const TEST_MODE = true; // Set to true for immediate scheduled search testing
const TEST_MATCHING_INTERVAL = 5000; // 5 seconds for testing

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

// In-memory storage to minimize Firestore reads/writes
const activeSearches = new Map();
const scheduledSearches = new Map();
const processedMatches = new Map();
const searchTimeouts = new Map(); // Track search timeouts
const userMatches = new Map(); // Track matches per user

// Timeout constants
const IMMEDIATE_SEARCH_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const SCHEDULED_MATCHING_INTERVAL = 30 * 60 * 1000; // 30 minutes
const SCHEDULED_SEARCH_CHECK_INTERVAL = 10000; // 10 seconds
const MAX_MATCH_AGE = 300000; // 5 minutes

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
  const timeWindow = Math.floor(timestamp / 30000); // 30-second windows
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
    
    // Remove from scheduled searches
    if (scheduledSearches.has(userId)) {
      const search = scheduledSearches.get(userId);
      scheduledSearches.delete(userId);
      console.log(`✅ Stopped scheduled search for ${search.driverName || search.passengerName}`);
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

// Check if user should stop searching (based on match count)
const shouldStopSearching = (userId, userType) => {
  // Drivers stop after finding enough passengers to fill capacity
  // Passengers stop after finding any driver
  if (userType === 'passenger') {
    return true; // Passengers stop after first match
  }
  
  // For drivers, check if they reached capacity
  if (userType === 'driver') {
    const search = activeSearches.get(userId) || scheduledSearches.get(userId);
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

// Wait for WebSocket connection with timeout
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
      
      // Check again in 100ms
      setTimeout(checkConnection, 100);
    };
    
    checkConnection();
  });
};

// ========== SEARCH TIMEOUT MANAGEMENT ==========

// Set timeout for immediate search
const setImmediateSearchTimeout = (userId, searchId) => {
  const timeoutId = setTimeout(() => {
    console.log(`⏰ IMMEDIATE SEARCH TIMEOUT: Auto-stopping search for user ${userId}`);
    
    // Remove from active searches
    if (activeSearches.has(userId)) {
      const search = activeSearches.get(userId);
      activeSearches.delete(userId);
      
      // Notify user via WebSocket
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
    
    // Clean up timeout tracking
    searchTimeouts.delete(userId);
    
  }, IMMEDIATE_SEARCH_TIMEOUT);

  // Store timeout info
  searchTimeouts.set(userId, {
    timeoutId: timeoutId,
    searchId: searchId,
    type: 'immediate',
    startedAt: Date.now(),
    expiresAt: Date.now() + IMMEDIATE_SEARCH_TIMEOUT
  });

  console.log(`⏰ Set 5-minute timeout for immediate search: ${userId}`);
};

// Clear search timeout (when search is stopped manually or match found)
const clearSearchTimeout = (userId) => {
  if (searchTimeouts.has(userId)) {
    const timeout = searchTimeouts.get(userId);
    clearTimeout(timeout.timeoutId);
    searchTimeouts.delete(userId);
    console.log(`🧹 Cleared timeout for user: ${userId}`);
  }
};

// Set timeout for scheduled search matching cycles
const setScheduledMatchingTimeout = (userId, searchId, scheduledTime) => {
  // 🎯 TEST MODE: Skip timeout for immediate activation
  if (TEST_MODE) {
    console.log(`🧪 TEST MODE: Skipping scheduled timeout for immediate activation`);
    return;
  }

  const scheduledDate = new Date(scheduledTime);
  const now = new Date();
  
  // Calculate time until scheduled time
  const timeUntilScheduled = scheduledDate.getTime() - now.getTime();
  
  if (timeUntilScheduled <= 0) {
    console.log(`❌ Scheduled time already passed for user ${userId}`);
    return;
  }

  // Set timeout to activate scheduled search 30 minutes before scheduled time
  const activationTime = timeUntilScheduled - (30 * 60 * 1000);
  
  if (activationTime > 0) {
    const timeoutId = setTimeout(() => {
      console.log(`⏰ SCHEDULED SEARCH ACTIVATION: Activating search for user ${userId}`);
      activateScheduledSearch(userId);
    }, activationTime);

    // Store scheduled timeout
    searchTimeouts.set(userId, {
      timeoutId: timeoutId,
      searchId: searchId,
      type: 'scheduled_activation',
      scheduledTime: scheduledTime,
      activationTime: new Date(now.getTime() + activationTime)
    });

    console.log(`⏰ Set scheduled activation for: ${userId} at ${new Date(now.getTime() + activationTime).toISOString()}`);
  }
};

// ========== UPDATED MATCH CREATION WITH AUTO-STOP ==========

// Fallback function to store in Firestore if WebSocket fails
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

    await db.collection('active_matches').doc(matchData.matchId).set(activeMatchData);
    console.log(`✅ Match stored in Firestore (fallback): ${matchData.driverName} ↔ ${matchData.passengerName}`);
    return true;
    
  } catch (error) {
    console.error('❌ Error storing match in Firestore:', error);
    return false;
  }
};

// Optimized: Create active match with WebSocket priority and auto-stop
const createActiveMatchForOverlay = async (matchData) => {
  try {
    // ✅ PRIMARY: Send to Flutter via WebSocket
    if (websocketServer) {
      const result = websocketServer.sendMatchToUsers(matchData);
      
      if (result.driverSent || result.passengerSent) {
        console.log(`✅ Match sent to Flutter apps via WebSocket: ${matchData.driverName} ↔ ${matchData.passengerName}`);
        
        // 🎯 TRACK MATCHES FOR BOTH USERS
        trackUserMatch(matchData.driverId, matchData.matchId, matchData.passengerId);
        trackUserMatch(matchData.passengerId, matchData.matchId, matchData.driverId);
        
        // 🎯 CHECK IF USERS SHOULD STOP SEARCHING
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
        
        // Still store in Firestore as backup for 5 minutes
        setTimeout(() => {
          storeMatchInFirestore(matchData).catch(console.error);
        }, 1000);
        
        return true;
      } else {
        console.log(`⚠️ Both users offline, storing in Firestore as backup`);
        // Fallback to Firestore if both users are offline
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

// ========== ENHANCED SEARCH STORAGE FUNCTION WITH IMMEDIATE SCHEDULED MATCHING ==========

const storeSearchInMemory = async (searchData) => {
  const { userId, userType, rideType = 'immediate', activateImmediately = TEST_MODE } = searchData;
  
  if (!userId) throw new Error('userId is required');

  // Determine proper user type and names
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
    // 🎯 SET STATUS BASED ON IMMEDIATE ACTIVATION
    status: (rideType === 'scheduled' && !activateImmediately) ? 'scheduled' : 'searching',
    lastUpdated: Date.now(),
    createdAt: searchData.createdAt || new Date().toISOString(),
    // 🎯 STORE ACTIVATION FLAG
    activateImmediately: activateImmediately
  };

  // Store in appropriate memory store
  if (rideType === 'scheduled' && !activateImmediately) {
    // NORMAL SCHEDULED SEARCH (wait 30 minutes)
    scheduledSearches.set(userId, enhancedSearchData);
    console.log(`📅 SCHEDULED search stored: ${driverName || passengerName} (ID: ${userId}) for ${searchData.scheduledTime}`);
    
    // Set scheduled activation timeout
    setScheduledMatchingTimeout(userId, enhancedSearchData.searchId, searchData.scheduledTime);
    
  } else {
    // 🎯 IMMEDIATE SEARCH OR IMMEDIATELY ACTIVATED SCHEDULED SEARCH
    activeSearches.set(userId, enhancedSearchData);
    
    if (rideType === 'scheduled') {
      console.log(`🎯 SCHEDULED search ACTIVATED IMMEDIATELY: ${driverName || passengerName} (ID: ${userId})`);
      console.log(`   - Will start matching immediately in next cycle`);
    } else {
      console.log(`🎯 IMMEDIATE search stored: ${driverName || passengerName} (ID: ${userId})`);
    }
    
    // Set 5-minute timeout (skip in test mode for scheduled)
    if (!TEST_MODE || rideType !== 'scheduled') {
      setImmediateSearchTimeout(userId, enhancedSearchData.searchId);
    } else {
      console.log(`🧪 TEST MODE: No timeout for immediate scheduled search`);
    }
  }

  // ✅ WAIT for WebSocket connection before sending notification
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
        // 🎯 ADD ACTIVATION INFO
        activatedImmediately: activateImmediately,
        matchingStatus: activateImmediately ? 'Starting immediately' : 'Will start 30 minutes before scheduled time',
        autoStop: 'Will stop when match found'
      });
    } else {
      websocketServer.sendSearchStatusUpdate(userId, {
        searchId: enhancedSearchData.searchId,
        status: 'searching',
        rideType: 'immediate',
        matchesFound: 0,
        timeRemaining: 300,
        pickupName: enhancedSearchData.pickupName,
        destinationName: enhancedSearchData.destinationName,
        autoStop: 'Will stop when match found'
      });
    }
  } else {
    console.log(`⚠️ WebSocket not connected for ${userId}, cannot send search notification`);
  }
  
  // DEBUG: Show current searches by type
  const currentDrivers = Array.from(activeSearches.values()).filter(s => s.userType === 'driver');
  const currentPassengers = Array.from(activeSearches.values()).filter(s => s.userType === 'passenger');
  const scheduledDrivers = Array.from(scheduledSearches.values()).filter(s => s.userType === 'driver');
  const scheduledPassengers = Array.from(scheduledSearches.values()).filter(s => s.userType === 'passenger');
  
  console.log(`📊 Memory Stats - Active: ${activeSearches.size} (D:${currentDrivers.length} P:${currentPassengers.length})`);
  console.log(`📊 Memory Stats - Scheduled: ${scheduledSearches.size} (D:${scheduledDrivers.length} P:${scheduledPassengers.length})`);
  console.log(`⏰ Active Timeouts: ${searchTimeouts.size}`);
  console.log(`🎯 User Matches: ${userMatches.size} users with matches`);
  console.log(`🧪 TEST MODE: ${TEST_MODE ? 'ACTIVE - Scheduled searches start immediately' : 'INACTIVE'}`);
  
  return enhancedSearchData;
};

// ========== SCHEDULED SEARCH MANAGEMENT ==========

// Activate a specific scheduled search
const activateScheduledSearch = (userId) => {
  const scheduledSearch = scheduledSearches.get(userId);
  
  if (!scheduledSearch) {
    console.log(`❌ No scheduled search found for user: ${userId}`);
    return null;
  }

  // Move from scheduled to active searches
  scheduledSearch.status = 'searching';
  scheduledSearch.lastUpdated = Date.now();
  scheduledSearch.activatedAt = new Date().toISOString();
  activeSearches.set(userId, scheduledSearch);
  scheduledSearches.delete(userId);
  
  // ✅ Send WebSocket notification for activation
  if (websocketServer) {
    websocketServer.sendScheduledSearchActivated(userId, {
      searchId: scheduledSearch.searchId,
      scheduledTime: scheduledSearch.scheduledTime,
      timeUntilRide: 'Now active',
      autoStop: 'Will stop when match found'
    });
    
    websocketServer.sendSearchStarted(userId, scheduledSearch);
  }
  
  // Set 5-minute timeout for the now-active search
  setImmediateSearchTimeout(userId, scheduledSearch.searchId);
  
  console.log(`🔄 ACTIVATED scheduled search: ${scheduledSearch.driverName || scheduledSearch.passengerName}`);
  console.log(`   - Scheduled: ${scheduledSearch.scheduledTime}`);
  console.log(`   - Activated: ${scheduledSearch.activatedAt}`);
  
  return scheduledSearch;
};

// Check and activate scheduled searches
const checkScheduledSearchActivation = () => {
  const now = new Date();
  let activatedCount = 0;

  console.log(`\n🕒 Checking scheduled searches activation... (Total: ${scheduledSearches.size})`);

  for (const [userId, search] of scheduledSearches.entries()) {
    if (search.status === 'scheduled' && search.scheduledTime) {
      try {
        const scheduledTime = new Date(search.scheduledTime);
        const timeUntilRide = scheduledTime.getTime() - now.getTime();
        
        console.log(`   - ${search.driverName || search.passengerName}:`);
        console.log(`     Scheduled: ${scheduledTime.toISOString()}`);
        console.log(`     Time until ride: ${Math.round(timeUntilRide / 60000)}min`);
        console.log(`     Status: ${search.status}`);

        // Activate if within 30 minutes of scheduled time
        if (timeUntilRide <= 30 * 60 * 1000) {
          activateScheduledSearch(userId);
          activatedCount++;
        }
      } catch (error) {
        console.error(`❌ Error processing scheduled search ${userId}:`, error);
      }
    }
  }

  if (activatedCount > 0) {
    console.log(`✅ Activated ${activatedCount} scheduled searches`);
  } else if (scheduledSearches.size > 0) {
    console.log(`⏳ No scheduled searches ready for activation yet`);
  }
};

// ========== IMMEDIATE MATCH SEARCH ENDPOINT ==========

app.post("/api/match/search", async (req, res) => {
  try {
    console.log('🎯 === IMMEDIATE MATCH SEARCH ENDPOINT CALLED ===');
    console.log('📦 FULL REQUEST BODY:', JSON.stringify(req.body, null, 2));
    
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
    
    // Determine the actual user ID to use
    const actualUserId = userId || driverId;
    
    if (!actualUserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId or driverId is required' 
      });
    }

    // Clear any existing search for this user
    if (activeSearches.has(actualUserId)) {
      console.log(`🔄 Clearing existing search for user: ${actualUserId}`);
      clearSearchTimeout(actualUserId);
      activeSearches.delete(actualUserId);
    }

    // Store the search in memory - NOW ASYNC
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

    // ✅ AWAIT the search storage to ensure WebSocket notification is sent
    await storeSearchInMemory(searchData);

    // Return success response
    res.json({
      success: true,
      message: 'Immediate search started successfully',
      searchId: searchData.searchId,
      userId: actualUserId,
      rideType: rideType,
      timeout: '5 minutes (or until match found)',
      matches: [],
      matchCount: 0,
      matchingAlgorithm: 'enhanced_route_similarity_v2',
      websocketConnected: websocketServer ? websocketServer.isUserConnected(actualUserId) : false,
      testMode: TEST_MODE,
      autoStop: 'Search will stop automatically when match is found'
    });
    
  } catch (error) {
    console.error('❌ Error in immediate match search:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== SCHEDULED SEARCH ENDPOINT WITH IMMEDIATE MATCHING ==========

app.post("/api/match/scheduled-search", async (req, res) => {
  try {
    console.log('📅 === SCHEDULED SEARCH ENDPOINT CALLED ===');
    
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
      scheduledTime, // Required for scheduled searches
      searchId,
      // 🎯 ADD IMMEDIATE ACTIVATION FLAG
      activateImmediately = TEST_MODE // Default to TEST_MODE value
    } = req.body;
    
    // Validate scheduled time (unless activating immediately)
    if (!scheduledTime && !activateImmediately) {
      return res.status(400).json({ 
        success: false, 
        error: 'scheduledTime is required for scheduled searches' 
      });
    }

    const actualUserId = userId || driverId;
    
    if (!actualUserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId or driverId is required' 
      });
    }

    // Clear any existing scheduled search for this user
    if (scheduledSearches.has(actualUserId)) {
      console.log(`🔄 Clearing existing scheduled search for user: ${actualUserId}`);
      clearSearchTimeout(actualUserId);
      scheduledSearches.delete(actualUserId);
    }

    // Store in memory with scheduled flag
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
      rideType: 'scheduled',
      scheduledTime: scheduledTime,
      searchId: searchId || `scheduled_${actualUserId}_${Date.now()}`,
      // 🎯 ADD IMMEDIATE ACTIVATION FLAG
      activateImmediately: activateImmediately
    };

    // ✅ AWAIT the search storage
    await storeSearchInMemory(searchData);

    res.json({
      success: true,
      message: activateImmediately ? 
        'Scheduled search created and ACTIVATED IMMEDIATELY - will start matching now!' : 
        'Scheduled search created successfully',
      searchId: searchData.searchId,
      userId: actualUserId,
      rideType: 'scheduled',
      scheduledTime: scheduledTime,
      status: activateImmediately ? 'searching' : 'scheduled',
      activationTime: activateImmediately ? 'IMMEDIATELY' : '30 minutes before scheduled time',
      matches: [],
      // 🎯 ADD ACTIVATION INFO
      activatedImmediately: activateImmediately,
      testMode: TEST_MODE,
      matchingStatus: activateImmediately ? 
        'Will start matching in next cycle (5-30 seconds)' : 
        'Will start 30 minutes before scheduled time',
      autoStop: 'Search will stop automatically when match is found'
    });
    
  } catch (error) {
    console.error('❌ Error in scheduled search:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== STOP SEARCH ENDPOINT (BOTH TYPES) ==========

app.post("/api/match/stop-search", async (req, res) => {
  try {
    console.log('🛑 === STOP SEARCH ENDPOINT CALLED ===');
    
    const { 
      userId, 
      userType, 
      driverId,
      rideType = 'immediate'
    } = req.body;
    
    const actualUserId = userId || driverId;
    
    if (!actualUserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId or driverId is required' 
      });
    }

    let stoppedFrom = '';
    let searchData = null;
    
    // Remove from appropriate memory store and clear timeout
    if (rideType === 'scheduled') {
      if (scheduledSearches.has(actualUserId)) {
        searchData = scheduledSearches.get(actualUserId);
        scheduledSearches.delete(actualUserId);
        clearSearchTimeout(actualUserId);
        stoppedFrom = 'scheduled searches';
      }
    } else {
      if (activeSearches.has(actualUserId)) {
        searchData = activeSearches.get(actualUserId);
        activeSearches.delete(actualUserId);
        clearSearchTimeout(actualUserId);
        stoppedFrom = 'active searches';
      }
    }

    if (searchData) {
      console.log(`✅ Stopped ${rideType} search for ${searchData.driverName || searchData.passengerName} (${actualUserId}) from ${stoppedFrom}`);
      
      // Notify user via WebSocket
      if (websocketServer) {
        websocketServer.sendSearchStopped(actualUserId, {
          searchId: searchData.searchId,
          rideType: rideType
        });
      }
    } else {
      console.log(`⚠️ No ${rideType} search found for user ${actualUserId}`);
    }

    res.json({
      success: true,
      message: `${rideType} search stopped successfully`,
      userId: actualUserId,
      rideType: rideType,
      memoryStats: {
        activeSearches: activeSearches.size,
        scheduledSearches: scheduledSearches.size,
        activeTimeouts: searchTimeouts.size,
        userMatches: userMatches.size
      }
    });
    
  } catch (error) {
    console.error('❌ Error stopping search:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== GET SEARCH STATUS ENDPOINT ==========

app.get("/api/match/search-status/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { rideType } = req.query;
    
    let searchData = null;
    let searchType = '';
    let timeRemaining = null;
    
    if (rideType === 'scheduled') {
      searchData = scheduledSearches.get(userId);
      searchType = 'scheduled';
    } else {
      searchData = activeSearches.get(userId);
      searchType = 'immediate';
    }

    // Calculate time remaining for active searches
    if (searchData && searchType === 'immediate' && searchTimeouts.has(userId)) {
      const timeout = searchTimeouts.get(userId);
      if (timeout.expiresAt) {
        timeRemaining = Math.max(0, timeout.expiresAt - Date.now());
      }
    }

    // Get match count for user
    const matchCount = userMatches.get(userId)?.size || 0;

    if (!searchData) {
      return res.json({
        success: true,
        isSearching: false,
        userId: userId,
        rideType: rideType || 'immediate',
        message: 'No active search found',
        matchesFound: matchCount
      });
    }

    res.json({
      success: true,
      isSearching: searchData.status === 'searching',
      searchData: {
        userId: searchData.userId,
        userType: searchData.userType,
        rideType: searchData.rideType,
        status: searchData.status,
        searchId: searchData.searchId,
        scheduledTime: searchData.scheduledTime,
        lastUpdated: searchData.lastUpdated,
        pickupName: searchData.pickupName,
        destinationName: searchData.destinationName,
        timeRemaining: timeRemaining ? Math.round(timeRemaining / 1000) : null,
        // 🎯 ADD TEST MODE INFO
        activatedImmediately: searchData.activateImmediately,
        testMode: TEST_MODE
      },
      matchStats: {
        matchesFound: matchCount,
        autoStop: searchData.userType === 'passenger' ? 
          'Will stop after first match' : 
          `Will stop after ${searchData.capacity || 4} matches`
      },
      memoryStats: {
        activeSearches: activeSearches.size,
        scheduledSearches: scheduledSearches.size,
        activeTimeouts: searchTimeouts.size,
        userMatches: userMatches.size
      }
    });
    
  } catch (error) {
    console.error('❌ Error getting search status:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== DEBUG ENDPOINTS ==========

// WebSocket connection debug endpoint
app.get("/api/debug/websocket", (req, res) => {
  if (!websocketServer) {
    return res.json({ success: false, message: 'WebSocket server not initialized' });
  }
  
  const connectedUsers = websocketServer.getConnectedUsers();
  const totalConnections = websocketServer.getConnectedCount();
  
  res.json({
    success: true,
    connectedUsers: connectedUsers,
    totalConnections: totalConnections,
    detailedConnections: websocketServer.getDetailedConnectionInfo(),
    serverTime: new Date().toISOString(),
    testMode: TEST_MODE
  });
});

// Search status debug endpoint
app.get("/api/debug/searches", (req, res) => {
  const drivers = Array.from(activeSearches.values()).filter(s => s.userType === 'driver');
  const passengers = Array.from(activeSearches.values()).filter(s => s.userType === 'passenger');
  const scheduledDrivers = Array.from(scheduledSearches.values()).filter(s => s.userType === 'driver');
  const scheduledPassengers = Array.from(scheduledSearches.values()).filter(s => s.userType === 'passenger');
  
  // Get match counts
  const driverMatches = Array.from(userMatches.entries())
    .filter(([userId]) => {
      const search = activeSearches.get(userId) || scheduledSearches.get(userId);
      return search && search.userType === 'driver';
    })
    .map(([userId, matches]) => ({
      userId,
      matchCount: matches.size
    }));
  
  const passengerMatches = Array.from(userMatches.entries())
    .filter(([userId]) => {
      const search = activeSearches.get(userId) || scheduledSearches.get(userId);
      return search && search.userType === 'passenger';
    })
    .map(([userId, matches]) => ({
      userId,
      matchCount: matches.size
    }));
  
  res.json({
    activeSearches: activeSearches.size,
    scheduledSearches: scheduledSearches.size,
    activeDrivers: drivers.map(d => ({
      id: d.userId,
      name: d.driverName,
      status: d.status,
      searchId: d.searchId,
      pickup: d.pickupName,
      destination: d.destinationName,
      rideType: d.rideType,
      activatedImmediately: d.activateImmediately,
      capacity: d.capacity,
      connected: websocketServer ? websocketServer.isUserConnected(d.userId) : false,
      matchesFound: userMatches.get(d.userId)?.size || 0
    })),
    activePassengers: passengers.map(p => ({
      id: p.userId, 
      name: p.passengerName,
      status: p.status,
      searchId: p.searchId,
      rideType: p.rideType,
      activatedImmediately: p.activateImmediately,
      matchesFound: userMatches.get(p.userId)?.size || 0
    })),
    scheduledDrivers: scheduledDrivers.map(d => ({
      id: d.userId,
      name: d.driverName,
      status: d.status,
      scheduledTime: d.scheduledTime,
      searchId: d.searchId,
      capacity: d.capacity
    })),
    scheduledPassengers: scheduledPassengers.map(p => ({
      id: p.userId,
      name: p.passengerName,
      status: p.status,
      scheduledTime: p.scheduledTime,
      searchId: p.searchId
    })),
    activeTimeouts: searchTimeouts.size,
    processedMatches: processedMatches.size,
    userMatches: {
      totalUsersWithMatches: userMatches.size,
      driverMatches: driverMatches,
      passengerMatches: passengerMatches
    },
    testMode: TEST_MODE
  });
});

// ========== FIXED OPTIMIZED MATCHING SERVICE WITH AUTO-STOP ==========

const startOptimizedMatching = () => {
  console.log('🔄 Starting Optimized Matching Service...');
  console.log(`🧪 TEST MODE: ${TEST_MODE ? 'ACTIVE - Scheduled searches start immediately' : 'INACTIVE'}`);
  console.log(`🎯 AUTO-STOP: Enabled - Passengers stop after 1 match, Drivers stop when capacity reached`);
  
  // 🎯 USE TEST INTERVAL IN TEST MODE
  const matchingInterval = TEST_MODE ? TEST_MATCHING_INTERVAL : 30000;
  
  setInterval(async () => {
    try {
      console.log(`\n📊 ===== MATCHING CYCLE START =====`);
      console.log(`🧪 TEST MODE: ${TEST_MODE ? 'ACTIVE' : 'INACTIVE'}`);
      
      // First, activate any scheduled searches that are due
      checkScheduledSearchActivation();

      // Get drivers and passengers from memory - INCLUDES IMMEDIATE SCHEDULED SEARCHES
      const drivers = Array.from(activeSearches.values())
        .filter(search => search.userType === 'driver' && search.status === 'searching');
      
      const passengers = Array.from(activeSearches.values())
        .filter(search => search.userType === 'passenger' && search.status === 'searching');

      console.log(`📊 Matching: ${drivers.length} drivers vs ${passengers.length} passengers`);
      
      // 🎯 LOG SCHEDULED SEARCHES THAT ARE ACTIVE
      const scheduledDrivers = drivers.filter(d => d.rideType === 'scheduled');
      const scheduledPassengers = passengers.filter(p => p.rideType === 'scheduled');
      if (scheduledDrivers.length > 0 || scheduledPassengers.length > 0) {
        console.log(`📅 ACTIVE SCHEDULED SEARCHES - Drivers: ${scheduledDrivers.length}, Passengers: ${scheduledPassengers.length}`);
      }
      
      if (drivers.length === 0 || passengers.length === 0) {
        console.log(`💤 No matches possible - Drivers: ${drivers.length}, Passengers: ${passengers.length}`);
        
        // DEBUG: Show why no matches
        if (drivers.length > 0 && passengers.length === 0) {
          console.log(`🔍 DEBUG: We have ${drivers.length} drivers but NO passengers searching!`);
        }
        if (passengers.length > 0 && drivers.length === 0) {
          console.log(`🔍 DEBUG: We have ${passengers.length} passengers but NO drivers searching!`);
        }
        
        console.log(`📊 ===== MATCHING CYCLE END =====\n`);
        return;
      }

      // Log actual search details
      console.log('🚗 Active Drivers:');
      drivers.forEach(driver => {
        const matchCount = userMatches.get(driver.userId)?.size || 0;
        console.log(`   - ${driver.driverName} (${driver.userId}) - ${driver.rideType} - Matches: ${matchCount}/${driver.capacity || 4}`);
        console.log(`     Route: ${driver.pickupName} → ${driver.destinationName}`);
      });

      console.log('👤 Active Passengers:');
      passengers.forEach(passenger => {
        const matchCount = userMatches.get(passenger.userId)?.size || 0;
        console.log(`   - ${passenger.passengerName} (${passenger.userId}) - ${passenger.rideType} - Matches: ${matchCount}/1`);
        console.log(`     Route: ${passenger.pickupName} → ${passenger.destinationName}`);
      });
      
      let matchesCreated = 0;
      
      // Optimized matching - INCLUDES SCHEDULED SEARCHES THAT ARE ACTIVE
      for (const driver of drivers) {
        // Skip driver if they reached capacity
        const driverMatchCount = userMatches.get(driver.userId)?.size || 0;
        if (driverMatchCount >= (driver.capacity || 4)) {
          console.log(`⏭️ Skipping driver ${driver.driverName} - reached capacity: ${driverMatchCount}/${driver.capacity || 4}`);
          continue;
        }
        
        for (const passenger of passengers) {
          // Skip passenger if they already have a match
          const passengerMatchCount = userMatches.get(passenger.userId)?.size || 0;
          if (passengerMatchCount >= 1) {
            console.log(`⏭️ Skipping passenger ${passenger.passengerName} - already has match`);
            continue;
          }

          // Enhanced validation with debugging
          if (!driver.routePoints || driver.routePoints.length === 0) {
            console.log(`⚠️ Skipping driver ${driver.driverName} - no route points`);
            continue;
          }
          if (!passenger.routePoints || passenger.routePoints.length === 0) {
            console.log(`⚠️ Skipping passenger ${passenger.passengerName} - no route points`);
            continue;
          }

          // Check capacity
          const passengerCount = passenger.passengerCount || 1;
          const hasSeats = routeMatching.hasCapacity(driver, passengerCount);
          if (!hasSeats) {
            console.log(`⚠️ Skipping - no capacity: ${driver.capacity} vs ${passengerCount}`);
            continue;
          }

          // Calculate similarity
          const similarity = routeMatching.calculateRouteSimilarity(
            passenger.routePoints,
            driver.routePoints,
            { 
              similarityThreshold: 0.001, 
              maxDistanceThreshold: 50.0
            }
          );

          console.log(`🔍 ${driver.driverName || 'Driver'} ↔ ${passenger.passengerName || 'Passenger'}: Score=${similarity.toFixed(3)}`);

          // Process matches with threshold
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
                // 🎯 ADD MATCH TYPE INFO
                matchType: (driver.rideType === 'scheduled' || passenger.rideType === 'scheduled') ? 
                  'scheduled_immediate_match' : 'immediate_match'
              };

              // Create overlay match (now uses WebSocket)
              const matchCreated = await createActiveMatchForOverlay(matchData);
              
              if (matchCreated) {
                matchesCreated++;
                processedMatches.set(matchKey, Date.now());
                
                console.log(`🎉 MATCH CREATED: ${driver.driverName || 'Driver'} ↔ ${passenger.passengerName || 'Passenger'} (Score: ${similarity.toFixed(3)})`);
                if (driver.rideType === 'scheduled' || passenger.rideType === 'scheduled') {
                  console.log(`   📅 SCHEDULED SEARCH MATCH!`);
                }
              }
            } else {
              console.log(`🔁 Skipping duplicate match: ${matchKey}`);
            }
          } else {
            console.log(`📉 Similarity too low: ${similarity.toFixed(3)}`);
          }
        }
      }

      if (matchesCreated > 0) {
        console.log(`📱 Created ${matchesCreated} overlay matches`);
      } else {
        console.log('ℹ️  No matches found this cycle');
      }
      
      console.log(`📊 ===== MATCHING CYCLE END =====\n`);
      
    } catch (error) {
      console.error('❌ Matching error:', error);
    }
  }, matchingInterval); // 🎯 USE DYNAMIC INTERVAL

  // Check scheduled searches every 10 seconds
  setInterval(checkScheduledSearchActivation, SCHEDULED_SEARCH_CHECK_INTERVAL);
};

// ========== WEB SOCKET ENDPOINTS ==========

// WebSocket status endpoint
app.get("/api/websocket/status", (req, res) => {
  if (!websocketServer) {
    return res.json({ 
      success: false, 
      message: 'WebSocket server not initialized' 
    });
  }
  
  const drivers = Array.from(activeSearches.values()).filter(s => s.userType === 'driver');
  const passengers = Array.from(activeSearches.values()).filter(s => s.userType === 'passenger');
  const scheduledDrivers = Array.from(scheduledSearches.values()).filter(s => s.userType === 'driver');
  const scheduledPassengers = Array.from(scheduledSearches.values()).filter(s => s.userType === 'passenger');
  
  res.json({
    success: true,
    connectedClients: websocketServer.getConnectedCount(),
    connectedUsers: websocketServer.getConnectedUsers(),
    serverTime: new Date().toISOString(),
    searchStats: {
      activeDrivers: drivers.length,
      activePassengers: passengers.length,
      scheduledDrivers: scheduledDrivers.length,
      scheduledPassengers: scheduledPassengers.length,
      totalActiveSearches: activeSearches.size,
      totalScheduledSearches: scheduledSearches.size,
      totalProcessedMatches: processedMatches.size,
      activeTimeouts: searchTimeouts.size,
      usersWithMatches: userMatches.size
    },
    testMode: TEST_MODE,
    immediateScheduledMatching: TEST_MODE ? 'ACTIVE' : 'INACTIVE',
    autoStopEnabled: true,
    autoStopRules: {
      passengers: 'Stop after first match',
      drivers: 'Stop when capacity reached'
    }
  });
});

// ========== DEBUG & MONITORING ENDPOINTS ==========

app.get("/", (req, res) => {
  const drivers = Array.from(activeSearches.values()).filter(s => s.userType === 'driver');
  const passengers = Array.from(activeSearches.values()).filter(s => s.userType === 'passenger');
  const scheduled = Array.from(scheduledSearches.values());
  
  res.json({ 
    status: "🚀 Server running (AUTO-STOP AFTER MATCH)",
    timestamp: new Date().toISOString(),
    memoryStats: {
      activeSearches: activeSearches.size,
      scheduledSearches: scheduledSearches.size,
      drivers: drivers.length,
      passengers: passengers.length,
      processedMatches: processedMatches.size,
      activeTimeouts: searchTimeouts.size,
      websocketConnections: websocketServer ? websocketServer.getConnectedCount() : 0,
      usersWithMatches: userMatches.size
    },
    timeoutSettings: {
      immediateSearch: "5 minutes (or until match found)",
      scheduledActivation: TEST_MODE ? "IMMEDIATE (TEST MODE)" : "30 minutes before ride time",
      matchingInterval: TEST_MODE ? "5 seconds" : "30 seconds",
      scheduledCheck: "10 seconds"
    },
    autoStopSettings: {
      enabled: true,
      passengerRule: "Stop after first match",
      driverRule: "Stop when capacity reached"
    },
    testMode: TEST_MODE,
    immediateScheduledMatching: TEST_MODE ? "ACTIVE - Scheduled searches start matching immediately" : "INACTIVE",
    activeDrivers: drivers.map(d => ({
      id: d.userId,
      name: d.driverName,
      type: d.userType,
      rideType: d.rideType,
      routePoints: d.routePoints?.length || 0,
      pickup: d.pickupName,
      destination: d.destinationName,
      activatedImmediately: d.activateImmediately,
      capacity: d.capacity,
      matchesFound: userMatches.get(d.userId)?.size || 0,
      connected: websocketServer ? websocketServer.isUserConnected(d.userId) : false
    })),
    activePassengers: passengers.map(p => ({
      id: p.userId, 
      name: p.passengerName,
      type: p.userType,
      rideType: p.rideType,
      routePoints: p.routePoints?.length || 0,
      pickup: p.pickupName,
      destination: p.destinationName,
      activatedImmediately: p.activateImmediately,
      matchesFound: userMatches.get(p.userId)?.size || 0
    })),
    scheduledSearches: scheduled.map(s => ({
      id: s.userId,
      name: s.driverName || s.passengerName,
      type: s.userType,
      scheduledTime: s.scheduledTime,
      status: s.status,
      pickup: s.pickupName,
      destination: s.destinationName,
      capacity: s.capacity
    }))
  });
});

// ========== OTHER ESSENTIAL ENDPOINTS ==========

app.get("/api/match/active/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    
    const activeMatchesSnapshot = await db.collection('active_matches')
      .where('driverId', '==', userId)
      .where('overlayTriggered', '==', true)
      .orderBy('createdAt', 'desc')
      .limit(10)
      .get();
    
    const activeMatches = activeMatchesSnapshot.docs.map(doc => ({
      matchId: doc.id,
      ...doc.data()
    }));
    
    res.json({
      success: true,
      activeMatches,
      count: activeMatches.length,
      testMode: TEST_MODE,
      userMatchCount: userMatches.get(userId)?.size || 0
    });
    
  } catch (error) {
    console.error('Error getting active matches:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/match/decision", async (req, res) => {
  try {
    const { matchId, decision, userId } = req.body;
    
    if (!matchId || typeof decision === 'undefined' || !userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    await db.collection('active_matches').doc(matchId).delete();
    console.log(`✅ Match ${matchId} ${decision ? 'accepted' : 'rejected'} by ${userId}`);
    
    res.json({
      success: true,
      message: `Match ${decision ? 'accepted' : 'rejected'} successfully`,
      matchId
    });
    
  } catch (error) {
    console.error('Error handling match decision:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== START SERVER ==========

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 ShareWay AUTO-STOP AFTER MATCH Server Started!
📍 Port: ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
🔥 Firebase: Minimal Usage Mode
💾 Memory Cache: ENABLED
🔌 WebSocket: CONNECTION TIMING FIXED
⏰ Auto Timeouts: ENABLED

🎯 AUTO-STOP FEATURE: ENABLED!
   - Passengers: Stop after first match
   - Drivers: Stop when capacity reached

🧪 TEST MODE: ${TEST_MODE ? 'ACTIVE' : 'INACTIVE'}

📊 Current Stats:
- Active Searches: ${activeSearches.size} (in memory)
- Scheduled Searches: ${scheduledSearches.size} (in memory)
- Processed Matches: ${processedMatches.size} (in memory)
- Active Timeouts: ${searchTimeouts.size} (in memory)
- Users with Matches: ${userMatches.size} (in memory)
- WebSocket Connections: ${websocketServer ? websocketServer.getConnectedCount() : 0}

⏰ TIMEOUT SETTINGS:
- Immediate Search: 5 minutes (or until match found)
- Scheduled Activation: ${TEST_MODE ? 'IMMEDIATE (TEST MODE)' : '30 minutes before ride time'}  
- Matching Interval: ${TEST_MODE ? '5 seconds' : '30 seconds'}
- Scheduled Check: 10 seconds

✅ SEARCHES WILL STOP AUTOMATICALLY WHEN MATCH IS FOUND! 🎉
    `);
  });

  // ✅ Initialize WebSocket server
  setupWebSocket(server);

  // Start the optimized matching service
  startOptimizedMatching();

  server.on('error', (error) => {
    console.error('❌ Server error:', error);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    // Clear all timeouts
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
