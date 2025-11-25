// src/app.js - COMPLETE UPDATED VERSION WITH ENHANCED MATCHING
const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, '../.env') });

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
      'http://localhost:8082',
      
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

// ========== ENHANCED MATCHING UTILITIES ==========

// Enhanced matching logic
const performEnhancedMatching = async (searchData) => {
  try {
    console.log('🔍 Starting enhanced matching for:', {
      userId: searchData.userId,
      userType: searchData.userType,
      rideType: searchData.rideType
    });

    let matches = [];

    if (searchData.userType === 'passenger') {
      matches = await findMatchingDrivers(searchData);
    } else if (searchData.userType === 'driver') {
      matches = await findMatchingPassengers(searchData);
    }

    // Create match proposals
    const matchProposals = await createMatchProposals(matches, searchData.rideType);
    
    console.log(`✅ Enhanced matching completed: ${matchProposals.length} proposals created`);
    return matchProposals;

  } catch (error) {
    console.error('❌ Error in enhanced matching:', error);
    return [];
  }
};

// Find matching drivers for a passenger
async function findMatchingDrivers(passengerData) {
  const matches = [];
  
  try {
    console.log(`👤 Finding drivers for passenger: ${passengerData.passengerName || passengerData.userId}`);
    
    // Get all active driver searches
    const driversSnapshot = await db.collection('active_searches')
      .where('userType', '==', 'driver')
      .where('isActive', '==', true)
      .limit(50)
      .get();

    console.log(`📊 Found ${driversSnapshot.size} active drivers`);

    for (const driverDoc of driversSnapshot.docs) {
      const driverData = driverDoc.data();
      
      // Skip if driver data is incomplete
      if (!driverData.driverId || !driverData.pickupLocation) {
        continue;
      }

      // Check ride type compatibility
      if (!isRideTypeCompatible(passengerData.rideType, driverData.searchType)) {
        continue;
      }

      // Check capacity
      const passengerCount = passengerData.passengerCount || 1;
      if (!hasCapacity(driverData, passengerCount)) {
        continue;
      }

      // Check scheduled time for scheduled rides
      if (passengerData.rideType === 'scheduled') {
        if (!isTimeCompatible(passengerData.scheduledTime, driverData.scheduledTime)) {
          continue;
        }
      }

      // Calculate route similarity
      const similarity = calculateRouteSimilarity(
        passengerData.routePoints || [passengerData.pickupLocation, passengerData.destinationLocation],
        driverData.routePoints || [driverData.pickupLocation, driverData.destinationLocation]
      );

      // Check if pickup and destination are along driver's route
      const pickupAlongRoute = isLocationAlongRoute(
        passengerData.pickupLocation,
        driverData.routePoints || [driverData.pickupLocation, driverData.destinationLocation],
        passengerData.maxWalkDistance || 0.5
      );

      const dropoffAlongRoute = isLocationAlongRoute(
        passengerData.destinationLocation,
        driverData.routePoints || [driverData.pickupLocation, driverData.destinationLocation],
        passengerData.maxWalkDistance || 0.5
      );

      // Set similarity threshold based on ride type
      const similarityThreshold = passengerData.rideType === 'immediate' ? 0.6 : 0.7;

      if (similarity >= similarityThreshold && pickupAlongRoute && dropoffAlongRoute) {
        const matchScore = calculateMatchScore(similarity, passengerData, driverData);
        
        matches.push({
          matchId: `match_${Date.now()}_${driverData.driverId}_${passengerData.userId}`,
          driverId: driverData.driverId,
          passengerId: passengerData.userId,
          similarity: similarity,
          matchScore: matchScore,
          driverData: {
            ...driverData,
            documentId: driverDoc.id
          },
          passengerData: passengerData,
          pickupLocation: passengerData.pickupLocation,
          destinationLocation: passengerData.destinationLocation,
          proposedFare: calculateProposedFare(driverData, passengerData),
          scheduledTime: passengerData.scheduledTime || driverData.scheduledTime,
          timestamp: new Date(),
          status: 'proposed',
          rideType: passengerData.rideType
        });
      }
    }

    console.log(`✅ Found ${matches.length} matching drivers`);
    return matches.sort((a, b) => b.matchScore - a.matchScore);

  } catch (error) {
    console.error('❌ Error finding matching drivers:', error);
    return [];
  }
}

