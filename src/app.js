// src/app.js - FIXED VERSION THAT HANDLES BOTH ENDPOINTS
const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, '../.env') });

// Import route matching utilities
const routeMatching = require("./utils/routeMatching");

const app = express();

// Basic CORS configuration
app.use(cors({
  origin: true,
  credentials: true
}));

// Body parsing middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ========== REQUEST LOGGING MIDDLEWARE ==========
app.use((req, res, next) => {
  console.log(`🔍 ${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  if (Object.keys(req.body).length > 0) {
    console.log('📦 Request body:', JSON.stringify(req.body, null, 2));
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
  
  // Fix the private key format
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

// ========== OPTIMIZED MATCHING SYSTEM ==========

// In-memory storage to minimize Firestore reads/writes
const activeSearches = new Map(); // Store searches in memory
const processedMatches = new Map();
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
  // Clean old searches
  for (const [key, search] of activeSearches.entries()) {
    if (now - search.lastUpdated > MAX_MATCH_AGE) {
      activeSearches.delete(key);
    }
  }
}, 60000);

// Generate match key for deduplication
const generateMatchKey = (driverId, passengerId) => {
  return `${driverId}_${passengerId}`; // Simplified key
};

// Optimized: Create active match with minimal Firestore usage
const createActiveMatchForOverlay = async (matchData) => {
  try {
    // Only write essential data to Firestore
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
      overlayTriggered: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('active_matches').doc(matchData.matchId).set(activeMatchData);
    console.log(`✅ Overlay match created: ${matchData.driverName} ↔ ${matchData.passengerName}`);
    return true;
    
  } catch (error) {
    console.error('❌ Error creating overlay match:', error);
    return false;
  }
};

// ========== OPTIMIZED MATCHING SERVICE ==========

const startOptimizedMatching = () => {
  console.log('🔄 Starting Optimized Matching Service...');
  
  // Reduced frequency: Run every 60 seconds instead of 20
  setInterval(async () => {
    try {
      // Get drivers and passengers from memory first
      const drivers = Array.from(activeSearches.values())
        .filter(search => search.userType === 'driver' && search.status === 'searching');
      
      const passengers = Array.from(activeSearches.values())
        .filter(search => search.userType === 'passenger' && search.status === 'searching');

      console.log(`📊 Memory Matching: ${drivers.length} drivers vs ${passengers.length} passengers`);
      
      if (drivers.length === 0 || passengers.length === 0) {
        if (drivers.length === 0 && passengers.length === 0) {
          console.log('💤 No active searches in memory');
        } else if (drivers.length === 0) {
          console.log('💤 No active drivers in memory');
        } else {
          console.log('💤 No active passengers in memory');
        }
        return;
      }

      console.log(`🎯 Processing ${drivers.length} drivers and ${passengers.length} passengers...`);
      
      let matchesCreated = 0;
      
      // Optimized matching with minimal operations
      for (const driver of drivers) {
        for (const passenger of passengers) {
          // Quick validation
          if (!driver.routePoints || !passenger.routePoints || 
              driver.routePoints.length === 0 || passenger.routePoints.length === 0) {
            continue;
          }

          // Check capacity quickly
          const passengerCount = passenger.passengerCount || 1;
          const hasSeats = routeMatching.hasCapacity(driver, passengerCount);
          if (!hasSeats) continue;

          // Calculate similarity
          const similarity = routeMatching.calculateRouteSimilarity(
            passenger.routePoints,
            driver.routePoints,
            { 
              similarityThreshold: 0.001, 
              maxDistanceThreshold: 2.0
            }
          );

          console.log(`🔍 ${driver.driverName} ↔ ${passenger.passengerName}: Score=${similarity.toFixed(3)}`);

          // Only process high-quality matches
          if (similarity > 0.5) { // Lowered threshold for testing
            const matchKey = generateMatchKey(driver.userId, passenger.userId);
            
            // Skip if recently processed
            if (!processedMatches.has(matchKey)) {
              const matchData = {
                matchId: `match_${driver.userId}_${passenger.userId}_${Date.now()}`,
                driverId: driver.userId,
                driverName: driver.driverName || 'Driver',
                passengerId: passenger.userId,
                passengerName: passenger.passengerName || 'Passenger',
                similarityScore: similarity,
                pickupName: passenger.pickupName || driver.pickupName || 'Unknown Location',
                destinationName: passenger.destinationName || driver.destinationName || 'Unknown Destination',
                pickupLocation: passenger.pickupLocation || driver.pickupLocation,
                destinationLocation: passenger.destinationLocation || driver.destinationLocation,
                timestamp: new Date().toISOString()
              };

              // Create overlay match
              await createActiveMatchForOverlay(matchData);
              matchesCreated++;
              processedMatches.set(matchKey, Date.now());
              
              console.log(`🎉 MATCH CREATED: ${driver.driverName} ↔ ${passenger.passengerName} (Score: ${similarity.toFixed(3)})`);
            }
          }
        }
      }

      if (matchesCreated > 0) {
        console.log(`📱 Created ${matchesCreated} overlay matches`);
      } else {
        console.log('ℹ️  No matches found this cycle');
      }
      
    } catch (error) {
      console.error('❌ Matching error:', error);
    }
  }, 60000); // Reduced to 60 seconds
};

// ========== CORE SEARCH STORAGE FUNCTION ==========

// Universal function to store search in memory (used by both endpoints)
const storeSearchInMemory = (searchData) => {
  const { userId, userType } = searchData;
  
  if (!userId) {
    throw new Error('userId is required');
  }

  // Enhanced search data with all required fields
  const enhancedSearchData = {
    userId: userId,
    userType: userType,
    driverName: searchData.driverName || 'Unknown Driver',
    passengerName: searchData.passengerName || 'Unknown Passenger',
    pickupLocation: searchData.pickupLocation || {},
    destinationLocation: searchData.destinationLocation || {},
    pickupName: searchData.pickupName || 'Unknown Pickup',
    destinationName: searchData.destinationName || 'Unknown Destination',
    routePoints: searchData.routePoints || [],
    passengerCount: searchData.passengerCount || 1,
    capacity: searchData.capacity || 4,
    vehicleType: searchData.vehicleType || 'car',
    status: 'searching',
    lastUpdated: Date.now()
  };

  // Store in memory
  activeSearches.set(userId, enhancedSearchData);
  
  console.log(`✅ ${userType} search stored in memory: ${enhancedSearchData.driverName || enhancedSearchData.passengerName} (ID: ${userId})`);
  console.log(`📊 Current active searches: ${activeSearches.size}`);
  
  return enhancedSearchData;
};

// ========== COMPATIBILITY ENDPOINTS ==========

// Health check with memory stats
app.get("/", (req, res) => {
  const drivers = Array.from(activeSearches.values()).filter(s => s.userType === 'driver');
  const passengers = Array.from(activeSearches.values()).filter(s => s.userType === 'passenger');
  
  res.json({ 
    status: "🚀 Server running (Memory Mode)",
    timestamp: new Date().toISOString(),
    memoryStats: {
      activeSearches: activeSearches.size,
      drivers: drivers.length,
      passengers: passengers.length,
      processedMatches: processedMatches.size
    },
    environment: process.env.NODE_ENV || 'development'
  });
});

// ========== MATCH SEARCH ENDPOINT (YOUR FLUTTER APP'S ENDPOINT) ==========

// ✅ FIXED: This is the endpoint your Flutter app is calling
app.post("/api/match/search", async (req, res) => {
  try {
    console.log('🎯 === MATCH SEARCH ENDPOINT CALLED ===');
    
    const { 
      userId, 
      userType, 
      driverId,
      driverName,
      pickupLocation,
      destinationLocation,
      pickupName,
      destinationName,
      routePoints,
      capacity,
      passengerCount
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
      userType: userType || 'driver', // Default to driver
      driverName: driverName,
      pickupLocation: pickupLocation,
      destinationLocation: destinationLocation,
      pickupName: pickupName,
      destinationName: destinationName,
      routePoints: routePoints,
      capacity: capacity,
      passengerCount: passengerCount
    };

    storeSearchInMemory(searchData);

    // Return success response
    res.json({
      success: true,
      message: 'Search started successfully',
      searchId: `search_${actualUserId}_${Date.now()}`,
      userId: actualUserId,
      matches: [], // Empty matches to reduce processing
      matchCount: 0,
      matchingAlgorithm: 'enhanced_route_similarity_v2'
    });
    
  } catch (error) {
    console.error('❌ Error in match search:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== DRIVER SPECIFIC ENDPOINTS ==========

app.post("/api/driver/start-search", async (req, res) => {
  try {
    console.log('🚗 === DRIVER START SEARCH ENDPOINT ===');
    
    const { 
      driverId, 
      driverName, 
      pickupLocation,
      destinationLocation,
      pickupName,
      destinationName,
      routePoints,
      capacity
    } = req.body;
    
    if (!driverId) {
      return res.status(400).json({ 
        success: false, 
        error: 'driverId is required' 
      });
    }

    // Store the search in memory
    const searchData = {
      userId: driverId,
      userType: 'driver',
      driverName: driverName,
      pickupLocation: pickupLocation,
      destinationLocation: destinationLocation,
      pickupName: pickupName,
      destinationName: destinationName,
      routePoints: routePoints,
      capacity: capacity
    };

    storeSearchInMemory(searchData);

    res.json({
      success: true,
      message: 'Driver search started successfully',
      searchId: driverId,
      driverId: driverId,
      status: 'searching'
    });
    
  } catch (error) {
    console.error('❌ Error starting driver search:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== PASSENGER ENDPOINTS ==========

app.post("/api/passenger/start-search", async (req, res) => {
  try {
    console.log('👤 === PASSENGER START SEARCH ENDPOINT ===');
    
    const { 
      passengerId, 
      passengerName, 
      pickupLocation, 
      destinationLocation, 
      passengerCount,
      routePoints
    } = req.body;
    
    if (!passengerId) {
      return res.status(400).json({ 
        success: false, 
        error: 'passengerId is required' 
      });
    }

    // Store the search in memory
    const searchData = {
      userId: passengerId,
      userType: 'passenger',
      passengerName: passengerName,
      pickupLocation: pickupLocation,
      destinationLocation: destinationLocation,
      passengerCount: passengerCount,
      routePoints: routePoints
    };

    storeSearchInMemory(searchData);

    res.json({
      success: true,
      message: 'Passenger search started successfully',
      searchId: passengerId,
      passengerId: passengerId,
      status: 'searching'
    });
    
  } catch (error) {
    console.error('❌ Error starting passenger search:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== OTHER COMPATIBILITY ENDPOINTS ==========

app.post("/api/driver/stop-search", async (req, res) => {
  try {
    const { driverId } = req.body;
    console.log(`🚗 Stopping driver search: ${driverId}`);
    
    const existed = activeSearches.has(driverId);
    activeSearches.delete(driverId);
    
    console.log(`✅ Driver search stopped: ${driverId} (existed: ${existed})`);
    console.log(`📊 Remaining active searches: ${activeSearches.size}`);
    
    res.json({ 
      success: true, 
      message: 'Driver search stopped successfully',
      driverId: driverId,
      status: 'inactive'
    });
  } catch (error) {
    console.error('Error stopping driver search:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/passenger/stop-search", async (req, res) => {
  try {
    const { passengerId } = req.body;
    console.log(`👤 Stopping passenger search: ${passengerId}`);
    
    const existed = activeSearches.has(passengerId);
    activeSearches.delete(passengerId);
    
    console.log(`✅ Passenger search stopped: ${passengerId} (existed: ${existed})`);
    console.log(`📊 Remaining active searches: ${activeSearches.size}`);
    
    res.json({ 
      success: true, 
      message: 'Passenger search stopped successfully',
      passengerId: passengerId,
      status: 'inactive'
    });
  } catch (error) {
    console.error('Error stopping passenger search:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== MATCH ENDPOINTS ==========

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

    // Clean up the active match
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

// ========== DEBUG ENDPOINTS ==========

// Debug endpoint to see current memory state
app.get("/api/debug/memory", (req, res) => {
  const drivers = Array.from(activeSearches.values()).filter(s => s.userType === 'driver');
  const passengers = Array.from(activeSearches.values()).filter(s => s.userType === 'passenger');
  
  res.json({
    success: true,
    memoryStats: {
      totalSearches: activeSearches.size,
      drivers: drivers.length,
      passengers: passengers.length,
      processedMatches: processedMatches.size
    },
    drivers: drivers.map(d => ({
      userId: d.userId,
      driverName: d.driverName,
      lastUpdated: new Date(d.lastUpdated).toISOString(),
      routePoints: d.routePoints ? `${d.routePoints.length} points` : 'none'
    })),
    passengers: passengers.map(p => ({
      userId: p.userId,
      passengerName: p.passengerName,
      lastUpdated: new Date(p.lastUpdated).toISOString(),
      routePoints: p.routePoints ? `${p.routePoints.length} points` : 'none'
    }))
  });
});

// ========== ERROR HANDLING ==========

app.use((error, req, res, next) => {
  console.error('Error:', error);
  res.status(500).json({ success: false, error: 'Internal Server Error' });
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.originalUrl,
    method: req.method
  });
});

// ========== START SERVER ==========

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 ShareWay Optimized Server Started!
📍 Port: ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
🔥 Firebase: Minimal Usage Mode
💾 Memory Cache: ENABLED
🔄 Matching: Every 60 seconds

🔥 FIREBASE QUOTA OPTIMIZATIONS:
✅ Searches stored in MEMORY instead of Firestore
✅ Matching runs every 60s (reduced from 20s)
✅ Only essential data written to Firestore
✅ In-memory duplicate prevention
✅ Automatic cleanup of old data
✅ Reduced document sizes
✅ Minimal read operations

📊 Current Stats:
- Active Searches: ${activeSearches.size} (in memory)
- Processed Matches: ${processedMatches.size} (in memory)

Ready with minimal Firestore usage! 🎉
    `);
  });

  // Start the optimized matching service
  startOptimizedMatching();

  server.on('error', (error) => {
    console.error('❌ Server error:', error);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    server.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
  });
}

module.exports = { app, db, admin };
