// src/app.js - COMPLETE WORKING VERSION
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

// FIXED: Remove problematic regex preflight handler and use simple approach
// The cors middleware already handles preflight, so we don't need manual handler

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

// ========== NOTIFICATION SERVICE ==========

class NotificationService {
  constructor(db) {
    this.db = db;
  }

  async sendMatchNotification(matchData) {
    try {
      console.log(`📢 Sending match notification for: ${matchData.driverName} ↔ ${matchData.passengerName}`);
      
      const notifications = [
        {
          userId: matchData.driverId,
          type: 'match_proposal',
          title: 'New Ride Match Found!',
          message: `Passenger ${matchData.passengerName} wants to share your ride. Similarity: ${(matchData.similarityScore * 100).toFixed(1)}%`,
          data: {
            matchId: matchData.matchId,
            driverId: matchData.driverId,
            passengerId: matchData.passengerId,
            passengerName: matchData.passengerName,
            similarityScore: matchData.similarityScore,
            action: 'view_match'
          },
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        },
        {
          userId: matchData.passengerId,
          type: 'match_proposal',
          title: 'Driver Match Found!',
          message: `Driver ${matchData.driverName} is going your way. Similarity: ${(matchData.similarityScore * 100).toFixed(1)}%`,
          data: {
            matchId: matchData.matchId,
            driverId: matchData.driverId,
            passengerId: matchData.passengerId,
            driverName: matchData.driverName,
            similarityScore: matchData.similarityScore,
            action: 'view_match'
          },
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        }
      ];

      const batch = this.db.batch();
      notifications.forEach(notification => {
        const notificationRef = this.db.collection('notifications').doc();
        batch.set(notificationRef, notification);
      });
      
      await batch.commit();
      
      console.log(`✅ Notifications sent to both users for match ${matchData.matchId}`);
      
      await this.db.collection('potential_matches').doc(matchData.matchId).update({
        notificationSent: true,
        notifiedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      return true;
      
    } catch (error) {
      console.error('❌ Error sending match notification:', error);
      return false;
    }
  }

  async getUserNotifications(userId, limit = 20) {
    try {
      const snapshot = await this.db.collection('notifications')
        .where('userId', '==', userId)
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();
      
      return snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
    } catch (error) {
      console.error('Error getting user notifications:', error);
      return [];
    }
  }

  async markNotificationAsRead(notificationId) {
    try {
      await this.db.collection('notifications').doc(notificationId).update({
        read: true,
        readAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return true;
    } catch (error) {
      console.error('Error marking notification as read:', error);
      return false;
    }
  }
}

const notificationService = new NotificationService(db);

// ========== FIXED DEDUPLICATION SYSTEM ==========

const processedMatches = new Map();
const MAX_MATCH_AGE = 300000; // 5 minutes

// Clean old matches from tracking
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [key, timestamp] of processedMatches.entries()) {
    if (now - timestamp > MAX_MATCH_AGE) {
      processedMatches.delete(key);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`🧹 Cleaned ${cleanedCount} old matches from deduplication cache`);
  }
}, 60000);

// Generate match key for deduplication
const generateMatchKey = (driverId, passengerId, similarity) => {
  return `${driverId}_${passengerId}_${Math.round(similarity * 1000)}`;
};

// ========== ENHANCED MATCHING SERVICE WITH NOTIFICATIONS ==========

const startEnhancedMatching = () => {
  console.log('🔄 Starting Enhanced Matching Service with Notifications...');
  
  setInterval(async () => {
    try {
      console.log('🎯 Running ENHANCED matching with notifications...');
      
      const [activeDrivers, activePassengers] = await Promise.all([
        db.collection('active_searches')
          .where('userType', '==', 'driver')
          .where('status', '==', 'searching')
          .get(),
        db.collection('active_searches')
          .where('userType', '==', 'passenger') 
          .where('status', '==', 'searching')
          .get()
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
      
      for (const driver of drivers) {
        for (const passenger of passengers) {
          totalComparisons++;
          
          if (!driver.routePoints || !passenger.routePoints || 
              driver.routePoints.length === 0 || passenger.routePoints.length === 0) {
            continue;
          }
          
          const passengerCount = passenger.passengerCount || 1;
          const hasSeats = routeMatching.hasCapacity(driver, passengerCount);
          
          if (!hasSeats) continue;
          
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
          
          if (similarity > 0.5) {
            const matchKey = generateMatchKey(driver.driverId, passenger.passengerId, similarity);
            
            if (!processedMatches.has(matchKey)) {
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
                timestamp: new Date().toISOString(),
                status: 'proposed',
                notificationSent: false
              };
              
              highQualityMatches.push(matchData);
              processedMatches.set(matchKey, Date.now());
              
              console.log(`✅ HIGH-QUALITY MATCH: ${driverName} ↔ ${passengerName} (Score: ${similarity.toFixed(3)})`);
            } else {
              console.log(`🔄 Skipping duplicate match: ${driverName} ↔ ${passengerName}`);
            }
          }
        }
      }
      
      console.log(`📈 Matching Stats: ${totalComparisons} comparisons, ${highQualityMatches.length} high-quality matches`);
      
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
        
        let notificationCount = 0;
        for (const match of highQualityMatches) {
          const success = await notificationService.sendMatchNotification(match);
          if (success) notificationCount++;
        }
        
        console.log(`📢 Notifications sent for ${notificationCount} matches`);
      } else {
        console.log('ℹ️  No high-quality matches found this cycle');
      }
      
    } catch (error) {
      console.error('❌ Enhanced matching error:', error);
    }
  }, 20000);
};

// ========== BASIC ROUTES ==========

app.get("/", (req, res) => {
  res.json({ 
    status: "🚀 ShareWay Backend is running!",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    firebase: "connected",
    cors: "enabled",
    matching: "enhanced_active",
    notifications: "enabled"
  });
});

app.get("/health", async (req, res) => {
  try {
    await db.collection('health_checks').doc('server').set({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      message: 'Health check ping'
    }, { merge: true });

    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      firebase: "connected",
      matching_service: "active",
      notification_service: "active",
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (error) {
    res.status(503).json({
      status: "unhealthy",
      error: error.message
    });
  }
});

app.get("/api", (req, res) => {
  res.json({
    name: "ShareWay API",
    version: "2.1.0",
    status: "operational",
    firebase: "connected",
    matching: "enhanced_active",
    notifications: "enabled",
    endpoints: {
      health: "GET /health",
      api_info: "GET /api",
      
      matching: {
        search: "POST /api/match/search",
        potential: "GET /api/match/potential/:userId",
        proposals: "GET /api/match/proposals/:userId",
        accept: "POST /api/match/accept"
      },
      
      notifications: {
        list: "GET /api/notifications/:userId",
        mark_read: "POST /api/notifications/:notificationId/read"
      },
      
      driver: {
        start_search: "POST /api/driver/start-search",
        stop_search: "POST /api/driver/stop-search",
        status: "GET /api/driver/status/:driverId"
      },
      
      passenger: {
        start_search: "POST /api/passenger/start-search",
        stop_search: "POST /api/passenger/stop-search",
        status: "GET /api/passenger/status/:passengerId"
      }
    }
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
      routePoints
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

// ========== NOTIFICATION ENDPOINTS ==========

app.get("/api/notifications/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 20 } = req.query;
    
    const notifications = await notificationService.getUserNotifications(userId, parseInt(limit));
    
    res.json({
      success: true,
      notifications,
      count: notifications.length,
      unreadCount: notifications.filter(n => !n.read).length
    });
    
  } catch (error) {
    console.error('Error getting notifications:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/api/notifications/:notificationId/read", async (req, res) => {
  try {
    const { notificationId } = req.params;
    
    const success = await notificationService.markNotificationAsRead(notificationId);
    
    if (success) {
      res.json({
        success: true,
        message: 'Notification marked as read'
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Notification not found'
      });
    }
    
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========== MATCH MANAGEMENT ENDPOINTS ==========

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
      count: matches.length
    });
    
  } catch (error) {
    console.error('Error getting potential matches:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

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
    
    await db.collection('potential_matches').doc(matchId).update({
      status: 'accepted',
      acceptedBy: userId,
      acceptedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`✅ Match ${matchId} accepted by ${userId}`);
    
    res.json({
      success: true,
      message: 'Match accepted successfully',
      matchId
    });
    
  } catch (error) {
    console.error('Error accepting match:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Global error handling middleware
app.use((error, req, res, next) => {
  console.error('🔥 Global Error Handler:', error);
  res.status(500).json({
    success: false,
    error: error.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.originalUrl
  });
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 ShareWay Enhanced Server Started!
📍 Port: ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
🔥 Firebase: Connected
🔄 Enhanced Matching: ACTIVE
📢 Notifications: ENABLED
📅 Started at: ${new Date().toISOString()}

Enhanced Features:
✅ Fixed CORS Configuration - No more PathError
✅ Fixed Deduplication System - Using Map instead of Set
✅ Quality Filtering - 0.5+ similarity scores  
✅ Notification System - Real-time match alerts
✅ Reduced Spam - Runs every 20 seconds

🔄 Enhanced Matching Service: ACTIVE (runs every 20 seconds)
🎯 Quality Threshold: 0.5+ similarity score
🛡️  Deduplication: FIXED & WORKING
📢 Notifications: ACTIVE

Ready for high-quality matching with notifications! 🎉
    `);
  });

  // Start the enhanced matching service
  startEnhancedMatching();

  server.on('error', (error) => {
    console.error('❌ Server error:', error);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server gracefully...');
    server.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
  });
}

module.exports = { app, db, admin };