// Find matching passengers for a driver
async function findMatchingPassengers(driverData) {
  const matches = [];
  
  try {
    console.log(`🚗 Finding passengers for driver: ${driverData.driverName || driverData.userId}`);
    
    // Get all active passenger searches
    const passengersSnapshot = await db.collection('active_searches')
      .where('userType', '==', 'passenger')
      .where('isActive', '==', true)
      .limit(50)
      .get();

    console.log(`📊 Found ${passengersSnapshot.size} active passengers`);

    for (const passengerDoc of passengersSnapshot.docs) {
      const passengerData = passengerDoc.data();
      
      // Skip if passenger data is incomplete
      if (!passengerData.userId || !passengerData.pickupLocation) {
        continue;
      }

      // Check ride type compatibility
      if (!isRideTypeCompatible(passengerData.rideType, driverData.searchType)) {
        continue;
      }

      // Check capacity
      const passengerCount = passengerData.passengerCount || 1;
      if (!hasCapacity(driverData, passengerCount)) {
        continue;
      }

      // Check scheduled time for scheduled rides
      if (driverData.rideType === 'scheduled') {
        if (!isTimeCompatible(driverData.scheduledTime, passengerData.scheduledTime)) {
          continue;
        }
      }

      // Calculate route similarity
      const similarity = calculateRouteSimilarity(
        passengerData.routePoints || [passengerData.pickupLocation, passengerData.destinationLocation],
        driverData.routePoints || [driverData.pickupLocation, driverData.destinationLocation]
      );

      // Check if pickup and destination are along driver's route
      const pickupAlongRoute = isLocationAlongRoute(
        passengerData.pickupLocation,
        driverData.routePoints || [driverData.pickupLocation, driverData.destinationLocation],
        passengerData.maxWalkDistance || 0.5
      );

      const dropoffAlongRoute = isLocationAlongRoute(
        passengerData.destinationLocation,
        driverData.routePoints || [driverData.pickupLocation, driverData.destinationLocation],
        passengerData.maxWalkDistance || 0.5
      );

      // Set similarity threshold based on ride type
      const similarityThreshold = driverData.rideType === 'immediate' ? 0.6 : 0.7;

      if (similarity >= similarityThreshold && pickupAlongRoute && dropoffAlongRoute) {
        const matchScore = calculateMatchScore(similarity, passengerData, driverData);
        
        matches.push({
          matchId: `match_${Date.now()}_${driverData.userId}_${passengerData.userId}`,
          driverId: driverData.userId,
          passengerId: passengerData.userId,
          similarity: similarity,
          matchScore: matchScore,
          driverData: driverData,
          passengerData: {
            ...passengerData,
            documentId: passengerDoc.id
          },
          pickupLocation: passengerData.pickupLocation,
          destinationLocation: passengerData.destinationLocation,
          proposedFare: calculateProposedFare(driverData, passengerData),
          scheduledTime: driverData.scheduledTime || passengerData.scheduledTime,
          timestamp: new Date(),
          status: 'proposed',
          rideType: driverData.rideType
        });
      }
    }

    console.log(`✅ Found ${matches.length} matching passengers`);
    return matches.sort((a, b) => b.matchScore - a.matchScore);

  } catch (error) {
    console.error('❌ Error finding matching passengers:', error);
    return [];
  }
}

// Check ride type compatibility
function isRideTypeCompatible(passengerRideType, driverSearchType) {
  if (passengerRideType === 'immediate' && driverSearchType === 'real_time') {
    return true;
  }
  if (passengerRideType === 'scheduled' && driverSearchType === 'scheduled') {
    return true;
  }
  return false;
}

// Check time compatibility for scheduled rides
function isTimeCompatible(time1, time2, flexibility = 15) {
  if (!time1 || !time2) return false;
  
  try {
    const date1 = new Date(time1);
    const date2 = new Date(time2);
    const timeDiff = Math.abs(date1 - date2) / (1000 * 60); // difference in minutes
    
    return timeDiff <= flexibility;
  } catch (error) {
    console.error('Error comparing times:', error);
    return false;
  }
}

