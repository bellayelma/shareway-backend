// src/app.js - COMPLETE FIXED VERSION WITH MATCH OVERLAY SYSTEM
const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, '../.env') });

// Import route matching utilities
const routeMatching = require("./utils/routeMatching");

const app = express();

// Enhanced CORS configuration for Flutter Web
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    
    // Allow all localhost origins for Flutter Web development
    const allowedOrigins = [
      // Flutter Web typical ports
      /^http:\/\/localhost:\d+$/,
      /^https:\/\/localhost:\d+$/,
      /^http:\/\/127\.0\.0\.1:\d+$/,
      /^https:\/\/127\.0\.0\.1:\d+$/,
      /^http:\/\/192\.168\.\d+\.\d+:\d+$/, // Local network IPs
      
      // Specific ports you might use
      'http://localhost:3000',
      'http://localhost:3001', 
      'http://localhost:5000',
      'http://localhost:5001',
      'http://localhost:8080',
      'http://localhost:8081',
      
      // Your production domains
      'https://yourdomain.com',
      process.env.FRONTEND_URL
    ].filter(Boolean);

    // Check if origin matches any allowed pattern
    const isAllowed = allowedOrigins.some(allowed => {
      if (typeof allowed === 'string') {
        return allowed === origin;
      } else if (allowed instanceof RegExp) {
        return allowed.test(origin);
      }
      return false;
    });

    if (isAllowed || process.env.NODE_ENV === 'development') {
      callback(null, true);
    } else {
      console.log('🚫 CORS blocked origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'X-Requested-With', 
    'Accept',
    'Origin',
    'Access-Control-Request-Method',
    'Access-Control-Request-Headers'
  ],
  exposedHeaders: [
    'Content-Range',
    'X-Content-Range'
  ],
  maxAge: 86400 // 24 hours
};

// Apply CORS middleware to all routes
app.use(cors(corsOptions));

// Manual preflight handler for ALL routes
app.options(/.*/, (req, res) => {
  const origin = req.headers.origin;
  
  // Check if origin is allowed
  const isAllowed = !origin || corsOptions.origin(origin, (err, allowed) => allowed);
  
  if (isAllowed) {
    res.header('Access-Control-Allow-Origin', origin || '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Max-Age', '86400');
    res.status(204).send();
  } else {
    res.status(403).json({ error: 'CORS not allowed' });
  }
});

// Body parsing middleware
app.use(express.json({ 
  limit: '10mb'
}));

app.use(express.urlencoded({ 
  extended: true, 
  limit: '10mb' 
}));

// Enhanced request logging
app.use((req, res, next) => {
  console.log(`📨 ${new Date().toISOString()} ${req.method} ${req.path}`);
  console.log(`   Origin: ${req.headers.origin || 'No origin'}`);
  next();
});

// Initialize Firebase Admin
let db;
try {
  console.log('🔄 Initializing Firebase Admin...');
  
  // Debug: Check if environment variables are loaded
  console.log('🔍 Checking environment variables...');
  console.log('   NODE_ENV:', process.env.NODE_ENV);
  console.log('   PORT:', process.env.PORT);
  console.log('   FIREBASE_KEY exists:', !!process.env.FIREBASE_KEY);
  
  if (!process.env.FIREBASE_KEY) {
    throw new Error('FIREBASE_KEY environment variable is not set. Check .env file location and format.');
  }

  const firebaseConfig = JSON.parse(process.env.FIREBASE_KEY);
  
  // Fix the private key format (replace \\n with actual newlines)
  if (firebaseConfig.private_key && typeof firebaseConfig.private_key === 'string') {
    firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, '\n');
  }

  admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig),
    databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${firebaseConfig.project_id}-default-rtdb.firebaseio.com`,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${firebaseConfig.project_id}.appspot.com`
  });

  db = admin.firestore();
  db.settings({ 
    ignoreUndefinedProperties: true
  });
  
  console.log('✅ Firebase Admin initialized successfully');
  console.log(`📊 Project: ${firebaseConfig.project_id}`);
  console.log(`📧 Service Account: ${firebaseConfig.client_email}`);
  
} catch (error) {
  console.error('❌ Firebase Admin initialization failed:', error.message);
  console.log('💡 Troubleshooting tips:');
  console.log('   1. Check if FIREBASE_KEY is properly set in .env file');
  console.log('   2. Ensure the private key is correctly formatted');
  console.log('   3. Verify the service account has proper permissions');
  console.log('   4. Make sure .env file is in the project root directory');
  process.exit(1);
}

// ========== MATCH OVERLAY SERVICE ==========

