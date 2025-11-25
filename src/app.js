// src/app.js - MINIMIZED FIRESTORE USAGE VERSION
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
      passengerName: matchData.passengerName,
      similarityScore: matchData.similarityScore,
      pickupName: matchData.pickupName || 'Unknown',
      destinationName: matchData.destinationName || 'Unknown',
      overlayTriggered: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('active_matches').doc(matchData.matchId).set(activeMatchData);
    console.log(`✅ Overlay match: ${matchData.driverName} ↔ ${matchData.passengerName}`);
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

      console.log(`📊 Matching: ${drivers.length} drivers vs ${passengers.length} passengers`);
      
      if (drivers.length === 0 || passengers.length === 0) return;

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

          // Only process high-quality matches
          if (similarity > 0.7) { // Increased threshold to reduce matches
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
                pickupName: passenger.pickupName || driver.pickupName,
                destinationName: passenger.destinationName || driver.destinationName,
                timestamp: new Date().toISOString()
              };

              // Create overlay match
              await createActiveMatchForOverlay(matchData);
              matchesCreated++;
              processedMatches.set(matchKey, Date.now());
            }
          }
        }
      }

      if (matchesCreated > 0) {
        console.log(`📱 Created ${matchesCreated} overlay matches`);
      }
      
    } catch (error) {
      console.error('❌ Matching error:', error);
    }
  }, 60000); // Reduced to 60 seconds
};

// ========== OPTIMIZED ENDPOINTS ==========

// Health check (no Firestore usage)
app.get("/", (req, res) => {
  res.json({ 
    status: "🚀 Server running",
    timestamp: new Date().toISOString(),
    activeSearches: activeSearches.size,
    environment: process.env.NODE_ENV || 'development'
  });
});

// Health check with minimal Firestore usage
app.get("/health", async (req, res) => {
  try {
    // Only write if absolutely necessary
    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      activeSearches: activeSearches.size,
      memoryUsage: process.memoryUsage()
    });
  } catch (error) {
    res.status(503).json({ status: "unhealthy", error: error.message });
  }
});

// ========== OPTIMIZED SEARCH ENDPOINTS ==========

// Start search - store in memory instead of Firestore
app.post("/api/driver/start-search", async (req, res) => {
  try {
    const { 
      driverId, 
      driverName, 
      pickupLocation,
      destinationLocation,
      pickupName,
      destinationName,
      routePoints
    } = req.body;
    
    const searchData = {
      userId: driverId,
      userType: 'driver',
      driverName: driverName || 'Driver',
      pickupLocation,
      destinationLocation,
      pickupName: pickupName || 'Pickup',
      destinationName: destinationName || 'Destination',
      routePoints: routePoints || [],
      status: 'searching',
      lastUpdated: Date.now()
    };
    
    // Store in memory instead of Firestore
    activeSearches.set(driverId, searchData);
    
    res.json({
      success: true,
      message: 'Search started',
      searchId: driverId
    });
    
  } catch (error) {
    console.error('Error starting search:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/passenger/start-search", async (req, res) => {
  try {
    const { 
      passengerId, 
      passengerName, 
      pickupLocation, 
      destination, 
      passengerCount,
      routePoints
    } = req.body;
    
    const searchData = {
      userId: passengerId,
      userType: 'passenger',
      passengerName: passengerName || 'Passenger',
      passengerCount: passengerCount || 1,
      pickupLocation,
      destinationLocation: destination,
      pickupName: 'Pickup',
      destinationName: 'Destination',
      routePoints: routePoints || [],
      status: 'searching',
      lastUpdated: Date.now()
    };
    
    // Store in memory instead of Firestore
    activeSearches.set(passengerId, searchData);
    
    res.json({
      success: true,
      message: 'Search started',
      searchId: passengerId
    });
    
  } catch (error) {
    console.error('Error starting search:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Stop search - remove from memory
app.post("/api/driver/stop-search", async (req, res) => {
  try {
    const { driverId } = req.body;
    activeSearches.delete(driverId);
    res.json({ success: true, message: 'Search stopped' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/passenger/stop-search", async (req, res) => {
  try {
    const { passengerId } = req.body;
    activeSearches.delete(passengerId);
    res.json({ success: true, message: 'Search stopped' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== MATCH DECISION ENDPOINT ==========

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
      message: `Match ${decision ? 'accepted' : 'rejected'}`,
      matchId
    });
    
  } catch (error) {
    console.error('Error handling match decision:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== CLEANUP ENDPOINTS ==========

// Manual cleanup endpoint
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

// ========== FALLBACK FIRESTORE ENDPOINTS (Only if needed) ==========

// Fallback endpoint for when you need to use Firestore
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

// ========== ERROR HANDLING ==========

app.use((error, req, res, next) => {
  console.error('Error:', error);
  res.status(500).json({ success: false, error: 'Internal Server Error' });
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
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
- Active Searches: 0 (in memory)
- Processed Matches: 0 (in memory)

Ready with minimal Firestore usage! 🎉
    `);
  });

  // Start the optimized matching service
  startOptimizedMatching();

  // Auto-cleanup every 10 minutes
  setInterval(async () => {
    try {
      const cutoffTime = new Date(Date.now() - 10 * 60 * 1000);
      const expiredMatches = await db.collection('active_matches')
        .where('createdAt', '<', cutoffTime)
        .get();

      const batch = db.batch();
      expiredMatches.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      
      if (expiredMatches.size > 0) {
        console.log(`🧹 Auto-cleaned ${expiredMatches.size} expired matches`);
      }
    } catch (error) {
      console.error('Auto-cleanup error:', error);
    }
  }, 10 * 60 * 1000);

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
