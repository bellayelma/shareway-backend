// src/app.js - FIXED CORS for Flutter Web
const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
require("dotenv").config();

const app = express();

// FIXED: Enhanced CORS configuration for Flutter Web
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, Postman, etc.)
    if (!origin) {
      console.log('🌐 No origin - allowing request (mobile app)');
      return callback(null, true);
    }
    
    // Extensive list of allowed origins for Flutter Web
    const allowedOrigins = [
      // Flutter Web development ports
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:5000',
      'http://localhost:5001',
      'http://localhost:5354',
      'http://localhost:59873',
      'http://localhost:12345',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
      'http://127.0.0.1:5000',
      'http://127.0.0.1:5001',
      'http://127.0.0.1:5354',
      'http://127.0.0.1:59873',
      'https://localhost:3000',
      'https://localhost:3001',
      'https://localhost:5000',
      'https://localhost:5001',
      
      // Your production domains
      'https://yourdomain.com',
      process.env.FRONTEND_URL,
      
      // Allow all in development
      ...(process.env.NODE_ENV === 'development' ? ['*'] : [])
    ].filter(Boolean);

    console.log('🌐 Checking CORS for origin:', origin);
    
    // Check if origin is allowed
    const isAllowed = allowedOrigins.some(allowed => {
      if (allowed === '*') return true;
      return origin === allowed;
    });

    if (isAllowed) {
      console.log('✅ CORS allowed for origin:', origin);
      callback(null, true);
    } else {
      console.log('🚫 CORS blocked origin:', origin);
      console.log('💡 Allowed origins:', allowedOrigins);
      
      // In development, allow anyway with warning
      if (process.env.NODE_ENV === 'development') {
        console.log('⚠️  Allowing in development mode');
        callback(null, true);
      } else {
        callback(new Error(`Not allowed by CORS. Origin: ${origin}`));
      }
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
    'Access-Control-Request-Headers',
    'User-Agent'
  ],
  exposedHeaders: [
    'Content-Length',
    'Authorization'
  ]
}));

// Handle preflight requests globally
app.options('*', cors());

// Enhanced body parsing
app.use(express.json({ 
  limit: '10mb'
}));
app.use(express.urlencoded({ 
  extended: true, 
  limit: '10mb' 
}));

// Security middleware
app.use((req, res, next) => {
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  // CORS headers (additional safety)
  if (req.headers.origin) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  // Request logging
  console.log(`📨 ${new Date().toISOString()} ${req.method} ${req.path} - Origin: ${req.headers.origin || 'No Origin'}`);
  
  next();
});

// Initialize Firebase Admin
try {
  const firebaseConfig = process.env.FIREBASE_KEY ? 
    JSON.parse(process.env.FIREBASE_KEY) : 
    require('./firebase-service-account.json');

  admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
  });

  console.log('✅ Firebase Admin initialized successfully');
} catch (error) {
  console.error('❌ Firebase Admin initialization failed:', error);
  process.exit(1);
}

const db = admin.firestore();

// Enhanced Firestore settings
db.settings({
  ignoreUndefinedProperties: true
});

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ 
    status: "🚀 ShareWay Backend is running!",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    cors: {
      enabled: true,
      allowedOrigins: 'All Flutter Web ports + configured domains'
    }
  });
});

