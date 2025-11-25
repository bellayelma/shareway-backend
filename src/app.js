// src/app.js - COMPLETE VERSION WITH ALL FLUTTER ENDPOINTS
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

// ========== ALL FLUTTER COMPATIBILITY ENDPOINTS ==========

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

app.get("/health", (req, res) => {
  const drivers = Array.from(activeSearches.values()).filter(s => s.userType === 'driver');
  const passengers = Array.from(activeSearches.values()).filter(s => s.userType === 'passenger');
  
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    memoryStats: {
      activeSearches: activeSearches.size,
      drivers: drivers.length,
      passengers: passengers.length,
      processedMatches: processedMatches.size
    },
    memoryUsage: process.memoryUsage()
  });
});

// CORS test endpoint
app.get("/cors-test", (req, res) => {
  res.json({
    message: "CORS is working!",
    your_origin: req.headers.origin || 'No origin header',
    timestamp: new Date().toISOString(),
    status: "success"
  });
});

// ========== DRIVER ENDPOINTS ==========

// Enhanced driver start search with better logging
app.post("/api/driver/start-search", async (req, res) => {
  try {
    console.log('🚗 === DRIVER START SEARCH ===');
    console.log('📦 Request body:', JSON.stringify(req.body, null, 2));
    
    const { 
      driverId, 
      driverName, 
      pickupLocation,
      destinationLocation,
      pickupName,
      destinationName,
      routePoints,
      vehicleType,
      capacity,
      currentLocation
    } = req.body;
    
    if (!driverId) {
      return res.status(400).json({ success: false, error: 'driverId is required' });
    }

    const searchData = {
      userId: driverId,
      userType: 'driver',
      driverName: driverName || 'Unknown Driver',
      pickupLocation: pickupLocation || {},
      destinationLocation: destinationLocation || {},
      pickupName: pickupName || 'Unknown Pickup',
      destinationName: destinationName || 'Unknown Destination',
      routePoints: routePoints || [],
      vehicleType: vehicleType || 'car',
      capacity: capacity || 4,
      currentLocation: currentLocation || {},
      status: 'searching',
      lastUpdated: Date.now()
    };
    
    // Store in memory instead of Firestore
    activeSearches.set(driverId, searchData);
    
    console.log(`✅ Driver search stored in memory: ${driverName} (ID: ${driverId})`);
    console.log(`📊 Current active searches: ${activeSearches.size}`);
    
    res.json({
      success: true,
      message: 'Driver search started successfully',
      searchId: driverId,
      driverId: driverId,
      status: 'searching'
    });
    
  } catch (error) {
    console.error('❌ Error starting driver search:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Driver stop search
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

// Driver status
app.get("/api/driver/status/:driverId", async (req, res) => {
  try {
    const { driverId } = req.params;
    const search = activeSearches.get(driverId);
    
    if (search) {
      res.json({
        success: true,
        status: 'active',
        data: search
      });
    } else {
      res.json({
        success: true,
        status: 'inactive',
        message: 'Driver not actively searching'
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Driver update location
app.post("/api/driver/update-location", async (req, res) => {
  try {
    const { driverId, location } = req.body;
    const search = activeSearches.get(driverId);
    
    if (search) {
      search.currentLocation = location;
      search.lastUpdated = Date.now();
      console.log(`📍 Updated driver location: ${driverId}`);
    }
    
    res.json({
      success: true,
      message: 'Driver location updated',
      driverId: driverId
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Driver search status
app.get("/api/driver/search-status/:driverId", async (req, res) => {
  try {
    const { driverId } = req.params;
    const search = activeSearches.get(driverId);
    
    if (search) {
      res.json({
        success: true,
        isSearching: true,
        searchData: search
      });
    } else {
      res.json({
        success: true,
        isSearching: false,
        message: 'Driver not in active search'
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== PASSENGER ENDPOINTS ==========

app.post("/api/passenger/start-search", async (req, res) => {
  try {
    console.log('👤 === PASSENGER START SEARCH ===');
    console.log('📦 Request body:', JSON.stringify(req.body, null, 2));
    
    const { 
      passengerId, 
      passengerName, 
      pickupLocation, 
      destinationLocation, 
      passengerCount,
      routePoints,
      rideType
    } = req.body;
    
    if (!passengerId) {
      return res.status(400).json({ success: false, error: 'passengerId is required' });
    }

    const searchData = {
      userId: passengerId,
      userType: 'passenger',
      passengerName: passengerName || 'Unknown Passenger',
      passengerCount: passengerCount || 1,
      pickupLocation: pickupLocation || {},
      destinationLocation: destinationLocation || {},
      pickupName: 'Pickup Location',
      destinationName: 'Destination',
      routePoints: routePoints || [],
      rideType: rideType || 'standard',
      status: 'searching',
      lastUpdated: Date.now()
    };
    
    // Store in memory instead of Firestore
    activeSearches.set(passengerId, searchData);
    
    console.log(`✅ Passenger search stored in memory: ${passengerName} (ID: ${passengerId})`);
    console.log(`📊 Current active searches: ${activeSearches.size}`);
    
    res.json({
      success: true,
      message: 'Passenger search started successfully',
      searchId: passengerId,
      passengerId: passengerId,
      status: 'searching'
    });
    
  } catch (error) {
    console.error('❌ Error starting passenger search:', error);
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

app.get("/api/passenger/status/:passengerId", async (req, res) => {
  try {
    const { passengerId } = req.params;
    const search = activeSearches.get(passengerId);
    
    if (search) {
      res.json({
        success: true,
        status: 'active',
        data: search
      });
    } else {
      res.json({
        success: true,
        status: 'inactive',
        message: 'Passenger not actively searching'
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== MATCH ENDPOINTS ==========

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

// Get active matches for overlay
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

// Match search endpoint
app.post("/api/match/search", async (req, res) => {
  try {
    const { userId, userType } = req.body;
    
    // Use memory cache first
    const userSearch = activeSearches.get(userId);
    if (!userSearch) {
      return res.json({
        success: true,
        message: 'No active search found',
        matches: []
      });
    }

    res.json({
      success: true,
      message: 'Search active in memory',
      searchId: userId,
      matches: [] // Return empty matches to reduce processing
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get potential matches
app.get("/api/match/potential/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    
    res.json({
      success: true,
      matches: [],
      count: 0,
      highQualityMatches: 0
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get match proposals
app.get("/api/match/proposals/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    
    res.json({
      success: true,
      proposals: [],
      count: 0
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Accept match
app.post("/api/match/accept", async (req, res) => {
  try {
    const { matchId, userId } = req.body;
    
    // Clean up the active match
    await db.collection('active_matches').doc(matchId).delete();

    console.log(`✅ Match ${matchId} accepted by ${userId}`);
    
    res.json({
      success: true,
      message: 'Match accepted successfully',
      matchId
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== ADMIN ENDPOINTS ==========

app.post("/api/admin/cleanup", async (req, res) => {
  try {
    // Clean old active matches from Firestore
    const cutoffTime = new Date(Date.now() - 10 * 60 * 1000);
    const expiredMatches = await db.collection('active_matches')
      .where('createdAt', '<', cutoffTime)
      .get();

    const batch = db.batch();
    expiredMatches.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    // Clear memory caches
    const initialSize = activeSearches.size;
    const now = Date.now();
    for (const [key, search] of activeSearches.entries()) {
      if (now - search.lastUpdated > 300000) { // 5 minutes
        activeSearches.delete(key);
      }
    }

    res.json({
      success: true,
      cleanedMatches: expiredMatches.size,
      cleanedSearches: initialSize - activeSearches.size,
      activeSearches: activeSearches.size
    });
    
  } catch (error) {
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

// Debug endpoint to test data reception
app.post("/api/debug/test-receive", (req, res) => {
  console.log('=== DEBUG ENDPOINT HIT ===');
  console.log('📦 Headers:', req.headers);
  console.log('📦 Full Request Body:', JSON.stringify(req.body, null, 2));
  console.log('📦 Driver Name:', req.body?.driverName);
  console.log('📦 Passenger Name:', req.body?.passengerName);
  console.log('📦 Route Points:', req.body?.routePoints);
  console.log('========================');
  
  res.json({ 
    received: true,
    body: req.body,
    message: 'Data received successfully by backend'
  });
});

// ========== ERROR HANDLING ==========

app.use((error, req, res, next) => {
  console.error('Error:', error);
  res.status(500).json({ success: false, error: 'Internal Server Error' });
});

// 404 handler with all available endpoints
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.originalUrl,
    method: req.method,
    available_endpoints: [
      'GET /',
      'GET /health',
      'GET /cors-test',
      'POST /api/driver/start-search',
      'POST /api/driver/stop-search',
      'GET /api/driver/status/:driverId',
      'POST /api/driver/update-location',
      'GET /api/driver/search-status/:driverId',
      'POST /api/passenger/start-search',
      'POST /api/passenger/stop-search',
      'GET /api/passenger/status/:passengerId',
      'POST /api/match/search',
      'GET /api/match/active/:userId',
      'POST /api/match/decision',
      'GET /api/match/potential/:userId',
      'GET /api/match/proposals/:userId',
      'POST /api/match/accept',
      'POST /api/admin/cleanup',
      'GET /api/debug/memory',
      'POST /api/debug/test-receive'
    ]
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