// Calculate comprehensive match score
function calculateMatchScore(similarity, passengerData, driverData) {
  let score = similarity * 70; // Base score from route similarity

  // Capacity match bonus
  const availableSeats = (driverData.passengerCapacity || driverData.capacity || 4) - (driverData.currentPassengers || 0);
  const passengerCount = passengerData.passengerCount || 1;
  
  if (availableSeats >= passengerCount) {
    score += 15;
  }

  // Fare compatibility bonus
  const driverFare = driverData.estimatedFare;
  const passengerFare = passengerData.estimatedFare;
  
  if (driverFare && passengerFare) {
    const fareDiff = Math.abs(driverFare - passengerFare) / Math.max(driverFare, passengerFare);
    if (fareDiff <= 0.2) {
      score += 10;
    }
  }

  // Vehicle type preference match
  const preferredVehicle = passengerData.preferredVehicleType;
  const driverVehicle = driverData.vehicleInfo?.type || driverData.preferredVehicleType;
  
  if (preferredVehicle && driverVehicle && preferredVehicle === driverVehicle) {
    score += 5;
  }

  return Math.min(100, Math.max(0, score));
}

// Calculate proposed fare
function calculateProposedFare(driverData, passengerData) {
  const baseFare = 50;
  const perKmRate = 15;
  const perMinuteRate = 2;
  
  // Use provided data or defaults
  const distance = driverData.distance || passengerData.distance || 5;
  const duration = driverData.duration || passengerData.duration || 15;
  const passengerCount = passengerData.passengerCount || 1;
  
  let fare = baseFare + (distance * perKmRate) + (duration * perMinuteRate);
  
  // Adjust for multiple passengers
  if (passengerCount > 1) {
    fare *= (1 + (passengerCount - 1) * 0.2);
  }
  
  // Consider both estimates if available
  const driverEstimate = driverData.estimatedFare;
  const passengerEstimate = passengerData.estimatedFare;
  
  if (driverEstimate && passengerEstimate) {
    fare = (fare + driverEstimate + passengerEstimate) / 3;
  } else if (driverEstimate) {
    fare = (fare + driverEstimate) / 2;
  } else if (passengerEstimate) {
    fare = (fare + passengerEstimate) / 2;
  }
  
  return Math.round(fare);
}

// Create match proposals in database
async function createMatchProposals(matches, rideType) {
  const proposals = [];
  
  try {
    for (const match of matches.slice(0, 5)) { // Limit to top 5 matches
      const proposalData = {
        matchId: match.matchId,
        driverId: match.driverId,
        passengerId: match.passengerId,
        similarity: match.similarity,
        matchScore: match.matchScore,
        status: 'proposed',
        rideType: rideType,
        
        // Location information
        pickupLocation: match.pickupLocation,
        destinationLocation: match.destinationLocation,
        pickupName: match.passengerData.pickupName || 'Pickup Location',
        destinationName: match.passengerData.destinationName || 'Destination Location',
        
        // Fare and pricing
        proposedFare: match.proposedFare,
        
        // Passenger information
        passengerCount: match.passengerData.passengerCount || 1,
        passengerName: match.passengerData.passengerName || 'Passenger',
        passengerPhone: match.passengerData.passengerPhone || '',
        
        // Driver information
        driverName: match.driverData.driverName || 'Driver',
        driverPhone: match.driverData.driverPhone || '',
        vehicleInfo: match.driverData.vehicleInfo || {},
        
        // Route information
        distance: match.driverData.distance || match.passengerData.distance || 0,
        duration: match.driverData.duration || match.passengerData.duration || 0,
        
        // Scheduling
        scheduledTime: match.scheduledTime,
        
        // Timestamps
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 5 * 60000), // 5 minutes
        updatedAt: new Date()
      };

      // Save to match_proposals collection
      await db.collection('match_proposals').doc(match.matchId).set(proposalData);
      proposals.push(proposalData);
      
      console.log(`✅ Created match proposal: ${match.matchId} with score: ${Math.round(match.matchScore)}%`);
    }
    
    return proposals;
    
  } catch (error) {
    console.error('❌ Error creating match proposals:', error);
    return proposals;
  }
}

// Route matching utilities (simplified versions)
function calculateRouteSimilarity(route1, route2) {
  if (!route1 || !route2 || route1.length === 0 || route2.length === 0) return 0;
  
  try {
    // Simplified similarity calculation
    const start1 = route1[0];
    const start2 = route2[0];
    const end1 = route1[route1.length - 1];
    const end2 = route2[route2.length - 1];
    
    const startDistance = calculateDistance(start1.lat, start1.lng, start2.lat, start2.lng);
    const endDistance = calculateDistance(end1.lat, end1.lng, end2.lat, end2.lng);
    
    // Convert distances to similarity (closer = higher similarity)
    const maxDistance = 10; // km
    const startSimilarity = Math.max(0, 1 - (startDistance / maxDistance));
    const endSimilarity = Math.max(0, 1 - (endDistance / maxDistance));
    
    return (startSimilarity + endSimilarity) / 2;
  } catch (error) {
    console.error('Error calculating route similarity:', error);
    return 0;
  }
}