// Health check endpoint
app.get("/health", async (req, res) => {
  try {
    const healthCheck = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
      firebase: {
        connected: false
      },
      cors: {
        requestOrigin: req.headers.origin || 'No Origin',
        allowed: true
      }
    };

    // Check Firebase connection
    try {
      await db.collection('health_checks').doc('ping').set({
        timestamp: new Date(),
        message: 'Health check',
        origin: req.headers.origin
      }, { merge: true });
      
      healthCheck.firebase.connected = true;
      healthCheck.database = 'connected';
      
    } catch (firebaseError) {
      healthCheck.firebase.connected = false;
      healthCheck.database = 'disconnected';
      healthCheck.firebase.error = firebaseError.message;
    }

    res.json(healthCheck);
  } catch (error) {
    res.status(503).json({
      status: "unhealthy",
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// CORS test endpoint
app.get("/cors-test", (req, res) => {
  res.json({
    success: true,
    message: "CORS is working!",
    yourOrigin: req.headers.origin || 'No Origin Provided',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// API information endpoint
app.get("/api", (req, res) => {
  res.json({
    name: "ShareWay API",
    version: "1.0.0",
    description: "Ride sharing and matching service API",
    cors: {
      enabled: true,
      yourOrigin: req.headers.origin || 'No Origin'
    },
    endpoints: {
      matching: {
        search: "POST /api/match/search",
        accept: "POST /api/match/accept",
        reject: "POST /api/match/reject"
      },
      user: {
        start_search: "POST /api/user/start-search",
        stop_search: "POST /api/user/stop-search",
        search_status: "GET /api/user/search-status/:userId"
      },
      driver: {
        start_search: "POST /api/driver/start-search",
        stop_search: "POST /api/driver/stop-search"
      },
      passenger: {
        start_search: "POST /api/passenger/start-search",
        stop_search: "POST /api/passenger/stop-search"
      },
      test: {
        cors_test: "GET /cors-test",
        health: "GET /health"
      }
    }
  });
});

// Export db and admin before requiring routes
module.exports = { app, db, admin };

// Import and use routes AFTER exporting
console.log('🔄 Loading routes...');

try {
  const matchRoutes = require("./routes/matching");
  const userRoutes = require("./routes/user");
  const driverRoutes = require("./routes/driver");
  const passengerRoutes = require("./routes/passenger");

  // Mount routes with API prefix
  app.use("/api/match", matchRoutes);
  app.use("/api/user", userRoutes);
  app.use("/api/driver", driverRoutes);
  app.use("/api/passenger", passengerRoutes);

  console.log('✅ All routes loaded successfully');
} catch (error) {
  console.error('❌ Error loading routes:', error);
  process.exit(1);
}

// Global error handling middleware
app.use((error, req, res, next) => {
  console.error('🔥 Global Error Handler:', error.message);

  // CORS error specific handling
  if (error.message.includes('CORS')) {
    return res.status(403).json({
      success: false,
      error: 'CORS Error: ' + error.message,
      yourOrigin: req.headers.origin,
      fix: 'Contact admin to add your origin to allowed list'
    });
  }

  if (process.env.NODE_ENV === 'production') {
    return res.status(500).json({
      success: false,
      error: 'Internal Server Error'
    });
  }

  res.status(500).json({
    success: false,
    error: error.message,
    stack: error.stack,
    yourOrigin: req.headers.origin
  });
});

// FIXED: 404 handler - use express built-in 404 handling
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.originalUrl,
    method: req.method,
    yourOrigin: req.headers.origin,
    availableEndpoints: [
      '/health',
      '/cors-test',
      '/api',
      '/api/match/search',
      '/api/user/start-search',
      '/api/driver/start-search',
      '/api/passenger/start-search'
    ]
  });
});

const PORT = process.env.PORT || 3000;

// Start server only if this file is run directly
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`
🚀 ShareWay Server Started!
📍 Port: ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
📅 Started at: ${new Date().toISOString()}
🔧 CORS: ENABLED for Flutter Web

Available Endpoints:
✅ Health: GET /health
✅ CORS Test: GET /cors-test  
✅ API Info: GET /api
✅ Matching: POST /api/match/search
✅ User: POST /api/user/start-search
✅ Driver: POST /api/driver/start-search  
✅ Passenger: POST /api/passenger/start-search

Ready to accept Flutter Web requests! 🎉
    `);
  });

  // Server error handling
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`❌ Port ${PORT} is already in use`);
      process.exit(1);
    } else {
      console.error('❌ Server error:', error);
      process.exit(1);
    }
  });
}
