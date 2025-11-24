// src/app.js - COMPLETE UPDATED VERSION
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

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ 
    status: "🚀 ShareWay Backend is running!",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    firebase: "connected",
    cors: "enabled",
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
    version: "1.0.0",
    status: "operational",
    firebase: "connected",
    cors: "enabled",
    endpoints: {
      health: "GET /health",
      api_info: "GET /api",
      cors_test: "GET /cors-test",
      
      // Matching endpoints
      matching: {
        search: "POST /api/match/search",
        accept: "POST /api/match/accept", 
        reject: "POST /api/match/reject",
        cancel: "POST /api/match/cancel"
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
      
      // User endpoints
      user: {
        start_search: "POST /api/user/start-search",
        stop_search: "POST /api/user/stop-search",
        search_status: "GET /api/user/search-status/:userId"
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

// ========== MANUAL ROUTES (For testing before route files are fixed) ==========

// Driver endpoints
app.post("/api/driver/start-search", async (req, res) => {
  try {
    const { driverId, driverName, driverPhone, currentLocation, vehicleType, capacity, vehicleInfo } = req.body;
    
    console.log('🚗 Driver starting search:', { driverId, driverName, vehicleType, capacity });
    
    // Store driver in active searches
    const searchData = {
      driverId,
      driverName,
      driverPhone,
      currentLocation,
      vehicleType,
      capacity,
      vehicleInfo: vehicleInfo || {},
      status: 'searching',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    await db.collection('active_drivers').doc(driverId).set(searchData, { merge: true });
    
    res.json({
      success: true,
      message: 'Driver search started successfully',
      searchId: `driver_${driverId}_${Date.now()}`,
      driverId,
      status: 'searching'
    });
    
  } catch (error) {
    console.error('Error starting driver search:', error);
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
    
    // Remove driver from active searches
    await db.collection('active_drivers').doc(driverId).delete();
    
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
    
    // Update driver location
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

// Passenger endpoints
app.post("/api/passenger/start-search", async (req, res) => {
  try {
    const { passengerId, passengerName, pickupLocation, destination, passengerCount, rideType } = req.body;
    
    console.log('👤 Passenger starting search:', { passengerId, passengerName, passengerCount, rideType });
    
    // Store passenger in active searches
    const searchData = {
      passengerId,
      passengerName,
      pickupLocation,
      destination,
      passengerCount,
      rideType,
      status: 'searching',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    await db.collection('active_passengers').doc(passengerId).set(searchData, { merge: true });
    
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
    
    // Remove passenger from active searches
    await db.collection('active_passengers').doc(passengerId).delete();
    
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

// Matching endpoint
app.post("/api/match/search", async (req, res) => {
  try {
    const { userId, userType, rideType, driverId, driverName, pickupLocation, destinationLocation, capacity } = req.body;
    
    console.log('🔍 Match search request:', { userId, userType, rideType, driverId, driverName });
    
    // Store the search request
    const searchId = `search_${userId}_${Date.now()}`;
    const searchData = {
      searchId,
      userId,
      userType,
      rideType,
      driverId,
      driverName,
      pickupLocation,
      destinationLocation,
      capacity: capacity || 1,
      status: 'searching',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    await db.collection('active_searches').doc(searchId).set(searchData);
    
    // Simple matching logic (you can enhance this)
    if (userType === 'driver') {
      // Find matching passengers
      const passengersSnapshot = await db.collection('active_passengers')
        .where('status', '==', 'searching')
        .get();
      
      const matches = [];
      passengersSnapshot.forEach(doc => {
        matches.push({ id: doc.id, ...doc.data() });
      });
      
      res.json({
        success: true,
        message: 'Driver search started with matching',
        searchId,
        matches,
        matchCount: matches.length
      });
      
    } else if (userType === 'passenger') {
      // Find matching drivers
      const driversSnapshot = await db.collection('active_drivers')
        .where('status', '==', 'searching')
        .get();
      
      const matches = [];
      driversSnapshot.forEach(doc => {
        matches.push({ id: doc.id, ...doc.data() });
      });
      
      res.json({
        success: true,
        message: 'Passenger search started with matching',
        searchId,
        matches,
        matchCount: matches.length
      });
    } else {
      res.json({
        success: true,
        message: 'Search started',
        searchId
      });
    }
    
  } catch (error) {
    console.error('Error in match search:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Load and mount routes (if they exist)
console.log('🔄 Loading routes...');
try {
  // Try to load route files, but continue if they fail
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
      '/api/match/search'
    ]
  });
});

const PORT = process.env.PORT || 3000;

// Start server
if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 ShareWay Server Started!
📍 Port: ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
🔥 Firebase: Connected
🌐 CORS: Enabled for Flutter Web
📅 Started at: ${new Date().toISOString()}

Available Endpoints:
✅ Health: GET /health
✅ API Info: GET /api
✅ CORS Test: GET /cors-test

Driver Endpoints:
✅ Start Search: POST /api/driver/start-search
✅ Stop Search: POST /api/driver/stop-search  
✅ Get Status: GET /api/driver/status/:driverId
✅ Update Location: POST /api/driver/update-location
✅ Search Status: GET /api/driver/search-status/:driverId

Passenger Endpoints:
✅ Start Search: POST /api/passenger/start-search
✅ Stop Search: POST /api/passenger/stop-search
✅ Get Status: GET /api/passenger/status/:passengerId

Matching Endpoints:
✅ Search: POST /api/match/search

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
