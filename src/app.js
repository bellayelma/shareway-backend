// src/app.js - FIXED SCHEDULED SEARCH ACTIVATION
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
const MAX_MATCH_AGE = 300000; // 5 minutes
const SCHEDULED_SEARCH_CHECK_INTERVAL = 10000; // 10 seconds - more frequent for testing

// Clean old data from memory
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of processedMatches.entries()) {
    if (now - timestamp > MAX_MATCH_AGE) {
      console.log(`🧹 Cleaning old processed match: ${key}`);
      processedMatches.delete(key);
    }
  }
  for (const [key, search] of activeSearches.entries()) {
    if (now - search.lastUpdated > MAX_MATCH_AGE) {
      console.log(`🧹 Cleaning old active search: ${search.userId} (${search.userType})`);
      activeSearches.delete(key);
    }
  }
}, 60000);

// Generate match key for deduplication - FIXED WITH TIMESTAMP
const generateMatchKey = (driverId, passengerId, timestamp = Date.now()) => {
  const timeWindow = Math.floor(timestamp / 30000); // 30-second windows to allow new matches
  return `${driverId}_${passengerId}_${timeWindow}`;
};

// ========== UPDATED MATCH CREATION WITH WEB SOCKET ==========

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

// Optimized: Create active match with WebSocket priority
const createActiveMatchForOverlay = async (matchData) => {
  try {
    // ✅ PRIMARY: Send to Flutter via WebSocket
    if (websocketServer) {
      const result = websocketServer.sendMatchToUsers(matchData);
      
      if (result.driverSent || result.passengerSent) {
        console.log(`✅ Match sent to Flutter apps via WebSocket: ${matchData.driverName} ↔ ${matchData.passengerName}`);
        
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

// ========== ENHANCED SEARCH STORAGE FUNCTION ==========

const storeSearchInMemory = (searchData) => {
  const { userId, userType, rideType = 'immediate' } = searchData;
  
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
    status: rideType === 'scheduled' ? 'scheduled' : 'searching',
    lastUpdated: Date.now(),
    createdAt: searchData.createdAt || new Date().toISOString()
  };

  // Store in appropriate memory store
  if (rideType === 'scheduled') {
    scheduledSearches.set(userId, enhancedSearchData);
    console.log(`📅 SCHEDULED search stored: ${driverName || passengerName} (ID: ${userId}) for ${searchData.scheduledTime}`);
    console.log(`   - Route points: ${enhancedSearchData.routePoints.length}`);
    console.log(`   - Pickup: ${enhancedSearchData.pickupName} → Destination: ${enhancedSearchData.destinationName}`);
  } else {
    activeSearches.set(userId, enhancedSearchData);
    console.log(`🎯 IMMEDIATE search stored: ${driverName || passengerName} (ID: ${userId})`);
    console.log(`   - Route points: ${enhancedSearchData.routePoints.length}`);
    console.log(`   - Pickup: ${enhancedSearchData.pickupName} → Destination: ${enhancedSearchData.destinationName}`);
  }
  
  // DEBUG: Show current searches by type
  const currentDrivers = Array.from(activeSearches.values()).filter(s => s.userType === 'driver');
  const currentPassengers = Array.from(activeSearches.values()).filter(s => s.userType === 'passenger');
  const scheduledDrivers = Array.from(scheduledSearches.values()).filter(s => s.userType === 'driver');
  const scheduledPassengers = Array.from(scheduledSearches.values()).filter(s => s.userType === 'passenger');
  
  console.log(`📊 Memory Stats - Active: ${activeSearches.size} (D:${currentDrivers.length} P:${currentPassengers.length})`);
  console.log(`📊 Memory Stats - Scheduled: ${scheduledSearches.size} (D:${scheduledDrivers.length} P:${scheduledPassengers.length})`);
  
  return enhancedSearchData;
};

// ========== FIXED SCHEDULED SEARCH MANAGEMENT ==========

// Check and activate scheduled searches - FIXED VERSION
const activateScheduledSearches = () => {
  const now = new Date();
  let activatedCount = 0;

  console.log(`\n🕒 Checking scheduled searches... (Total: ${scheduledSearches.size})`);

  for (const [userId, search] of scheduledSearches.entries()) {
    if (search.status === 'scheduled' && search.scheduledTime) {
      try {
        const scheduledTime = new Date(search.scheduledTime);
        const timeUntilRide = scheduledTime.getTime() - now.getTime();
        
        console.log(`   - ${search.driverName || search.passengerName}: ${scheduledTime.toISOString()} (in ${Math.round(timeUntilRide / 60000)}min)`);
        
        // ✅ FIX: Activate if scheduled time is in the past OR within 60 minutes
        if (timeUntilRide <= 60 * 60 * 1000) {
          // Move from scheduled to active searches
          search.status = 'searching';
          search.lastUpdated = Date.now();
          activeSearches.set(userId, search);
          scheduledSearches.delete(userId);
          activatedCount++;
          
          console.log(`🔄 ACTIVATED scheduled search: ${search.driverName || search.passengerName}`);
          console.log(`   - Scheduled: ${scheduledTime.toISOString()}`);
          console.log(`   - Now: ${now.toISOString()}`);
          console.log(`   - Time until ride: ${Math.round(timeUntilRide / 60000)} minutes`);
        } else {
          console.log(`   ⏳ Still waiting: ${Math.round(timeUntilRide / 60000)} minutes until activation`);
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

    // Store the search in memory
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

    storeSearchInMemory(searchData);

    // Return success response
    res.json({
      success: true,
      message: 'Immediate search started successfully',
      searchId: searchData.searchId,
      userId: actualUserId,
      rideType: rideType,
      matches: [],
      matchCount: 0,
      matchingAlgorithm: 'enhanced_route_similarity_v2'
    });
    
  } catch (error) {
    console.error('❌ Error in immediate match search:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== SCHEDULED SEARCH ENDPOINT ==========

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
      searchId
    } = req.body;
    
    // Validate scheduled time
    if (!scheduledTime) {
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
      rideType: 'scheduled', // ✅ Explicitly set to scheduled
      scheduledTime: scheduledTime,
      searchId: searchId || `scheduled_${actualUserId}_${Date.now()}`
    };

    storeSearchInMemory(searchData);

    res.json({
      success: true,
      message: 'Scheduled search created successfully',
      searchId: searchData.searchId,
      userId: actualUserId,
      rideType: 'scheduled',
      scheduledTime: scheduledTime,
      status: 'scheduled',
      matches: []
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
    
    // Remove from appropriate memory store
    if (rideType === 'scheduled') {
      if (scheduledSearches.has(actualUserId)) {
        searchData = scheduledSearches.get(actualUserId);
        scheduledSearches.delete(actualUserId);
        stoppedFrom = 'scheduled searches';
      }
    } else {
      if (activeSearches.has(actualUserId)) {
        searchData = activeSearches.get(actualUserId);
        activeSearches.delete(actualUserId);
        stoppedFrom = 'active searches';
      }
    }

    if (searchData) {
      console.log(`✅ Stopped ${rideType} search for ${searchData.driverName || searchData.passengerName} (${actualUserId}) from ${stoppedFrom}`);
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
        scheduledSearches: scheduledSearches.size
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
    
    if (rideType === 'scheduled') {
      searchData = scheduledSearches.get(userId);
      searchType = 'scheduled';
    } else {
      searchData = activeSearches.get(userId);
      searchType = 'immediate';
    }

    if (!searchData) {
      return res.json({
        success: true,
        isSearching: false,
        userId: userId,
        rideType: rideType || 'immediate',
        message: 'No active search found'
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
        destinationName: searchData.destinationName
      },
      memoryStats: {
        activeSearches: activeSearches.size,
        scheduledSearches: scheduledSearches.size
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

// ========== FIXED OPTIMIZED MATCHING SERVICE ==========

const startOptimizedMatching = () => {
  console.log('🔄 Starting Optimized Matching Service...');
  
  // Run every 30 seconds for better responsiveness
  setInterval(async () => {
    try {
      console.log(`\n📊 ===== MATCHING CYCLE START =====`);
      
      // First, activate any scheduled searches that are due
      activateScheduledSearches();

      // Get drivers and passengers from memory
      const drivers = Array.from(activeSearches.values())
        .filter(search => search.userType === 'driver' && search.status === 'searching');
      
      const passengers = Array.from(activeSearches.values())
        .filter(search => search.userType === 'passenger' && search.status === 'searching');

      console.log(`📊 Matching: ${drivers.length} drivers vs ${passengers.length} passengers`);
      
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
        console.log(`   - ${driver.driverName} (${driver.userId}) - ${driver.rideType}`);
        console.log(`     Route: ${driver.pickupName} → ${driver.destinationName}`);
        console.log(`     Points: ${driver.routePoints ? driver.routePoints.length : 0}`);
      });

      console.log('👤 Active Passengers:');
      passengers.forEach(passenger => {
        console.log(`   - ${passenger.passengerName} (${passenger.userId}) - ${passenger.rideType}`);
        console.log(`     Route: ${passenger.pickupName} → ${passenger.destinationName}`);
        console.log(`     Points: ${passenger.routePoints ? passenger.routePoints.length : 0}`);
      });
      
      let matchesCreated = 0;
      
      // Optimized matching
      for (const driver of drivers) {
        for (const passenger of passengers) {
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

          // ✅ FIXED: Process matches with lower threshold and better duplicate prevention
          if (similarity > 0.01) { // Lowered threshold
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
                timestamp: new Date().toISOString()
              };

              // Create overlay match (now uses WebSocket)
              await createActiveMatchForOverlay(matchData);
              matchesCreated++;
              processedMatches.set(matchKey, Date.now());
              
              console.log(`🎉 MATCH CREATED: ${driver.driverName || 'Driver'} ↔ ${passenger.passengerName || 'Passenger'} (Score: ${similarity.toFixed(3)})`);
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
  }, 30000); // 30 seconds

  // ✅ FIXED: Schedule check for scheduled searches every 10 seconds (more frequent)
  setInterval(activateScheduledSearches, SCHEDULED_SEARCH_CHECK_INTERVAL);
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
      totalProcessedMatches: processedMatches.size
    }
  });
});

// ========== DEBUG & MONITORING ENDPOINTS ==========

app.get("/", (req, res) => {
  const drivers = Array.from(activeSearches.values()).filter(s => s.userType === 'driver');
  const passengers = Array.from(activeSearches.values()).filter(s => s.userType === 'passenger');
  const scheduled = Array.from(scheduledSearches.values());
  
  res.json({ 
    status: "🚀 Server running (FIXED Scheduled Search Mode)",
    timestamp: new Date().toISOString(),
    memoryStats: {
      activeSearches: activeSearches.size,
      scheduledSearches: scheduledSearches.size,
      drivers: drivers.length,
      passengers: passengers.length,
      processedMatches: processedMatches.size,
      websocketConnections: websocketServer ? websocketServer.getConnectedCount() : 0
    },
    activeDrivers: drivers.map(d => ({
      id: d.userId,
      name: d.driverName,
      type: d.userType,
      rideType: d.rideType,
      routePoints: d.routePoints?.length || 0,
      pickup: d.pickupName,
      destination: d.destinationName
    })),
    activePassengers: passengers.map(p => ({
      id: p.userId, 
      name: p.passengerName,
      type: p.userType,
      rideType: p.rideType,
      routePoints: p.routePoints?.length || 0,
      pickup: p.pickupName,
      destination: p.destinationName
    })),
    scheduledSearches: scheduled.map(s => ({
      id: s.userId,
      name: s.driverName || s.passengerName,
      type: s.userType,
      scheduledTime: s.scheduledTime,
      status: s.status,
      pickup: s.pickupName,
      destination: s.destinationName
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
      count: activeMatches.length
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
🚀 ShareWay FIXED Server Started!
📍 Port: ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
🔥 Firebase: Minimal Usage Mode
💾 Memory Cache: ENABLED
🔌 WebSocket: ENABLED
🔄 Matching: Every 30 seconds
📅 Scheduled: FIXED ACTIVATION

📊 Current Stats:
- Active Searches: ${activeSearches.size} (in memory)
- Scheduled Searches: ${scheduledSearches.size} (in memory)
- Processed Matches: ${processedMatches.size} (in memory)
- WebSocket Connections: ${websocketServer ? websocketServer.getConnectedCount() : 0}

✅ SCHEDULED SEARCHES WILL NOW ACTIVATE PROPERLY! 🎉
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
