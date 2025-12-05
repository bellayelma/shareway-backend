// src/app.js - COMPLETE WORKING VERSION WITH FIRESTORE INTEGRATION
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const http = require('http');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MIDDLEWARE ====================
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Logging middleware
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// Request logging middleware
app.use((req, res, next) => {
  console.log(`📝 ${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ==================== FIREBASE INITIALIZATION ====================
console.log('🔄 Initializing Firebase...');
let db = null;
let firebaseAdmin = null;

try {
  // Check if Firebase key is provided
  if (!process.env.FIREBASE_KEY) {
    throw new Error('FIREBASE_KEY environment variable is not set');
  }

  // Parse the service account key
  const firebaseConfig = JSON.parse(process.env.FIREBASE_KEY);
  
  // Fix private key formatting (replace escaped newlines with actual newlines)
  if (firebaseConfig.private_key && typeof firebaseConfig.private_key === 'string') {
    firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, '\n');
  }

  // Initialize Firebase Admin
  admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig),
    databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${firebaseConfig.project_id}.firebaseio.com`,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${firebaseConfig.project_id}.appspot.com`
  });

  firebaseAdmin = admin;
  db = admin.firestore();
  
  // Firestore settings
  db.settings({ 
    ignoreUndefinedProperties: true,
    timestampsInSnapshots: true 
  });
  
  console.log('✅ Firebase Admin initialized successfully');
  console.log(`📁 Project: ${firebaseConfig.project_id}`);
  console.log(`📊 Database: Firestore connected`);
  
} catch (error) {
  console.error('❌ Firebase initialization failed:', error.message);
  console.error('📝 Please check your FIREBASE_KEY in .env file');
  console.error('📝 It should be a valid JSON string on a single line');
  process.exit(1);
}

// ==================== CREATE HTTP SERVER ====================
const server = http.createServer(app);

// ==================== WEBSOCKET SETUP ====================
console.log('🔄 Initializing WebSocket server...');
let websocketServer = null;

try {
  const WebSocketServer = require('./websocketServer');
  websocketServer = new WebSocketServer(server);
  console.log('✅ WebSocket server initialized');
} catch (error) {
  console.error('❌ Failed to initialize WebSocket server:', error.message);
}

// ==================== NOTIFICATION SERVICE SETUP ====================
console.log('🔄 Initializing notification service...');
try {
  const notificationService = require('./services/notificationService');
  if (notificationService && notificationService.setWebSocketServer && websocketServer) {
    notificationService.setWebSocketServer(websocketServer);
    console.log('✅ Notification service initialized');
  }
} catch (error) {
  console.log('⚠️ Notification service not available:', error.message);
}

// ==================== COLLECTION NAMES ====================
const COLLECTIONS = {
  PASSENGERS: 'passengers',
  DRIVERS: 'drivers',
  MATCHES: 'matches',
  ACTIVE_SEARCHES: 'active_searches',
  SCHEDULED_SEARCHES: 'scheduled_searches',
  ACTIVE_RIDES: 'active_rides',
  NOTIFICATIONS: 'notifications'
};

// ==================== FIREBASE HELPER FUNCTIONS ====================

// Save passenger to Firestore
const savePassengerToFirestore = async (passengerData) => {
  try {
    const passengerId = passengerData.userId || `passenger_${Date.now()}`;
    
    const passengerDoc = {
      id: passengerId,
      userId: passengerId,
      name: passengerData.name || 'Unknown Passenger',
      phone: passengerData.phone || 'Not provided',
      email: passengerData.email || '',
      profilePhoto: passengerData.profilePhoto || '',
      rating: passengerData.rating || 5.0,
      totalRides: passengerData.totalRides || 0,
      isVerified: passengerData.isVerified || false,
      preferredVehicleType: passengerData.preferredVehicleType || 'car',
      specialRequests: passengerData.specialRequests || '',
      pickupLocation: passengerData.pickupLocation || {},
      destinationLocation: passengerData.destinationLocation || {},
      pickupName: passengerData.pickupName || 'Pickup Location',
      destinationName: passengerData.destinationName || 'Destination',
      passengerCount: passengerData.passengerCount || 1,
      routePoints: passengerData.routePoints || [],
      distance: passengerData.distance || 0,
      duration: passengerData.duration || 0,
      estimatedFare: passengerData.estimatedFare || 0,
      maxWaitTime: passengerData.maxWaitTime || 30,
      rideType: passengerData.rideType || 'immediate',
      scheduledTime: passengerData.scheduledTime ? admin.firestore.Timestamp.fromDate(new Date(passengerData.scheduledTime)) : null,
      searchId: passengerData.searchId || `search_${passengerId}_${Date.now()}`,
      status: 'searching',
      matchId: null,
      matchedWith: null,
      matchStatus: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastLocationUpdate: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection(COLLECTIONS.PASSENGERS).doc(passengerId).set(passengerDoc);
    
    console.log(`✅ Passenger saved to Firestore: ${passengerDoc.name}`);
    console.log(`   - Passenger ID: ${passengerId}`);
    console.log(`   - Collection: ${COLLECTIONS.PASSENGERS}`);
    
    return passengerDoc;
  } catch (error) {
    console.error('❌ Error saving passenger to Firestore:', error);
    throw error;
  }
};

// Save driver to Firestore
const saveDriverToFirestore = async (driverData) => {
  try {
    const driverId = driverData.userId || driverData.driverId || `driver_${Date.now()}`;
    
    const driverDoc = {
      id: driverId,
      userId: driverId,
      driverId: driverId,
      name: driverData.name || driverData.driverName || 'Unknown Driver',
      phone: driverData.phone || driverData.driverPhone || 'Not provided',
      email: driverData.email || '',
      profilePhoto: driverData.profilePhoto || driverData.driverPhotoUrl || '',
      rating: driverData.rating || driverData.driverRating || 5.0,
      totalRides: driverData.totalRides || 0,
      isVerified: driverData.isVerified || false,
      totalEarnings: driverData.totalEarnings || 0.0,
      completedRides: driverData.completedRides || 0,
      isOnline: driverData.isOnline || true,
      isSearching: driverData.isSearching || true,
      vehicleInfo: driverData.vehicleInfo || {
        model: driverData.vehicleModel || 'Unknown Model',
        plate: driverData.vehiclePlate || 'Unknown Plate',
        color: driverData.vehicleColor || 'Unknown Color',
        type: driverData.vehicleType || 'car',
        year: driverData.vehicleYear || 'Unknown',
        passengerCapacity: driverData.capacity || 4
      },
      vehicleType: driverData.vehicleType || 'car',
      capacity: driverData.capacity || 4,
      currentPassengers: 0,
      availableSeats: driverData.capacity || 4,
      pickupLocation: driverData.pickupLocation || {},
      destinationLocation: driverData.destinationLocation || {},
      pickupName: driverData.pickupName || 'Pickup Location',
      destinationName: driverData.destinationName || 'Destination',
      routePoints: driverData.routePoints || [],
      distance: driverData.distance || 0,
      duration: driverData.duration || 0,
      estimatedFare: driverData.estimatedFare || 0,
      maxWaitTime: driverData.maxWaitTime || 30,
      rideType: driverData.rideType || 'immediate',
      scheduledTime: driverData.scheduledTime ? admin.firestore.Timestamp.fromDate(new Date(driverData.scheduledTime)) : null,
      searchId: driverData.searchId || `search_${driverId}_${Date.now()}`,
      status: 'searching',
      matchId: null,
      matchedWith: null,
      matchStatus: null,
      passenger: null,
      currentLocation: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastLocationUpdate: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection(COLLECTIONS.DRIVERS).doc(driverId).update({
      ...driverDoc,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`✅ Driver saved to Firestore: ${driverDoc.name}`);
    console.log(`   - Driver ID: ${driverId}`);
    console.log(`   - Available Seats: ${driverDoc.availableSeats}/${driverDoc.capacity}`);
    console.log(`   - Collection: ${COLLECTIONS.DRIVERS}`);
    
    return driverDoc;
  } catch (error) {
    console.error('❌ Error saving driver to Firestore:', error);
    throw error;
  }
};

// Save match to Firestore
const saveMatchToFirestore = async (matchData) => {
  try {
    const matchId = matchData.matchId || `match_${Date.now()}_${uuidv4()}`;
    
    const matchDoc = {
      matchId: matchId,
      driverId: matchData.driverId,
      driverName: matchData.driverName || 'Unknown Driver',
      driverPhone: matchData.driverPhone || '',
      passengerId: matchData.passengerId,
      passengerName: matchData.passengerName || 'Unknown Passenger',
      passengerPhone: matchData.passengerPhone || '',
      similarityScore: matchData.similarityScore || 85,
      pickupName: matchData.pickupName || 'Pickup Location',
      destinationName: matchData.destinationName || 'Destination',
      pickupLocation: matchData.pickupLocation || {},
      destinationLocation: matchData.destinationLocation || {},
      passengerCount: matchData.passengerCount || 1,
      capacity: matchData.capacity || 4,
      vehicleType: matchData.vehicleType || 'car',
      rideType: matchData.rideType || 'immediate',
      scheduledTime: matchData.scheduledTime ? admin.firestore.Timestamp.fromDate(new Date(matchData.scheduledTime)) : null,
      matchStatus: 'proposed',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 30000)) // 30 seconds
    };

    await db.collection(COLLECTIONS.MATCHES).doc(matchId).set(matchDoc);
    
    console.log(`✅ Match saved to Firestore: ${matchDoc.driverName} ↔ ${matchDoc.passengerName}`);
    console.log(`   - Match ID: ${matchId}`);
    console.log(`   - Collection: ${COLLECTIONS.MATCHES}`);
    
    return matchDoc;
  } catch (error) {
    console.error('❌ Error saving match to Firestore:', error);
    throw error;
  }
};

// Update driver location in Firestore
const updateDriverLocationInFirestore = async (driverId, locationData) => {
  try {
    await db.collection(COLLECTIONS.DRIVERS).doc(driverId).update({
      currentLocation: {
        latitude: locationData.latitude,
        longitude: locationData.longitude,
        accuracy: locationData.accuracy || 0,
        speed: locationData.speed || 0,
        heading: locationData.heading || 0,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      },
      lastLocationUpdate: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`📍 Driver location updated in Firestore: ${driverId}`);
    return true;
  } catch (error) {
    console.error('❌ Error updating driver location in Firestore:', error);
    return false;
  }
};

// Get passenger from Firestore
const getPassengerFromFirestore = async (passengerId) => {
  try {
    const doc = await db.collection(COLLECTIONS.PASSENGERS).doc(passengerId).get();
    
    if (!doc.exists) {
      console.log(`📭 Passenger not found in Firestore: ${passengerId}`);
      return null;
    }
    
    const passengerData = doc.data();
    console.log(`✅ Passenger found in Firestore: ${passengerData.name}`);
    
    return {
      ...passengerData,
      scheduledTime: passengerData.scheduledTime ? passengerData.scheduledTime.toDate() : null,
      createdAt: passengerData.createdAt ? passengerData.createdAt.toDate() : null,
      updatedAt: passengerData.updatedAt ? passengerData.updatedAt.toDate() : null
    };
  } catch (error) {
    console.error('❌ Error getting passenger from Firestore:', error);
    return null;
  }
};

// Get driver from Firestore
const getDriverFromFirestore = async (driverId) => {
  try {
    const doc = await db.collection(COLLECTIONS.DRIVERS).doc(driverId).get();
    
    if (!doc.exists) {
      console.log(`📭 Driver not found in Firestore: ${driverId}`);
      return null;
    }
    
    const driverData = doc.data();
    console.log(`✅ Driver found in Firestore: ${driverData.name}`);
    console.log(`   - Available Seats: ${driverData.availableSeats || driverData.capacity || 4}/${driverData.capacity || 4}`);
    
    return {
      ...driverData,
      scheduledTime: driverData.scheduledTime ? driverData.scheduledTime.toDate() : null,
      createdAt: driverData.createdAt ? driverData.createdAt.toDate() : null,
      updatedAt: driverData.updatedAt ? driverData.updatedAt.toDate() : null
    };
  } catch (error) {
    console.error('❌ Error getting driver from Firestore:', error);
    return null;
  }
};

// Get all active drivers from Firestore
const getAllActiveDriversFromFirestore = async () => {
  try {
    const snapshot = await db.collection(COLLECTIONS.DRIVERS)
      .where('status', '==', 'searching')
      .where('isOnline', '==', true)
      .get();

    const activeDrivers = [];
    snapshot.forEach(doc => {
      const driverData = doc.data();
      activeDrivers.push({
        ...driverData,
        scheduledTime: driverData.scheduledTime ? driverData.scheduledTime.toDate() : null,
        userId: driverData.userId || driverData.driverId,
        documentId: doc.id
      });
    });

    console.log(`📊 Found ${activeDrivers.length} active drivers in Firestore`);
    return activeDrivers;
  } catch (error) {
    console.error('❌ Error getting active drivers from Firestore:', error);
    return [];
  }
};

// Get all active passengers from Firestore
const getAllActivePassengersFromFirestore = async () => {
  try {
    const snapshot = await db.collection(COLLECTIONS.PASSENGERS)
      .where('status', '==', 'searching')
      .get();

    const activePassengers = [];
    snapshot.forEach(doc => {
      const passengerData = doc.data();
      activePassengers.push({
        ...passengerData,
        scheduledTime: passengerData.scheduledTime ? passengerData.scheduledTime.toDate() : null,
        userId: passengerData.userId,
        documentId: doc.id
      });
    });

    console.log(`📊 Found ${activePassengers.length} active passengers in Firestore`);
    return activePassengers;
  } catch (error) {
    console.error('❌ Error getting active passengers from Firestore:', error);
    return [];
  }
};

// ==================== BASIC ROUTES ====================
app.get('/', (req, res) => {
  res.json({
    message: 'ShareWay Backend API',
    version: '2.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
    services: {
      express: 'active',
      websocket: websocketServer ? 'active' : 'inactive',
      firebase: 'active',
      firestore: 'active'
    },
    collections: COLLECTIONS,
    endpoints: [
      'GET  /',
      'GET  /health',
      'GET  /api/firebase/test',
      'GET  /api/websocket/status',
      'POST /api/test/notification',
      'POST /api/passenger/search',
      'POST /api/driver/search',
      'POST /api/driver/update-location',
      'POST /api/match/create',
      'POST /api/match/accept',
      'GET  /api/driver/:driverId',
      'GET  /api/passenger/:passengerId'
    ]
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      express: 'active',
      websocket: websocketServer ? 'active' : 'inactive',
      firebase: 'active',
      firestore: 'active'
    }
  });
});

// ==================== FIREBASE TEST ENDPOINT ====================
app.get('/api/firebase/test', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ 
        success: false, 
        message: 'Firestore database not initialized' 
      });
    }
    
    // Test Firestore write
    const testDoc = {
      message: 'Firebase Firestore connection test',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      server: 'shareway-backend',
      environment: process.env.NODE_ENV || 'development'
    };
    
    await db.collection('connection_tests').doc('server_test').set(testDoc);
    
    // Test Firestore read
    const doc = await db.collection('connection_tests').doc('server_test').get();
    const data = doc.data();
    
    res.json({
      success: true,
      message: 'Firebase Firestore connection successful',
      write: testDoc,
      read: data,
      timestamp: new Date().toISOString(),
      collections: {
        total: (await db.listCollections()).length,
        names: (await db.listCollections()).map(col => col.id)
      }
    });
    
  } catch (error) {
    console.error('❌ Firebase test failed:', error);
    res.status(500).json({
      success: false,
      message: 'Firebase Firestore connection failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ==================== WEBSOCKET ROUTES ====================
app.get('/api/websocket/status', (req, res) => {
  if (!websocketServer) {
    return res.json({
      status: 'not_initialized',
      connectedUsers: 0,
      message: 'WebSocket server not initialized'
    });
  }

  res.json({
    status: 'active',
    connectedUsers: websocketServer.getConnectedCount(),
    connectedUserIds: websocketServer.getConnectedUsers(),
    timestamp: new Date().toISOString()
  });
});

app.post('/api/test/notification', (req, res) => {
  const { userId, message } = req.body;

  if (!userId || !message) {
    return res.status(400).json({
      error: 'userId and message are required'
    });
  }

  if (!websocketServer) {
    return res.status(500).json({
      error: 'WebSocket server not initialized'
    });
  }

  const sent = websocketServer.sendToUser(userId, {
    type: 'TEST_NOTIFICATION',
    data: {
      message: message,
      timestamp: new Date().toISOString()
    }
  });

  res.json({
    success: sent,
    message: sent ? 'Notification sent' : 'User not connected',
    userId: userId
  });
});

// ==================== PASSENGER SEARCH ENDPOINT ====================
app.post('/api/passenger/search', async (req, res) => {
  try {
    console.log('🔍 Passenger search request:', req.body);
    
    const passengerData = req.body;
    
    if (!passengerData.userId && !passengerData.name) {
      return res.status(400).json({
        success: false,
        error: 'userId or name is required'
      });
    }
    
    // Save passenger to Firestore
    const savedPassenger = await savePassengerToFirestore(passengerData);
    
    // Send WebSocket notification if user is connected
    if (websocketServer && websocketServer.isUserConnected(savedPassenger.userId)) {
      websocketServer.sendToUser(savedPassenger.userId, {
        type: 'SEARCH_STARTED',
        data: {
          searchId: savedPassenger.searchId,
          status: 'searching',
          message: 'Passenger search started successfully',
          timestamp: new Date().toISOString()
        }
      });
    }
    
    res.json({
      success: true,
      message: 'Passenger search started successfully',
      passengerId: savedPassenger.userId,
      searchId: savedPassenger.searchId,
      name: savedPassenger.name,
      status: savedPassenger.status,
      createdAt: new Date().toISOString(),
      storage: {
        collection: COLLECTIONS.PASSENGERS,
        documentId: savedPassenger.userId
      }
    });
    
  } catch (error) {
    console.error('❌ Error in passenger search:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== DRIVER SEARCH ENDPOINT ====================
app.post('/api/driver/search', async (req, res) => {
  try {
    console.log('🚗 Driver search request:', req.body);
    
    const driverData = req.body;
    
    if (!driverData.userId && !driverData.driverId && !driverData.name) {
      return res.status(400).json({
        success: false,
        error: 'userId, driverId, or name is required'
      });
    }
    
    // Save driver to Firestore
    const savedDriver = await saveDriverToFirestore(driverData);
    
    // Send WebSocket notification if user is connected
    if (websocketServer && websocketServer.isUserConnected(savedDriver.userId)) {
      websocketServer.sendToUser(savedDriver.userId, {
        type: 'SEARCH_STARTED',
        data: {
          searchId: savedDriver.searchId,
          status: 'searching',
          message: 'Driver search started successfully',
          timestamp: new Date().toISOString()
        }
      });
    }
    
    res.json({
      success: true,
      message: 'Driver search started successfully',
      driverId: savedDriver.userId,
      searchId: savedDriver.searchId,
      name: savedDriver.name,
      availableSeats: savedDriver.availableSeats,
      capacity: savedDriver.capacity,
      status: savedDriver.status,
      createdAt: new Date().toISOString(),
      storage: {
        collection: COLLECTIONS.DRIVERS,
        documentId: savedDriver.userId
      }
    });
    
  } catch (error) {
    console.error('❌ Error in driver search:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== DRIVER LOCATION UPDATE ENDPOINT ====================
app.post('/api/driver/update-location', async (req, res) => {
  try {
    const { userId, driverId, location, address } = req.body;
    const actualDriverId = driverId || userId;
    
    if (!actualDriverId) {
      return res.status(400).json({
        success: false,
        error: 'driverId or userId is required'
      });
    }
    
    if (!location || !location.latitude || !location.longitude) {
      return res.status(400).json({
        success: false,
        error: 'Valid location with latitude and longitude is required'
      });
    }
    
    console.log(`📍 Driver location update: ${actualDriverId}`);
    console.log(`   Location: ${location.latitude}, ${location.longitude}`);
    
    // Update driver location in Firestore
    const updated = await updateDriverLocationInFirestore(actualDriverId, location);
    
    if (!updated) {
      return res.status(500).json({
        success: false,
        error: 'Failed to update driver location'
      });
    }
    
    // Get driver data to check if they have a passenger
    const driverData = await getDriverFromFirestore(actualDriverId);
    
    // If driver has a passenger, notify passenger via WebSocket
    if (driverData && driverData.matchedWith && websocketServer) {
      websocketServer.sendToUser(driverData.matchedWith, {
        type: 'DRIVER_LOCATION_UPDATE',
        data: {
          driverId: actualDriverId,
          driverName: driverData.name,
          location: location,
          timestamp: new Date().toISOString()
        }
      });
    }
    
    res.json({
      success: true,
      message: 'Driver location updated successfully',
      driverId: actualDriverId,
      location: location,
      address: address,
      timestamp: new Date().toISOString(),
      passengerNotified: !!(driverData && driverData.matchedWith)
    });
    
  } catch (error) {
    console.error('❌ Error updating driver location:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== MATCH CREATION ENDPOINT ====================
app.post('/api/match/create', async (req, res) => {
  try {
    const matchData = req.body;
    
    if (!matchData.driverId || !matchData.passengerId) {
      return res.status(400).json({
        success: false,
        error: 'driverId and passengerId are required'
      });
    }
    
    console.log(`🤝 Creating match: ${matchData.driverId} ↔ ${matchData.passengerId}`);
    
    // Get driver and passenger data
    const driver = await getDriverFromFirestore(matchData.driverId);
    const passenger = await getPassengerFromFirestore(matchData.passengerId);
    
    if (!driver) {
      return res.status(404).json({
        success: false,
        error: 'Driver not found'
      });
    }
    
    if (!passenger) {
      return res.status(404).json({
        success: false,
        error: 'Passenger not found'
      });
    }
    
    // Check driver capacity
    const availableSeats = driver.availableSeats || driver.capacity || 4;
    const passengerCount = passenger.passengerCount || 1;
    
    if (passengerCount > availableSeats) {
      return res.status(400).json({
        success: false,
        error: `Not enough available seats. Available: ${availableSeats}, Needed: ${passengerCount}`
      });
    }
    
    // Prepare match data
    const enhancedMatchData = {
      ...matchData,
      driverName: driver.name,
      driverPhone: driver.phone,
      passengerName: passenger.name,
      passengerPhone: passenger.phone,
      passengerCount: passengerCount,
      capacity: driver.capacity || 4,
      vehicleType: driver.vehicleType || 'car',
      similarityScore: matchData.similarityScore || 85,
      pickupName: passenger.pickupName || driver.pickupName || 'Pickup Location',
      destinationName: passenger.destinationName || driver.destinationName || 'Destination',
      pickupLocation: passenger.pickupLocation || driver.pickupLocation || {},
      destinationLocation: passenger.destinationLocation || driver.destinationLocation || {},
      rideType: passenger.rideType || driver.rideType || 'immediate',
      scheduledTime: passenger.scheduledTime || driver.scheduledTime
    };
    
    // Save match to Firestore
    const savedMatch = await saveMatchToFirestore(enhancedMatchData);
    
    // Update driver with match info
    await db.collection(COLLECTIONS.DRIVERS).doc(matchData.driverId).update({
      matchId: savedMatch.matchId,
      matchedWith: matchData.passengerId,
      matchStatus: 'proposed',
      availableSeats: Math.max(0, availableSeats - passengerCount),
      currentPassengers: (driver.currentPassengers || 0) + passengerCount,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Update passenger with match info
    await db.collection(COLLECTIONS.PASSENGERS).doc(matchData.passengerId).update({
      matchId: savedMatch.matchId,
      matchedWith: matchData.driverId,
      matchStatus: 'proposed',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Send WebSocket notifications
    if (websocketServer) {
      // Notify driver
      websocketServer.sendMatchProposal(matchData.driverId, {
        matchId: savedMatch.matchId,
        passengerId: matchData.passengerId,
        passengerName: passenger.name,
        passengerPhone: passenger.phone,
        passengerCount: passengerCount,
        pickupName: passenger.pickupName,
        destinationName: passenger.destinationName,
        message: 'New passenger match found!',
        timeout: 30000 // 30 seconds to accept
      });
      
      // Notify passenger
      websocketServer.sendMatchProposal(matchData.passengerId, {
        matchId: savedMatch.matchId,
        driverId: matchData.driverId,
        driverName: driver.name,
        driverPhone: driver.phone,
        vehicleInfo: driver.vehicleInfo,
        vehicleType: driver.vehicleType,
        capacity: driver.capacity,
        pickupName: passenger.pickupName,
        destinationName: passenger.destinationName,
        estimatedFare: passenger.estimatedFare || driver.estimatedFare,
        message: 'Driver match found!',
        timeout: 30000
      });
    }
    
    res.json({
      success: true,
      message: 'Match created successfully',
      matchId: savedMatch.matchId,
      driverId: matchData.driverId,
      driverName: driver.name,
      passengerId: matchData.passengerId,
      passengerName: passenger.name,
      passengerCount: passengerCount,
      availableSeats: Math.max(0, availableSeats - passengerCount),
      matchStatus: 'proposed',
      expiresIn: '30 seconds',
      timestamp: new Date().toISOString(),
      storage: {
        collection: COLLECTIONS.MATCHES,
        documentId: savedMatch.matchId
      }
    });
    
  } catch (error) {
    console.error('❌ Error creating match:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== MATCH ACCEPTANCE ENDPOINT ====================
app.post('/api/match/accept', async (req, res) => {
  try {
    const { matchId, driverId, passengerId } = req.body;
    
    if (!matchId || !driverId || !passengerId) {
      return res.status(400).json({
        success: false,
        error: 'matchId, driverId, and passengerId are required'
      });
    }
    
    console.log(`✅ Match acceptance: ${matchId}`);
    
    // Get match from Firestore
    const matchDoc = await db.collection(COLLECTIONS.MATCHES).doc(matchId).get();
    if (!matchDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Match not found'
      });
    }
    
    const matchData = matchDoc.data();
    
    // Verify match participants
    if (matchData.driverId !== driverId || matchData.passengerId !== passengerId) {
      return res.status(400).json({
        success: false,
        error: 'Match participants do not match'
      });
    }
    
    // Update match status
    await db.collection(COLLECTIONS.MATCHES).doc(matchId).update({
      matchStatus: 'accepted',
      acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Update driver status
    await db.collection(COLLECTIONS.DRIVERS).doc(driverId).update({
      matchStatus: 'accepted',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Update passenger status
    await db.collection(COLLECTIONS.PASSENGERS).doc(passengerId).update({
      matchStatus: 'accepted',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Create active ride
    const rideId = `ride_${Date.now()}_${uuidv4()}`;
    const rideData = {
      rideId: rideId,
      matchId: matchId,
      driverId: driverId,
      passengerId: passengerId,
      driverName: matchData.driverName,
      passengerName: matchData.passengerName,
      pickupLocation: matchData.pickupLocation,
      destinationLocation: matchData.destinationLocation,
      pickupName: matchData.pickupName,
      destinationName: matchData.destinationName,
      passengerCount: matchData.passengerCount,
      estimatedFare: matchData.estimatedFare,
      status: 'accepted',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    await db.collection(COLLECTIONS.ACTIVE_RIDES).doc(rideId).set(rideData);
    
    // Send WebSocket notifications
    if (websocketServer) {
      // Notify driver
      websocketServer.sendToUser(driverId, {
        type: 'MATCH_ACCEPTED',
        data: {
          matchId: matchId,
          rideId: rideId,
          passengerId: passengerId,
          passengerName: matchData.passengerName,
          message: 'Match accepted successfully!',
          timestamp: new Date().toISOString()
        }
      });
      
      // Notify passenger
      websocketServer.sendToUser(passengerId, {
        type: 'MATCH_ACCEPTED',
        data: {
          matchId: matchId,
          rideId: rideId,
          driverId: driverId,
          driverName: matchData.driverName,
          message: 'Driver has accepted your ride!',
          timestamp: new Date().toISOString()
        }
      });
    }
    
    res.json({
      success: true,
      message: 'Match accepted successfully',
      matchId: matchId,
      rideId: rideId,
      driverId: driverId,
      passengerId: passengerId,
      rideStatus: 'accepted',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error accepting match:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== GET DRIVER ENDPOINT ====================
app.get('/api/driver/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    
    const driver = await getDriverFromFirestore(driverId);
    
    if (!driver) {
      return res.status(404).json({
        success: false,
        error: 'Driver not found'
      });
    }
    
    res.json({
      success: true,
      driver: driver,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error getting driver:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== GET PASSENGER ENDPOINT ====================
app.get('/api/passenger/:passengerId', async (req, res) => {
  try {
    const { passengerId } = req.params;
    
    const passenger = await getPassengerFromFirestore(passengerId);
    
    if (!passenger) {
      return res.status(404).json({
        success: false,
        error: 'Passenger not found'
      });
    }
    
    res.json({
      success: true,
      passenger: passenger,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error getting passenger:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== GET ALL ACTIVE DRIVERS ENDPOINT ====================
app.get('/api/drivers/active', async (req, res) => {
  try {
    const activeDrivers = await getAllActiveDriversFromFirestore();
    
    res.json({
      success: true,
      count: activeDrivers.length,
      drivers: activeDrivers,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error getting active drivers:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== GET ALL ACTIVE PASSENGERS ENDPOINT ====================
app.get('/api/passengers/active', async (req, res) => {
  try {
    const activePassengers = await getAllActivePassengersFromFirestore();
    
    res.json({
      success: true,
      count: activePassengers.length,
      passengers: activePassengers,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error getting active passengers:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== ERROR HANDLING ====================
// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString()
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  res.status(err.status || 500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message,
    timestamp: new Date().toISOString()
  });
});

// ==================== START MATCHING SERVICE ====================
const startMatchingService = () => {
  console.log('🔄 Starting matching service...');
  
  setInterval(async () => {
    try {
      console.log('\n📊 ===== MATCHING CYCLE START =====');
      
      // Get all active drivers and passengers
      const activeDrivers = await getAllActiveDriversFromFirestore();
      const activePassengers = await getAllActivePassengersFromFirestore();
      
      console.log(`🔍 Active drivers: ${activeDrivers.length}`);
      console.log(`🔍 Active passengers: ${activePassengers.length}`);
      
      if (activeDrivers.length === 0 || activePassengers.length === 0) {
        console.log('💤 No matches possible - not enough users');
        return;
      }
      
      // Simple matching logic (you can enhance this)
      let matchesCreated = 0;
      
      for (const driver of activeDrivers) {
        // Skip if driver already has a match
        if (driver.matchStatus && driver.matchStatus !== 'searching') {
          continue;
        }
        
        const availableSeats = driver.availableSeats || driver.capacity || 4;
        if (availableSeats <= 0) {
          continue;
        }
        
        for (const passenger of activePassengers) {
          // Skip if passenger already has a match
          if (passenger.matchStatus && passenger.matchStatus !== 'searching') {
            continue;
          }
          
          const passengerCount = passenger.passengerCount || 1;
          if (passengerCount > availableSeats) {
            continue;
          }
          
          // Create match
          const matchData = {
            driverId: driver.userId,
            passengerId: passenger.userId,
            similarityScore: 85, // You can calculate this based on route matching
            estimatedFare: passenger.estimatedFare || 25.50
          };
          
          // Save match to Firestore
          await saveMatchToFirestore(matchData);
          
          matchesCreated++;
          console.log(`🎯 Match created: ${driver.name} ↔ ${passenger.name}`);
          
          break; // Match this driver with one passenger only
        }
      }
      
      if (matchesCreated > 0) {
        console.log(`✅ Created ${matchesCreated} matches`);
      } else {
        console.log('🔍 No matches created this cycle');
      }
      
      console.log('📊 ===== MATCHING CYCLE END =====\n');
      
    } catch (error) {
      console.error('❌ Matching service error:', error);
    }
  }, 10000); // Run every 10 seconds
};

// ==================== SERVER START ====================
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║         ShareWay Backend Server Started              ║
╚═══════════════════════════════════════════════════════╝
`);
  console.log(`🚀 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌐 Server URL: http://localhost:${PORT}`);
  console.log(`🔌 WebSocket: ws://localhost:${PORT}`);
  console.log(`🔥 Firebase: Connected to Firestore`);
  console.log(`\n📊 Firestore Collections:`);
  console.log(`  • ${COLLECTIONS.PASSENGERS} - Passenger data`);
  console.log(`  • ${COLLECTIONS.DRIVERS} - Driver data`);
  console.log(`  • ${COLLECTIONS.MATCHES} - Match data`);
  console.log(`  • ${COLLECTIONS.ACTIVE_RIDES} - Active rides`);
  console.log(`\n📋 Available Endpoints:`);
  console.log(`  • GET  /                    - API Status`);
  console.log(`  • GET  /health              - Health Check`);
  console.log(`  • GET  /api/firebase/test   - Firebase Test`);
  console.log(`  • POST /api/passenger/search - Passenger Search`);
  console.log(`  • POST /api/driver/search   - Driver Search`);
  console.log(`  • POST /api/match/create    - Create Match`);
  console.log(`  • POST /api/match/accept    - Accept Match`);
  console.log(`\n⚡ Ready to accept connections!`);
  
  // Start matching service
  startMatchingService();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🔻 SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('👋 Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n🔻 SIGINT received. Shutting down gracefully...');
  server.close(() => {
    console.log('👋 Server closed');
    process.exit(0);
  });
});

module.exports = { app, server, db, admin, websocketServer };