// ✅ NEW: Create active match for overlay display
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
      
      // Overlay trigger flag
      overlayTriggered: true,
      processedAt: null,
      
      // Timestamps
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Save to active_matches collection for real-time overlay
    await db.collection('active_matches').doc(matchData.matchId).set(activeMatchData);
    
    console.log(`✅ Active match created for overlay: ${matchData.matchId}`);
    return activeMatchData;
    
  } catch (error) {
    console.error('❌ Error creating active match for overlay:', error);
    return null;
  }
};

// ✅ NEW: Handle match decision
const handleMatchDecision = async (db, matchId, decision, userId) => {
  try {
    console.log(`🤝 Handling match decision: ${matchId} - ${decision} by ${userId}`);
    
    const matchRef = db.collection('potential_matches').doc(matchId);
    const matchDoc = await matchRef.get();
    
    if (!matchDoc.exists) {
      throw new Error('Match not found');
    }

    const matchData = matchDoc.data();
    
    // Update match status
    await matchRef.update({
      status: decision ? 'accepted' : 'rejected',
      decidedBy: userId,
      decidedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Clean up active match for overlay
    await db.collection('active_matches').doc(matchId).delete();

    console.log(`✅ Match ${matchId} ${decision ? 'accepted' : 'rejected'} by ${userId}`);
    
    return {
      success: true,
      matchId,
      status: decision ? 'accepted' : 'rejected'
    };
    
  } catch (error) {
    console.error('❌ Error handling match decision:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// ✅ NEW: Clean up old active matches
const cleanupExpiredMatches = async (db) => {
  try {
    const cutoffTime = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes
    
    const expiredMatches = await db.collection('active_matches')
      .where('createdAt', '<', cutoffTime)
      .get();

    const batch = db.batch();
    expiredMatches.forEach(doc => {
      batch.delete(doc.ref);
    });

    await batch.commit();
    console.log(`🧹 Cleaned up ${expiredMatches.size} expired active matches`);
    
  } catch (error) {
    console.error('❌ Error cleaning up expired matches:', error);
  }
};

// ========== DEDUPLICATION SYSTEM ==========

// ✅ FIXED: Use Map instead of Set to store timestamps
const processedMatches = new Map();
const MAX_MATCH_AGE = 300000; // 5 minutes

// Clean old matches from tracking
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of processedMatches.entries()) {
    if (now - timestamp > MAX_MATCH_AGE) {
      processedMatches.delete(key);
    }
  }
}, 60000); // Clean every minute

// Generate match key for deduplication
const generateMatchKey = (driverId, passengerId, similarity) => {
  return `${driverId}_${passengerId}_${Math.round(similarity * 1000)}`;
};

// ✅ NEW: Check if match already exists in Firestore
const checkExistingMatchInFirestore = async (db, driverId, passengerId) => {
  try {
    const matchesSnapshot = await db.collection('potential_matches')
      .where('driverId', '==', driverId)
      .where('passengerId', '==', passengerId)
      .where('status', '==', 'proposed')
      .limit(1)
      .get();
    
    return !matchesSnapshot.empty ? {
      matchId: matchesSnapshot.docs[0].id,
      ...matchesSnapshot.docs[0].data()
    } : null;
  } catch (error) {
    console.error('Error checking existing match:', error);
    return null;
  }
};

// ✅ NEW: Check if active match already exists for overlay
const checkActiveMatchInFirestore = async (db, driverId, passengerId) => {
  try {
    const activeMatchesSnapshot = await db.collection('active_matches')
      .where('driverId', '==', driverId)
      .where('passengerId', '==', passengerId)
      .where('overlayTriggered', '==', true)
      .limit(1)
      .get();
    
    return !activeMatchesSnapshot.empty;
  } catch (error) {
    console.error('Error checking active match:', error);
    return false;
  }
};

// ========== ENHANCED MATCHING SERVICE WITH OVERLAY SUPPORT ==========

const startEnhancedMatching = () => {
  console.log('🔄 Starting Enhanced Matching Service with Overlay Support...');
  
  setInterval(async () => {
    try {
      console.log('🎯 Running ENHANCED matching with overlay support...');
      
      // Get all active searches with proper error handling
      const [activeDrivers, activePassengers] = await Promise.all([
        db.collection('active_searches')
          .where('userType', '==', 'driver')
          .where('status', '==', 'searching')
          .get()
          .catch(error => {
            console.error('❌ Error fetching drivers:', error);
            return { docs: [] };
          }),
        db.collection('active_searches')
          .where('userType', '==', 'passenger') 
          .where('status', '==', 'searching')
          .get()
          .catch(error => {
            console.error('❌ Error fetching passengers:', error);
            return { docs: [] };
          })
      ]);
      
      const drivers = activeDrivers.docs.map(doc => ({ 
        id: doc.id, 
        ...doc.data(),
        driverName: doc.data().driverName || 'Unknown Driver',
        driverId: doc.data().driverId || doc.data().userId || doc.id
      }));
      
      const passengers = activePassengers.docs.map(doc => ({ 
        id: doc.id, 
        ...doc.data(),
        passengerName: doc.data().passengerName || 'Unknown Passenger',
        passengerId: doc.data().passengerId || doc.data().userId || doc.id
      }));
      
      console.log(`📊 Enhanced Matching: ${drivers.length} drivers vs ${passengers.length} passengers`);
      
      if (drivers.length === 0 || passengers.length === 0) {
        console.log('ℹ️  No active drivers or passengers to match');
        return;
      }
      
      const highQualityMatches = [];
      let totalComparisons = 0;
      
      // ✅ FIXED: Enhanced matching with proper duplicate handling
      for (const driver of drivers) {
        for (const passenger of passengers) {
          totalComparisons++;
          
          // Skip if missing critical data
          if (!driver.routePoints || !passenger.routePoints || 
              driver.routePoints.length === 0 || passenger.routePoints.length === 0) {
            continue;
          }
          
          const passengerCount = passenger.passengerCount || 1;
          const hasSeats = routeMatching.hasCapacity(driver, passengerCount);
          
          if (!hasSeats) {
            continue;
          }
          
          const similarity = routeMatching.calculateRouteSimilarity(
            passenger.routePoints,
            driver.routePoints,
            { 
              similarityThreshold: 0.001, 
              maxDistanceThreshold: 2.0,
              useHausdorffDistance: true 
            }
          );
          
          const driverName = driver.driverName || 'Unknown Driver';
          const passengerName = passenger.passengerName || 'Unknown Passenger';
          
          console.log(`🔍 ${driverName} ↔ ${passengerName}: Score=${similarity.toFixed(3)}, Seats=${hasSeats}`);
          
          // Only consider high-quality matches
          if (similarity > 0.5) {
            const matchKey = generateMatchKey(driver.driverId, passenger.passengerId, similarity);
            
            // ✅ FIXED: Check if this exact match already exists in Firestore
            const existingMatch = await checkExistingMatchInFirestore(db, driver.driverId, passenger.passengerId);
            
            if (!existingMatch) {
              const optimalPickup = routeMatching.findOptimalPickupPoint(
                passenger.pickupLocation,
                driver.routePoints
              );
              
              const matchData = {
                matchId: `match_${driver.driverId}_${passenger.passengerId}_${Date.now()}`,
                driverId: driver.driverId,
                passengerId: passenger.passengerId,
                driverName: driverName,
                passengerName: passengerName,
                driverPhotoUrl: driver.driverPhotoUrl,
                passengerPhotoUrl: passenger.passengerPhotoUrl,
                similarityScore: similarity,
                matchQuality: similarity > 0.7 ? 'excellent' : 'good',
                optimalPickupPoint: optimalPickup,
                detourDistance: routeMatching.calculateDetourDistance(
                  driver.routePoints,
                  optimalPickup,
                  passenger.destinationLocation
                ),
                // Route information for overlay
                pickupName: passenger.pickupName || driver.pickupName || 'Unknown Location',
                destinationName: passenger.destinationName || driver.destinationName || 'Unknown Destination',
                pickupLocation: passenger.pickupLocation || driver.pickupLocation,
                destinationLocation: passenger.destinationLocation || driver.destinationLocation,
                
                timestamp: new Date().toISOString(),
                status: 'proposed',
                notificationSent: false
              };
              
              highQualityMatches.push(matchData);
              // ✅ FIXED: Use .set() for Map (not .add() for Set)
              processedMatches.set(matchKey, Date.now());
              
              console.log(`✅ HIGH-QUALITY MATCH: ${driverName} ↔ ${passengerName} (Score: ${similarity.toFixed(3)})`);
            } else {
              console.log(`🔄 Skipping existing Firestore match: ${driverName} ↔ ${passengerName}`);
              
              // ✅ FIXED: But STILL create active match for overlay if it doesn't exist
              const activeMatchExists = await checkActiveMatchInFirestore(db, driver.driverId, passenger.passengerId);
              if (!activeMatchExists) {
                console.log(`📱 Creating overlay for existing match: ${driverName} ↔ ${passengerName}`);
                
                const overlayMatchData = {
                  matchId: existingMatch.matchId,
                  driverId: driver.driverId,
                  driverName: driverName,
                  passengerId: passenger.passengerId,
                  passengerName: passengerName,
                  similarityScore: similarity,
                  matchQuality: similarity > 0.7 ? 'excellent' : 'good',
                  pickupName: passenger.pickupName || driver.pickupName || 'Unknown Location',
                  destinationName: passenger.destinationName || driver.destinationName || 'Unknown Destination',
                  pickupLocation: passenger.pickupLocation || driver.pickupLocation,
                  destinationLocation: passenger.destinationLocation || driver.destinationLocation,
                  overlayTriggered: true,
                  processedAt: null,
                  createdAt: admin.firestore.FieldValue.serverTimestamp()
                };
                
                await createActiveMatchForOverlay(db, overlayMatchData);
              }
            }
          }
        }
      }
      
      console.log(`📈 Matching Stats: ${totalComparisons} comparisons, ${highQualityMatches.length} high-quality matches`);
      
      // Save matches and create overlay triggers
      if (highQualityMatches.length > 0) {
        const batch = db.batch();
        
        for (const match of highQualityMatches) {
          const matchRef = db.collection('potential_matches').doc(match.matchId);
          batch.set(matchRef, {
            ...match,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
        
        await batch.commit();
        console.log(`💾 Saved ${highQualityMatches.length} matches to Firestore`);
        
        // ✅ NEW: Create active matches for overlay display
        let overlayCount = 0;
        for (const match of highQualityMatches) {
          const activeMatch = await createActiveMatchForOverlay(db, match);
          if (activeMatch) overlayCount++;
        }
        
        console.log(`📱 Overlay triggers created for ${overlayCount} matches`);
      } else {
        console.log('ℹ️  No high-quality matches found this cycle');
      }
      
    } catch (error) {
      console.error('❌ Enhanced matching error:', error);
    }
  }, 20000); // Run every 20 seconds
};

// ========== BASIC ROUTES ==========

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ 
    status: "🚀 ShareWay Backend is running!",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    firebase: "connected",
    cors: "enabled",
    matching: "enhanced_active",
    overlay_system: "enabled",
    features: ["route_matching", "deduplication", "quality_filtering", "match_overlay"],
    allowed_origins: "localhost:* (Flutter Web), 127.0.0.1:*"
  });
});

// Health check with Firebase test
app.get("/health", async (req, res) => {
  try {
    await db.collection('health_checks').doc('server').set({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      message: 'Health check ping',
      origin: req.headers.origin || 'direct'
    }, { merge: true });

    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      firebase: "connected",
      database: "operational",
      cors: "enabled",
      matching_service: "active",
      overlay_system: "active",
      origin: req.headers.origin || 'No origin header',
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (error) {
    res.status(503).json({
      status: "unhealthy",
      timestamp: new Date().toISOString(),
      firebase: "disconnected",
      error: error.message
    });
  }
});

// API info endpoint
app.get("/api", (req, res) => {
  res.json({
    name: "ShareWay API",
    version: "2.2.0",
    status: "operational",
    firebase: "connected",
    cors: "enabled",
    matching: "enhanced_active",
    overlay_system: "enabled",
    endpoints: {
      health: "GET /health",
      api_info: "GET /api",
      cors_test: "GET /cors-test",
      
      // Enhanced Matching endpoints
      matching: {
        search: "POST /api/match/search",
        potential: "GET /api/match/potential/:userId",
        proposals: "GET /api/match/proposals/:userId",
        accept: "POST /api/match/accept", 
        reject: "POST /api/match/reject",
        cancel: "POST /api/match/cancel",
        // ✅ NEW: Overlay endpoints
        decision: "POST /api/match/decision",
        active_matches: "GET /api/match/active/:userId"
      },
      
      // Driver endpoints
      driver: {
        start_search: "POST /api/driver/start-search",
        stop_search: "POST /api/driver/stop-search",
        status: "GET /api/driver/status/:driverId",
        update_location: "POST /api/driver/update-location",
        search_status: "GET /api/driver/search-status/:driverId"
      },
      
      // Passenger endpoints
      passenger: {
        start_search: "POST /api/passenger/start-search",
        stop_search: "POST /api/passenger/stop-search",
        status: "GET /api/passenger/status/:passengerId"
      },
      
      // Admin endpoints
      admin: {
        cleanup: "POST /api/admin/cleanup",
        cleanup_matches: "POST /api/admin/cleanup-matches" // ✅ NEW
      }
    }
  });
});

// CORS test endpoint
app.get("/cors-test", (req, res) => {
  res.json({
    message: "CORS is working!",
    your_origin: req.headers.origin || 'No origin header',
    timestamp: new Date().toISOString(),
    status: "success",
    cors: "enabled"
  });
});

// ========== DRIVER ENDPOINTS ==========

app.post("/api/driver/start-search", async (req, res) => {
  try {
    const { 
      driverId, 
      driverName, 
      driverPhone,
      driverPhotoUrl,
      currentLocation, 
      vehicleType, 
      capacity, 
      vehicleInfo,
      pickupLocation,
      destinationLocation,
      pickupName,
      destinationName,
      routePoints
    } = req.body;
    
    console.log('🚗 === DRIVER START SEARCH REQUEST ===');
    console.log('👤 Driver Details:', { 
      driverId, 
      driverName: driverName || 'Unknown Driver', 
      driverPhone, 
      driverPhotoUrl: driverPhotoUrl ? 'Photo URL present' : 'No photo URL' 
    });
    console.log('📍 Route Details:', { 
      pickup: pickupName || 'Unknown Pickup', 
      destination: destinationName || 'Unknown Destination' 
    });
    console.log('🛣️  Route Points:', routePoints ? `${routePoints.length} points` : 'No route points');
    
    const searchData = {
      driverId,
      driverName: driverName || 'Unknown Driver',
      driverPhone,
      driverPhotoUrl,
      currentLocation,
      vehicleType,
      capacity,
      vehicleInfo: vehicleInfo || {},
      pickupLocation,
      destinationLocation,
      pickupName: pickupName || 'Unknown Pickup',
      destinationName: destinationName || 'Unknown Destination',
      routePoints: routePoints || [],
      status: 'searching',
      userType: 'driver',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    await db.collection('active_drivers').doc(driverId).set(searchData, { merge: true });
    await db.collection('active_searches').doc(`driver_${driverId}`).set(searchData, { merge: true });
    
    console.log('✅ Driver search started and saved to Firestore');
    
    res.json({
      success: true,
      message: 'Driver search started successfully',
      searchId: `driver_${driverId}_${Date.now()}`,
      driverId,
      status: 'searching',
      driverDetails: {
        name: driverName || 'Unknown Driver',
        phone: driverPhone,
        photo: driverPhotoUrl ? 'Present' : 'Not provided'
      }
    });
    
  } catch (error) {
    console.error('❌ Error starting driver search:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/api/driver/stop-search", async (req, res) => {
  try {
    const { driverId } = req.body;
    
    console.log('🚗 Driver stopping search:', { driverId });
    
    await db.collection('active_drivers').doc(driverId).delete();
    await db.collection('active_searches').doc(`driver_${driverId}`).delete();
    
    res.json({
      success: true,
      message: 'Driver search stopped successfully',
      driverId,
      status: 'inactive'
    });
    
  } catch (error) {
    console.error('Error stopping driver search:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/api/driver/status/:driverId", async (req, res) => {
  try {
    const { driverId } = req.params;
    
    const driverDoc = await db.collection('active_drivers').doc(driverId).get();
    
    if (driverDoc.exists) {
      res.json({
        success: true,
        status: 'active',
        data: driverDoc.data()
      });
    } else {
      res.json({
        success: true,
        status: 'inactive',
        message: 'Driver not actively searching'
      });
    }
    
  } catch (error) {
    console.error('Error getting driver status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/api/driver/update-location", async (req, res) => {
  try {
    const { driverId, location, address } = req.body;
    
    console.log('📍 Updating driver location:', { driverId, location });
    
    await db.collection('active_drivers').doc(driverId).set({
      currentLocation: location,
      address: address,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    
    res.json({
      success: true,
      message: 'Driver location updated successfully',
      driverId,
      location,
      address
    });
    
  } catch (error) {
    console.error('Error updating driver location:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/api/driver/search-status/:driverId", async (req, res) => {
  try {
    const { driverId } = req.params;
    
    const driverDoc = await db.collection('active_drivers').doc(driverId).get();
    
    if (driverDoc.exists) {
      const data = driverDoc.data();
      res.json({
        success: true,
        isSearching: true,
        searchData: data
      });
    } else {
      res.json({
        success: true,
        isSearching: false,
        message: 'Driver not in active search'
      });
    }
    
  } catch (error) {
    console.error('Error getting driver search status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========== PASSENGER ENDPOINTS ==========

app.post("/api/passenger/start-search", async (req, res) => {
  try {
    const { 
      passengerId, 
      passengerName, 
      pickupLocation, 
      destination, 
      passengerCount, 
      rideType,
      routePoints,
      passengerPhone,
      passengerPhotoUrl
    } = req.body;
    
    console.log('👤 Passenger starting search:', { 
      passengerId, 
      passengerName: passengerName || 'Unknown Passenger', 
      passengerCount, 
      rideType 
    });
    console.log('🛣️  Route Points:', routePoints ? `${routePoints.length} points` : 'No route points');
    
    const searchData = {
      passengerId,
      passengerName: passengerName || 'Unknown Passenger',
      passengerPhone: passengerPhone || '',
      passengerPhotoUrl: passengerPhotoUrl || '',
      pickupLocation,
      destination,
      passengerCount,
      rideType,
      routePoints: routePoints || [],
      status: 'searching',
      userType: 'passenger',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    await db.collection('active_passengers').doc(passengerId).set(searchData, { merge: true });
    await db.collection('active_searches').doc(`passenger_${passengerId}`).set(searchData, { merge: true });
    
    console.log('✅ Passenger search started and saved to Firestore');
    
    res.json({
      success: true,
      message: 'Passenger search started successfully',
      searchId: `passenger_${passengerId}_${Date.now()}`,
      passengerId,
      status: 'searching'
    });
    
  } catch (error) {
    console.error('Error starting passenger search:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/api/passenger/stop-search", async (req, res) => {
  try {
    const { passengerId } = req.body;
    
    console.log('👤 Passenger stopping search:', { passengerId });
    
    await db.collection('active_passengers').doc(passengerId).delete();
    await db.collection('active_searches').doc(`passenger_${passengerId}`).delete();
    
    res.json({
      success: true,
      message: 'Passenger search stopped successfully',
      passengerId,
      status: 'inactive'
    });
    
  } catch (error) {
    console.error('Error stopping passenger search:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/api/passenger/status/:passengerId", async (req, res) => {
  try {
    const { passengerId } = req.params;
    
    const passengerDoc = await db.collection('active_passengers').doc(passengerId).get();
    
    if (passengerDoc.exists) {
      res.json({
        success: true,
        status: 'active',
        data: passengerDoc.data()
      });
    } else {
      res.json({
        success: true,
        status: 'inactive',
        message: 'Passenger not actively searching'
      });
    }
    
  } catch (error) {
    console.error('Error getting passenger status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========== ENHANCED MATCHING ENDPOINT ==========

app.post("/api/match/search", async (req, res) => {
  try {
    const { 
      userId, 
      userType, 
      driverId, 
      driverName, 
      passengerId,
      passengerName,
      pickupLocation, 
      destinationLocation,
      pickupName,
      destinationName,
      capacity,
      currentPassengers,
      vehicleInfo,
      routePoints,
      passengerCount
    } = req.body;
    
    console.log('🔍 === ENHANCED MATCH SEARCH REQUEST ===');
    console.log('👤 User Info:', { userId, userType });
    console.log('📍 Route:', { 
      pickup: pickupName || 'Unknown Pickup', 
      destination: destinationName || 'Unknown Destination' 
    });
    console.log('🛣️  Route Points:', routePoints ? `${routePoints.length} points` : 'No route points');
    
    const searchData = {
      searchId: `search_${userId}_${Date.now()}`,
      userId,
      userType,
      driverId: driverId || userId,
      driverName: driverName || 'Unknown Driver',
      passengerId: passengerId || userId,
      passengerName: passengerName || 'Unknown Passenger',
      passengerCount: passengerCount || 1,
      pickupLocation,
      destinationLocation,
      pickupName: pickupName || 'Unknown Pickup',
      destinationName: destinationName || 'Unknown Destination',
      capacity: capacity || 4,
      currentPassengers: currentPassengers || 0,
      vehicleInfo: vehicleInfo || {},
      routePoints: routePoints || [],
      status: 'searching',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    await db.collection('active_searches').doc(searchData.searchId).set(searchData);
    console.log('✅ Enhanced search saved to Firestore with ID:', searchData.searchId);
    
    let matches = [];
    if (userType === 'driver') {
      const passengersSnapshot = await db.collection('active_searches')
        .where('userType', '==', 'passenger')
        .where('status', '==', 'searching')
        .get();
      
      const driverNameDisplay = driverName || 'Unknown Driver';
      console.log(`🔍 Checking ${passengersSnapshot.size} passengers for driver ${driverNameDisplay}`);
      
      for (const passengerDoc of passengersSnapshot.docs) {
        const passengerData = passengerDoc.data();
        const passengerName = passengerData.passengerName || 'Unknown Passenger';
        const passengerCount = passengerData.passengerCount || 1;
        
        if (!passengerData.routePoints || passengerData.routePoints.length === 0) {
          continue;
        }
        
        const similarity = routeMatching.calculateRouteSimilarity(
          passengerData.routePoints,
          routePoints || [],
          { similarityThreshold: 0.001, maxDistanceThreshold: 2.0 }
        );
        
        const hasSeats = routeMatching.hasCapacity(
          { capacity, currentPassengers }, 
          passengerCount
        );
        
        console.log(`📊 ${passengerName}: Similarity=${similarity.toFixed(3)}, HasSeats=${hasSeats}`);
        
        if (similarity > 0.5 && hasSeats) {
          matches.push({
            id: passengerDoc.id,
            ...passengerData,
            similarityScore: similarity,
            matchQuality: similarity > 0.7 ? 'excellent' : 'good'
          });
        }
      }
      
      matches.sort((a, b) => b.similarityScore - a.similarityScore);
      
    } else if (userType === 'passenger') {
      const driversSnapshot = await db.collection('active_searches')
        .where('userType', '==', 'driver')
        .where('status', '==', 'searching')
        .get();
      
      const passengerNameDisplay = passengerName || 'Unknown Passenger';
      console.log(`🔍 Checking ${driversSnapshot.size} drivers for passenger ${passengerNameDisplay}`);
      
      for (const driverDoc of driversSnapshot.docs) {
        const driverData = driverDoc.data();
        const driverName = driverData.driverName || 'Unknown Driver';
        
        if (!driverData.routePoints || driverData.routePoints.length === 0) {
          continue;
        }
        
        const similarity = routeMatching.calculateRouteSimilarity(
          routePoints || [],
          driverData.routePoints,
          { similarityThreshold: 0.001, maxDistanceThreshold: 2.0 }
        );
        
        const hasSeats = routeMatching.hasCapacity(driverData, passengerCount || 1);
        
        console.log(`📊 ${driverName}: Similarity=${similarity.toFixed(3)}, HasSeats=${hasSeats}`);
        
        if (similarity > 0.5 && hasSeats) {
          matches.push({
            id: driverDoc.id,
            ...driverData,
            similarityScore: similarity,
            matchQuality: similarity > 0.7 ? 'excellent' : 'good'
          });
        }
      }
      
      matches.sort((a, b) => b.similarityScore - a.similarityScore);
    }
    
    console.log(`✅ Found ${matches.length} quality matches`);
    
    res.json({
      success: true,
      message: `Enhanced search started with ${matches.length} matches`,
      searchId: searchData.searchId,
      matches: matches.slice(0, 10),
      matchCount: matches.length,
      matchingAlgorithm: 'enhanced_route_similarity_v2'
    });
    
  } catch (error) {
    console.error('❌ Error in enhanced match search:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========== MATCH OVERLAY ENDPOINTS ==========

// ✅ NEW: Get active matches for overlay
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
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ NEW: Handle match decision (accept/reject)
app.post("/api/match/decision", async (req, res) => {
  try {
    const { matchId, decision, userId } = req.body;
    
    if (!matchId || typeof decision === 'undefined' || !userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: matchId, decision, userId'
      });
    }
    
    const result = await handleMatchDecision(db, matchId, decision, userId);
    
    if (result.success) {
      res.json({
        success: true,
        message: `Match ${decision ? 'accepted' : 'rejected'} successfully`,
        matchId,
        status: result.status
      });
    } else {
      res.status(400).json(result);
    }
    
  } catch (error) {
    console.error('Error handling match decision:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========== MATCH MANAGEMENT ENDPOINTS ==========

// Get potential matches for a user
app.get("/api/match/potential/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    
    const matchesSnapshot = await db.collection('potential_matches')
      .where('status', '==', 'proposed')
      .where('driverId', '==', userId)
      .orWhere('passengerId', '==', userId)
      .orderBy('similarityScore', 'desc')
      .limit(20)
      .get();
    
    const matches = matchesSnapshot.docs.map(doc => ({
      matchId: doc.id,
      ...doc.data()
    }));
    
    res.json({
      success: true,
      matches,
      count: matches.length,
      highQualityMatches: matches.filter(m => m.similarityScore > 0.7).length
    });
    
  } catch (error) {
    console.error('Error getting potential matches:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get match proposals for a user
app.get("/api/match/proposals/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    
    const proposalsSnapshot = await db.collection('potential_matches')
      .where('status', '==', 'proposed')
      .where('driverId', '==', userId)
      .orWhere('passengerId', '==', userId)
      .orderBy('similarityScore', 'desc')
      .limit(10)
      .get();
    
    const proposals = proposalsSnapshot.docs.map(doc => ({
      proposalId: doc.id,
      ...doc.data()
    }));
    
    res.json({
      success: true,
      proposals,
      count: proposals.length
    });
    
  } catch (error) {
    console.error('Error getting match proposals:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Accept a match
app.post("/api/match/accept", async (req, res) => {
  try {
    const { matchId, userId } = req.body;
    
    const matchDoc = await db.collection('potential_matches').doc(matchId).get();
    
    if (!matchDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Match not found'
      });
    }
    
    const matchData = matchDoc.data();
    
    // Update match status
    await db.collection('potential_matches').doc(matchId).update({
      status: 'accepted',
      acceptedBy: userId,
      acceptedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // ✅ NEW: Clean up active match for overlay
    await db.collection('active_matches').doc(matchId).delete();
    
    // Remove users from active searches
    await db.collection('active_searches')
      .where('userId', 'in', [matchData.driverId, matchData.passengerId])
      .get()
      .then(snapshot => {
        const batch = db.batch();
        snapshot.docs.forEach(doc => {
          batch.update(doc.ref, { status: 'matched' });
        });
        return batch.commit();
      });
    
    console.log(`✅ Match ${matchId} accepted by ${userId}`);
    
    res.json({
      success: true,
      message: 'Match accepted successfully',
      matchId,
      matchData: {
        ...matchData,
        status: 'accepted',
        acceptedBy: userId
      }
    });
    
  } catch (error) {
    console.error('Error accepting match:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========== ADMIN ENDPOINTS ==========

// Cleanup endpoint to remove old searches
app.post("/api/admin/cleanup", async (req, res) => {
  try {
    const cutoffTime = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago
    
    const oldSearches = await db.collection('active_searches')
      .where('createdAt', '<', cutoffTime)
      .get();
    
    const batch = db.batch();
    oldSearches.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    
    await batch.commit();
    
    console.log(`🧹 Cleaned up ${oldSearches.size} old searches`);
    
    res.json({
      success: true,
      cleaned: oldSearches.size,
      message: `Cleaned up ${oldSearches.size} old searches`
    });
    
  } catch (error) {
    console.error('Error during cleanup:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ NEW: Cleanup expired matches
app.post("/api/admin/cleanup-matches", async (req, res) => {
  try {
    await cleanupExpiredMatches(db);
    
    res.json({
      success: true,
      message: 'Expired matches cleanup completed'
    });
    
  } catch (error) {
    console.error('Error during matches cleanup:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
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

// Load and mount routes (if they exist)
console.log('🔄 Loading routes...');
try {
  try {
    const matchRoutes = require("./routes/matching");
    app.use("/api/match", matchRoutes);
    console.log('✅ Matching routes loaded');
  } catch (e) {
    console.log('ℹ️  Matching routes not found, using built-in routes');
  }
  
  try {
    const userRoutes = require("./routes/user");
    app.use("/api/user", userRoutes);
    console.log('✅ User routes loaded');
  } catch (e) {
    console.log('ℹ️  User routes not found, using built-in routes');
  }
  
  try {
    const driverRoutes = require("./routes/driver");
    app.use("/api/driver", driverRoutes);
    console.log('✅ Driver routes loaded');
  } catch (e) {
    console.log('ℹ️  Driver routes not found, using built-in routes');
  }
  
  try {
    const passengerRoutes = require("./routes/passenger");
    app.use("/api/passenger", passengerRoutes);
    console.log('✅ Passenger routes loaded');
  } catch (e) {
    console.log('ℹ️  Passenger routes not found, using built-in routes');
  }

  console.log('✅ All routes loaded successfully');
} catch (error) {
  console.error('❌ Error loading routes:', error.message);
}

// Global error handling middleware
app.use((error, req, res, next) => {
  console.error('🔥 Global Error Handler:', error);
  
  if (process.env.NODE_ENV === 'production') {
    res.status(500).json({
      success: false,
      error: 'Internal Server Error'
    });
  } else {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.originalUrl,
    method: req.method,
    available_endpoints: [
      '/health',
      '/api', 
      '/cors-test',
      '/api/driver/start-search',
      '/api/driver/stop-search',
      '/api/driver/status/:driverId',
      '/api/driver/update-location',
      '/api/passenger/start-search',
      '/api/passenger/stop-search',
      '/api/match/search',
      '/api/match/potential/:userId',
      '/api/match/proposals/:userId',
      '/api/match/accept',
      '/api/match/decision', // ✅ NEW
      '/api/match/active/:userId', // ✅ NEW
      '/api/admin/cleanup',
      '/api/admin/cleanup-matches', // ✅ NEW
      '/api/debug/test-receive'
    ]
  });
});

const PORT = process.env.PORT || 3000;

// Start server
if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 ShareWay Enhanced Server Started!
📍 Port: ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
🔥 Firebase: Connected
🌐 CORS: Enabled for Flutter Web
🔄 Enhanced Matching: ACTIVE
📱 Match Overlay: ENABLED
📅 Started at: ${new Date().toISOString()}

Enhanced Features:
✅ Deduplication System - Prevents duplicate matches
✅ Quality Filtering - 0.5+ similarity scores
✅ Name Fallbacks - No more "undefined" in logs
✅ Match Overlay System - Real-time overlay triggers
✅ Reduced Spam - Runs every 20 seconds

Enhanced Endpoints:
✅ POST /api/match/search - Enhanced route matching
✅ GET /api/match/potential/:userId - Get quality matches  
✅ GET /api/match/proposals/:userId - Get match proposals
✅ POST /api/match/accept - Accept matches
✅ POST /api/match/decision - Handle match decisions (NEW)
✅ GET /api/match/active/:userId - Get active matches (NEW)

🔄 Enhanced Matching Service: ACTIVE (runs every 20 seconds)
🎯 Quality Threshold: 0.5+ similarity score
🛡️  Deduplication: ENABLED
📱 Overlay System: ACTIVE

Ready for high-quality matching with overlay system! 🎉
    `);
  });

  // Start the enhanced matching service
  startEnhancedMatching();

  // Start periodic cleanup of expired matches
  setInterval(() => {
    cleanupExpiredMatches(db);
  }, 5 * 60 * 1000); // Run every 5 minutes

  server.on('error', (error) => {
    console.error('❌ Server error:', error);
    process.exit(1);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server gracefully...');
    server.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
  });
}

// Export for testing
module.exports = { app, db, admin };