function isLocationAlongRoute(location, routePoints, maxDistance = 0.5) {
  if (!location || !routePoints || routePoints.length === 0) return false;
  
  try {
    // Check if location is near any point in the route
    for (const point of routePoints) {
      const distance = calculateDistance(location.lat, location.lng, point.lat, point.lng);
      if (distance <= maxDistance) {
        return true;
      }
    }
    return false;
  } catch (error) {
    console.error('Error checking location along route:', error);
    return false;
  }
}

function hasCapacity(driverData, passengerCount) {
  try {
    const capacity = driverData.passengerCapacity || driverData.capacity || 4;
    const currentPassengers = driverData.currentPassengers || 0;
    const availableSeats = capacity - currentPassengers;
    
    return availableSeats >= passengerCount;
  } catch (error) {
    console.error('Error checking capacity:', error);
    return false;
  }
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// ========== API ENDPOINTS ==========

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ 
    status: "🚀 ShareWay Backend with Enhanced Matching is running!",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    firebase: "connected",
    cors: "enabled",
    matching: "enhanced",
    allowed_origins: "localhost:* (Flutter Web), 127.0.0.1:*"
  });
});

// Health check with Firebase test
app.get("/health", async (req, res) => {
  try {
    // Test Firebase connection
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
      matching: "enhanced",
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
    name: "ShareWay API with Enhanced Matching",
    version: "2.0.0",
    status: "operational",
    firebase: "connected",
    cors: "enabled",
    matching: "enhanced",
    endpoints: {
      health: "GET /health",
      api_info: "GET /api",
      cors_test: "GET /cors-test",
      
      // Enhanced Matching endpoints
      matching: {
        enhanced_search: "POST /api/match/enhanced-search",
        search: "POST /api/match/search",
        accept: "POST /api/match/accept", 
        reject: "POST /api/match/reject",
        user_matches: "GET /api/match/user-matches/:userId"
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
    cors: "enabled",
    matching: "enhanced"
  });
});

// ========== ENHANCED MATCHING ENDPOINTS ==========

// Enhanced match search endpoint
app.post("/api/match/enhanced-search", async (req, res) => {
  try {
    const searchData = req.body;
    
    console.log('🔍 === ENHANCED MATCH SEARCH REQUEST ===');
    console.log('👤 User Info:', { 
      userId: searchData.userId, 
      userType: searchData.userType, 
      rideType: searchData.rideType 
    });
    console.log('📍 Route:', {
      pickup: searchData.pickupName,
      destination: searchData.destinationName
    });
    console.log('📦 Full Request Body:', JSON.stringify(req.body, null, 2));
    console.log('========================================');
    
    // Store the search data first
    const searchId = `enhanced_${searchData.userId}_${Date.now()}`;
    const searchDoc = {
      searchId,
      ...searchData,
      isActive: true,
      searchType: searchData.rideType === 'immediate' ? 'real_time' : 'scheduled',
      status: 'searching',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('active_searches').doc(searchId).set(searchDoc);
    console.log('✅ Enhanced search saved to Firestore with ID:', searchId);

    // Perform enhanced matching
    const matches = await performEnhancedMatching(searchData);

    res.json({
      success: true,
      matches: matches,
      totalMatches: matches.length,
      searchId: searchId,
      userType: searchData.userType,
      rideType: searchData.rideType,
      message: 'Enhanced matching completed successfully'
    });

  } catch (error) {
    console.error('❌ Error in enhanced search:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: 'Enhanced matching failed'
    });
  }
});

// Original match search endpoint (for backward compatibility)
app.post("/api/match/search", async (req, res) => {
  try {
    const searchData = req.body;
    
    console.log('🔍 Original match search request:', {
      userId: searchData.userId,
      userType: searchData.userType
    });

    // Use enhanced matching but return simplified response
    const matches = await performEnhancedMatching(searchData);

    res.json({
      success: true,
      matches: matches,
      totalMatches: matches.length,
      searchId: `search_${searchData.userId}_${Date.now()}`,
      userType: searchData.userType,
      rideType: searchData.rideType
    });

  } catch (error) {
    console.error('❌ Error in match search:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Accept match endpoint
app.post("/api/match/accept", async (req, res) => {
  try {
    const { matchId, userId, userType } = req.body;
    
    console.log(`✅ Accepting match: ${matchId} for ${userType}: ${userId}`);

    const matchDoc = await db.collection('match_proposals').doc(matchId).get();
    
    if (!matchDoc.exists) {
      return res.status(404).json({ 
        success: false, 
        error: 'Match proposal not found' 
      });
    }

    const match = matchDoc.data();

    // Update match status
    await matchDoc.ref.update({
      status: 'accepted',
      acceptedBy: userId,
      acceptedAt: new Date(),
      updatedAt: new Date()
    });

    // Create ride session
    const rideSession = {
      rideId: `ride_${Date.now()}_${match.driverId}_${match.passengerId}`,
      driverId: match.driverId,
      passengerId: match.passengerId,
      matchId: matchId,
      pickupLocation: match.pickupLocation,
      destinationLocation: match.destinationLocation,
      proposedFare: match.proposedFare,
      status: 'accepted',
      rideType: match.rideType,
      scheduledTime: match.scheduledTime,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await db.collection('active_rides').doc(rideSession.rideId).set(rideSession);

    res.json({ 
      success: true, 
      message: 'Match accepted successfully',
      rideId: rideSession.rideId,
      match: {
        ...match,
        status: 'accepted'
      }
    });

  } catch (error) {
    console.error('❌ Error accepting match:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Reject match endpoint
app.post("/api/match/reject", async (req, res) => {
  try {
    const { matchId, userId, reason } = req.body;

    console.log(`❌ Rejecting match: ${matchId} by user: ${userId}`);

    const matchDoc = await db.collection('match_proposals').doc(matchId).get();
    
    if (!matchDoc.exists) {
      return res.status(404).json({ 
        success: false, 
        error: 'Match proposal not found' 
      });
    }
    
    await matchDoc.ref.update({
      status: 'rejected',
      rejectedBy: userId,
      rejectionReason: reason || 'No reason provided',
      rejectedAt: new Date(),
      updatedAt: new Date()
    });

    res.json({ 
      success: true, 
      message: 'Match rejected successfully' 
    });

  } catch (error) {
    console.error('❌ Error rejecting match:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get user's matches
app.get("/api/match/user-matches/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { status = 'proposed', limit = 10 } = req.query;

    console.log(`📋 Getting matches for user: ${userId} with status: ${status}`);

    // Get matches where user is either driver or passenger
    const driverMatchesQuery = await db.collection('match_proposals')
      .where('status', '==', status)
      .where('driverId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(parseInt(limit))
      .get();

    const passengerMatchesQuery = await db.collection('match_proposals')
      .where('status', '==', status)
      .where('passengerId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(parseInt(limit))
      .get();

    const driverMatches = driverMatchesQuery.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    const passengerMatches = passengerMatchesQuery.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    // Combine and sort
    const allMatches = [...driverMatches, ...passengerMatches]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, parseInt(limit));

    res.json({
      success: true,
      matches: allMatches,
      total: allMatches.length
    });

  } catch (error) {
    console.error('❌ Error getting user matches:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== EXISTING DRIVER & PASSENGER ENDPOINTS ==========

// Driver endpoints (keep existing functionality)
app.post("/api/driver/start-search", async (req, res) => {
  try {
    const { driverId, driverName, driverPhone, driverPhotoUrl, currentLocation, vehicleType, capacity, vehicleInfo, pickupLocation, destinationLocation, pickupName, destinationName } = req.body;
    
    console.log('🚗 Driver starting search:', { driverId, driverName });
    
    const searchData = {
      driverId,
      driverName,
      driverPhone,
      driverPhotoUrl,
      currentLocation,
      vehicleType,
      capacity,
      vehicleInfo: vehicleInfo || {},
      pickupLocation,
      destinationLocation,
      pickupName,
      destinationName,
      userType: 'driver',
      rideType: 'immediate', // Default, can be overridden
      status: 'searching',
      isActive: true,
      searchType: 'real_time',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    await db.collection('active_searches').doc(driverId).set(searchData, { merge: true });
    
    res.json({
      success: true,
      message: 'Driver search started successfully',
      searchId: driverId,
      driverId,
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

app.post("/api/driver/stop-search", async (req, res) => {
  try {
    const { driverId } = req.body;
    
    console.log('🚗 Driver stopping search:', { driverId });
    
    await db.collection('active_searches').doc(driverId).update({
      isActive: false,
      status: 'cancelled',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
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

// Passenger endpoints (keep existing functionality)
app.post("/api/passenger/start-search", async (req, res) => {
  try {
    const { passengerId, passengerName, pickupLocation, destination, passengerCount, rideType } = req.body;
    
    console.log('👤 Passenger starting search:', { passengerId, passengerName, passengerCount, rideType });
    
    const searchData = {
      passengerId,
      passengerName,
      pickupLocation,
      destination,
      passengerCount,
      rideType,
      userType: 'passenger',
      status: 'searching',
      isActive: true,
      searchType: rideType === 'immediate' ? 'real_time' : 'scheduled',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    await db.collection('active_searches').doc(passengerId).set(searchData, { merge: true });
    
    res.json({
      success: true,
      message: 'Passenger search started successfully',
      searchId: passengerId,
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
    
    await db.collection('active_searches').doc(passengerId).update({
      isActive: false,
      status: 'cancelled',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
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

// Debug endpoint to test data reception
app.post("/api/debug/test-receive", (req, res) => {
  console.log('=== DEBUG ENDPOINT HIT ===');
  console.log('📦 Headers:', req.headers);
  console.log('📦 Full Request Body:', JSON.stringify(req.body, null, 2));
  console.log('📦 Driver Name:', req.body?.driverName);
  console.log('📦 Driver Phone:', req.body?.driverPhone);
  console.log('📦 Driver Photo:', req.body?.driverPhotoUrl);
  console.log('📦 Vehicle Info:', req.body?.vehicleInfo);
  console.log('========================');
  
  res.json({ 
    received: true,
    body: req.body,
    message: 'Data received successfully by backend',
    driverDetails: {
      name: req.body?.driverName,
      phone: req.body?.driverPhone,
      photo: req.body?.driverPhotoUrl
    }
  });
});

// Load additional routes if they exist
console.log('🔄 Loading additional routes...');
try {
  const routesToLoad = [
    { path: "./routes/matching", route: "/api/match" },
    { path: "./routes/user", route: "/api/user" },
    { path: "./routes/driver", route: "/api/driver" },
    { path: "./routes/passenger", route: "/api/passenger" }
  ];

  routesToLoad.forEach(({ path: routePath, route: routeBase }) => {
    try {
      const routeModule = require(routePath);
      app.use(routeBase, routeModule);
      console.log(`✅ ${routeBase} routes loaded`);
    } catch (e) {
      console.log(`ℹ️  ${routeBase} routes not found, using built-in routes`);
    }
  });

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
      '/api/passenger/start-search',
      '/api/passenger/stop-search',
      '/api/match/enhanced-search',
      '/api/match/search',
      '/api/match/accept',
      '/api/match/reject',
      '/api/match/user-matches/:userId',
      '/api/debug/test-receive'
    ]
  });
});

const PORT = process.env.PORT || 3000;

// Start server
if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 ShareWay Server with Enhanced Matching Started!
📍 Port: ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
🔥 Firebase: Connected
🎯 Matching: Enhanced Algorithm
🌐 CORS: Enabled for Flutter Web
📅 Started at: ${new Date().toISOString()}

Available Endpoints:
✅ Health: GET /health
✅ API Info: GET /api
✅ CORS Test: GET /cors-test
✅ Debug Test: POST /api/debug/test-receive

Enhanced Matching Endpoints:
🎯 Enhanced Search: POST /api/match/enhanced-search
✅ Original Search: POST /api/match/search
✅ Accept Match: POST /api/match/accept
✅ Reject Match: POST /api/match/reject
✅ User Matches: GET /api/match/user-matches/:userId

Driver Endpoints:
✅ Start Search: POST /api/driver/start-search
✅ Stop Search: POST /api/driver/stop-search

Passenger Endpoints:
✅ Start Search: POST /api/passenger/start-search
✅ Stop Search: POST /api/passenger/stop-search

🎯 ENHANCED MATCHING FEATURES:
• Route similarity scoring
• Capacity matching
• Time compatibility for scheduled rides
• Fare compatibility checking
• Vehicle preference matching
• Intelligent match scoring (0-100%)

Ready for Flutter Web requests! 🎉
    `);
  });

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
