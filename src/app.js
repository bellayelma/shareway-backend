// src/app.js - UPDATED WITH WEB SOCKET SUPPORT
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

// ========== REQUEST LOGGING MIDDLEWARE ==========
app.use((req, res, next) => {
  console.log(`🔍 ${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  if (Object.keys(req.body).length > 0 && req.method === 'POST') {
    console.log('📦 Request body keys:', Object.keys(req.body));
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
const processedMatches = new Map();
const MAX_MATCH_AGE = 300000; // 5 minutes

// Clean old data from memory
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of processedMatches.entries()) {
    if (now - timestamp > MAX_MATCH_AGE) processedMatches.delete(key);
  }
  for (const [key, search] of activeSearches.entries()) {
    if (now - search.lastUpdated > MAX_MATCH_AGE) activeSearches.delete(key);
  }
}, 60000);

// Generate match key for deduplication
const generateMatchKey = (driverId, passengerId) => {
  return `${driverId}_${passengerId}`;
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

// Handle match decisions from WebSocket
const handleWebSocketMatchDecision = async (matchId, decision, userId) => {
  try {
    console.log(`🤝 WebSocket match decision: ${matchId} - ${decision} by ${userId}`);
    
    // Delete from active_matches
    await db.collection('active_matches').doc(matchId).delete();
    
    // Notify the other user via WebSocket
    const matchDoc = await db.collection('active_matches').doc(matchId).get();
    if (matchDoc.exists) {
      const matchData = matchDoc.data();
      const otherUserId = userId === matchData.driverId ? matchData.passengerId : matchData.driverId;
      
      if (websocketServer) {
        websocketServer.sendToUser(otherUserId, {
          type: 'MATCH_DECISION_UPDATE',
          data: {
            matchId: matchId,
            decision: decision,
            decidedBy: userId
          }
        });
      }
    }
    
    console.log(`✅ WebSocket match decision processed: ${matchId}`);
    
  } catch (error) {
    console.error('❌ Error handling WebSocket match decision:', error);
  }
};

// ========== OPTIMIZED MATCHING SERVICE ==========

const startOptimizedMatching = () => {
  console.log('🔄 Starting Optimized Matching Service...');
  
  // Run every 30 seconds for better responsiveness
  setInterval(async () => {
    try {
      // Get drivers and passengers from memory
      const drivers = Array.from(activeSearches.values())
        .filter(search => search.userType === 'driver' && search.status === 'searching');
      
      const passengers = Array.from(activeSearches.values())
        .filter(search => search.userType === 'passenger' && search.status === 'searching');

      console.log(`📊 Matching: ${drivers.length} drivers vs ${passengers.length} passengers`);
      
      if (drivers.length === 0 || passengers.length === 0) {
        console.log(`💤 No matches possible - Drivers: ${drivers.length}, Passengers: ${passengers.length}`);
        return;
      }

      // Log actual search details
      console.log('🚗 Drivers:', drivers.map(d => `${d.driverName || 'Unknown'} (${d.userId})`));
      console.log('👤 Passengers:', passengers.map(p => `${p.passengerName || 'Unknown'} (${p.userId})`));
      
      let matchesCreated = 0;
      
      // Optimized matching
      for (const driver of drivers) {
        for (const passenger of passengers) {
          // Quick validation
          if (!driver.routePoints || !passenger.routePoints || 
              driver.routePoints.length === 0 || passenger.routePoints.length === 0) {
            continue;
          }

          // Check capacity
          const passengerCount = passenger.passengerCount || 1;
          const hasSeats = routeMatching.hasCapacity(driver, passengerCount);
          if (!hasSeats) continue;

          // Calculate similarity
          const similarity = routeMatching.calculateRouteSimilarity(
            passenger.routePoints,
            driver.routePoints,
            { 
              similarityThreshold: 0.001, 
              maxDistanceThreshold: 50.0 // Increased for testing
            }
          );

          console.log(`🔍 ${driver.driverName || 'Driver'} ↔ ${passenger.passengerName || 'Passenger'}: Score=${similarity.toFixed(3)}`);

          // Process matches with lower threshold for testing
          if (similarity > 0.1) {
            const matchKey = generateMatchKey(driver.userId, passenger.userId);
            
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
                timestamp: new Date().toISOString()
              };

              // Create overlay match (now uses WebSocket)
              await createActiveMatchForOverlay(matchData);
              matchesCreated++;
              processedMatches.set(matchKey, Date.now());
              
              console.log(`🎉 MATCH CREATED: ${driver.driverName || 'Driver'} ↔ ${passenger.passengerName || 'Passenger'} (Score: ${similarity.toFixed(3)})`);
            }
          }
        }
      }

      if (matchesCreated > 0) {
        console.log(`📱 Created ${matchesCreated} overlay matches`);
      } else {
        console.log('ℹ️  No matches found - similarity too low or duplicates');
      }
      
    } catch (error) {
      console.error('❌ Matching error:', error);
    }
  }, 30000); // Reduced to 30 seconds for better testing
};

// ========== CORE SEARCH STORAGE FUNCTION ==========

const storeSearchInMemory = (searchData) => {
  const { userId, userType } = searchData;
  
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
    status: 'searching',
    lastUpdated: Date.now()
  };

  // Store in memory
  activeSearches.set(userId, enhancedSearchData);
  
  const displayName = actualUserType === 'driver' ? driverName : passengerName;
  console.log(`✅ ${actualUserType} search stored: ${displayName} (ID: ${userId})`);
  console.log(`📊 Total active searches: ${activeSearches.size}`);
  
  return enhancedSearchData;
};

// ========== MATCH SEARCH ENDPOINT ==========

app.post("/api/match/search", async (req, res) => {
  try {
    console.log('🎯 === MATCH SEARCH ENDPOINT CALLED ===');
    
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
      userType: userType,
      driverName: driverName,
      passengerName: passengerName,
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
      matches: [],
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

// ========== WEB SOCKET ENDPOINTS ==========

// WebSocket status endpoint
app.get("/api/websocket/status", (req, res) => {
  if (!websocketServer) {
    return res.json({ 
      success: false, 
      message: 'WebSocket server not initialized' 
    });
  }
  
  res.json({
    success: true,
    connectedClients: websocketServer.getConnectedCount(),
    connectedUsers: websocketServer.getConnectedUsers(),
    serverTime: new Date().toISOString(),
    totalActiveSearches: activeSearches.size,
    totalProcessedMatches: processedMatches.size
  });
});

// Test WebSocket message endpoint
app.post("/api/websocket/test/:userId", (req, res) => {
  const { userId } = req.params;
  const { message } = req.body;
  
  if (!websocketServer) {
    return res.status(500).json({ 
      success: false, 
      error: 'WebSocket server not available' 
    });
  }
  
  const sent = websocketServer.sendToUser(userId, {
    type: 'TEST_MESSAGE',
    data: message || 'Test message from server',
    timestamp: Date.now(),
    serverTime: new Date().toISOString()
  });
  
  res.json({
    success: sent,
    message: sent ? 'Message sent successfully' : 'User not connected',
    userId: userId
  });
});

// ========== DEBUG & MONITORING ENDPOINTS ==========

app.get("/", (req, res) => {
  const drivers = Array.from(activeSearches.values()).filter(s => s.userType === 'driver');
  const passengers = Array.from(activeSearches.values()).filter(s => s.userType === 'passenger');
  
  res.json({ 
    status: "🚀 Server running (WebSocket Mode)",
    timestamp: new Date().toISOString(),
    memoryStats: {
      activeSearches: activeSearches.size,
      drivers: drivers.length,
      passengers: passengers.length,
      processedMatches: processedMatches.size,
      websocketConnections: websocketServer ? websocketServer.getConnectedCount() : 0
    },
    drivers: drivers.map(d => ({
      id: d.userId,
      name: d.driverName,
      type: d.userType,
      routePoints: d.routePoints?.length || 0
    })),
    passengers: passengers.map(p => ({
      id: p.userId, 
      name: p.passengerName,
      type: p.userType,
      routePoints: p.routePoints?.length || 0
    }))
  });
});

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
      processedMatches: processedMatches.size,
      websocketConnections: websocketServer ? websocketServer.getConnectedCount() : 0
    },
    drivers: drivers.map(d => ({
      userId: d.userId,
      driverName: d.driverName,
      userType: d.userType,
      lastUpdated: new Date(d.lastUpdated).toISOString(),
      routePoints: d.routePoints ? `${d.routePoints.length} points` : 'none',
      pickup: d.pickupName,
      destination: d.destinationName
    })),
    passengers: passengers.map(p => ({
      userId: p.userId,
      passengerName: p.passengerName, 
      userType: p.userType,
      lastUpdated: new Date(p.lastUpdated).toISOString(),
      routePoints: p.routePoints ? `${p.routePoints.length} points` : 'none',
      pickup: p.pickupName,
      destination: p.destinationName
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
🚀 ShareWay Optimized Server Started!
📍 Port: ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
🔥 Firebase: Minimal Usage Mode
💾 Memory Cache: ENABLED
🔌 WebSocket: ENABLED
🔄 Matching: Every 30 seconds

📊 Current Stats:
- Active Searches: ${activeSearches.size} (in memory)
- Processed Matches: ${processedMatches.size} (in memory)
- WebSocket Connections: ${websocketServer ? websocketServer.getConnectedCount() : 0}

Ready for matching! 🎉
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
