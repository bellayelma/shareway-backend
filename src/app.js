// src/app.js - COMPLETE SYMMETRICAL SCRIPT WITH SEPARATE DRIVER/PASSENGER COLLECTIONS
const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
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

// ========== ENHANCED REQUEST LOGGING MIDDLEWARE ==========
app.use((req, res, next) => {
  console.log(`🔍 ${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  if (Object.keys(req.body).length > 0 && req.method === 'POST') {
    console.log('📦 Request body keys:', Object.keys(req.body));
    if (req.originalUrl.includes('/api/match/')) {
      console.log('🔎 SEARCH DEBUG - UserType:', req.body.userType);
      console.log('🔎 SEARCH DEBUG - RideType:', req.body.rideType);
      console.log('🔎 SEARCH DEBUG - ScheduledTime:', req.body.scheduledTime);
    }
  }
  next();
});

// ========== TEST MODE CONFIGURATION ==========
const TEST_MODE = true;
const TEST_MATCHING_INTERVAL = 5000;
const UNLIMITED_CAPACITY = true;

// ========== SEPARATE FIRESTORE COLLECTION NAMES ==========
const ACTIVE_SEARCHES_DRIVER_COLLECTION = 'active_searches_driver';
const ACTIVE_SEARCHES_PASSENGER_COLLECTION = 'active_searches_passenger';
const DRIVER_SCHEDULES_COLLECTION = 'driver_schedules';
const ACTIVE_MATCHES_COLLECTION = 'active_matches';
const NOTIFICATIONS_COLLECTION = 'notifications';
const ACTIVE_RIDES_COLLECTION = 'active_rides';

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

// In-memory storage for ACTIVE searches only (immediate matching)
const activeSearches = new Map();
const processedMatches = new Map();
const searchTimeouts = new Map();
const userMatches = new Map();

// Timeout constants
const IMMEDIATE_SEARCH_TIMEOUT = 5 * 60 * 1000;
const SCHEDULED_SEARCH_CHECK_INTERVAL = 10000;
const MAX_MATCH_AGE = 300000;
const MATCH_PROPOSAL_TIMEOUT = 2 * 60 * 1000; // 2 minutes for match acceptance

// ========== SEPARATE DRIVER & PASSENGER COLLECTION FUNCTIONS ==========

// 🎯 Save driver search to separate driver collection
const saveDriverSearch = async (driverData) => {
  try {
    const driverId = driverData.userId || driverData.driverId;
    if (!driverId) {
      throw new Error('driverId is required for saving driver search');
    }

    const driverSearchData = {
      // ✅ BASIC IDENTIFICATION
      driverId: driverId,
      userType: 'driver',
      
      // ✅ COMPLETE DRIVER PROFILE DATA
      driverName: driverData.driverName || 'Unknown Driver',
      driverPhone: driverData.driverPhone || 'Not provided',
      driverPhotoUrl: driverData.driverPhotoUrl || '',
      driverRating: driverData.driverRating || 5.0,
      totalRides: driverData.totalRides || 0,
      isVerified: driverData.isVerified || false,
      totalEarnings: driverData.totalEarnings || 0.0,
      completedRides: driverData.completedRides || 0,
      isOnline: driverData.isOnline || true,
      isSearching: driverData.isSearching || false,
      
      // ✅ COMPLETE VEHICLE INFORMATION
      vehicleInfo: driverData.vehicleInfo || {
        model: driverData.vehicleModel || 'Unknown Model',
        plate: driverData.vehiclePlate || 'Unknown Plate',
        color: driverData.vehicleColor || 'Unknown Color',
        type: driverData.vehicleType || 'car',
        year: driverData.vehicleYear || 'Unknown',
        passengerCapacity: driverData.capacity || 4
      },
      
      // ✅ LOCATION DATA
      pickupLocation: driverData.pickupLocation,
      destinationLocation: driverData.destinationLocation,
      pickupName: driverData.pickupName || 'Unknown Pickup',
      destinationName: driverData.destinationName || 'Unknown Destination',
      
      // ✅ ROUTE GEOMETRY
      routePoints: driverData.routePoints || [],
      
      // ✅ VEHICLE & CAPACITY DATA
      passengerCount: driverData.passengerCount || 0,
      capacity: driverData.capacity || 4,
      vehicleType: driverData.vehicleType || 'car',
      
      // ✅ MATCH ACCEPTANCE FIELDS
      matchId: null,
      matchedWith: null,
      matchStatus: null,
      tripStatus: null,
      rideId: null,
      passenger: null,
      driver: null,
      currentPassengers: 0,
      availableSeats: driverData.capacity || 4,
      acceptedAt: null,
      
      // ✅ ROUTE INFORMATION
      distance: driverData.distance || 0,
      duration: driverData.duration || 0,
      fare: driverData.fare || 0,
      estimatedFare: driverData.estimatedFare || 0,
      
      // ✅ PREFERENCES & SETTINGS
      maxWaitTime: driverData.maxWaitTime || 30,
      preferredVehicleType: driverData.preferredVehicleType || 'car',
      specialRequests: driverData.specialRequests || '',
      maxWalkDistance: driverData.maxWalkDistance || 0.5,
      
      // ✅ SEARCH METADATA
      rideType: driverData.rideType || 'immediate',
      scheduledTime: driverData.scheduledTime ? admin.firestore.Timestamp.fromDate(new Date(driverData.scheduledTime)) : null,
      searchId: driverData.searchId || `driver_search_${driverId}_${Date.now()}`,
      status: 'searching',
      
      // ✅ SYSTEM DATA
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    };

    // 🎯 SAVE TO SEPARATE DRIVER COLLECTION
    await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(driverId).set(driverSearchData);
    
    console.log(`✅ Driver search saved to ${ACTIVE_SEARCHES_DRIVER_COLLECTION}: ${driverSearchData.driverName}`);
    console.log(`   - Driver ID: ${driverId}`);
    console.log(`   - Available Seats: ${driverSearchData.availableSeats}/${driverSearchData.capacity}`);
    console.log(`   - Collection: ${ACTIVE_SEARCHES_DRIVER_COLLECTION}`);
    
    return driverSearchData;
  } catch (error) {
    console.error('❌ Error saving driver search:', error);
    throw error;
  }
};

// 🎯 Save passenger search to separate passenger collection
const savePassengerSearch = async (passengerData) => {
  try {
    const passengerId = passengerData.userId || passengerData.passengerId;
    if (!passengerId) {
      throw new Error('passengerId is required for saving passenger search');
    }

    const passengerSearchData = {
      // ✅ BASIC IDENTIFICATION
      passengerId: passengerId,
      userType: 'passenger',
      
      // ✅ PASSENGER PROFILE DATA
      passengerName: passengerData.passengerName || 'Unknown Passenger',
      passengerPhone: passengerData.passengerPhone || 'Not provided',
      passengerPhotoUrl: passengerData.passengerPhotoUrl || '',
      passengerRating: passengerData.passengerRating || 5.0,
      
      // ✅ LOCATION DATA
      pickupLocation: passengerData.pickupLocation,
      destinationLocation: passengerData.destinationLocation,
      pickupName: passengerData.pickupName || 'Unknown Pickup',
      destinationName: passengerData.destinationName || 'Unknown Destination',
      
      // ✅ ROUTE GEOMETRY
      routePoints: passengerData.routePoints || [],
      
      // ✅ PASSENGER DATA
      passengerCount: passengerData.passengerCount || 1,
      
      // ✅ MATCH ACCEPTANCE FIELDS
      matchId: null,
      matchedWith: null,
      matchStatus: null,
      tripStatus: null,
      rideId: null,
      passenger: null,
      driver: null,
      acceptedAt: null,
      
      // ✅ ROUTE INFORMATION
      distance: passengerData.distance || 0,
      duration: passengerData.duration || 0,
      fare: passengerData.fare || 0,
      estimatedFare: passengerData.estimatedFare || 0,
      
      // ✅ PREFERENCES & SETTINGS
      maxWaitTime: passengerData.maxWaitTime || 30,
      preferredVehicleType: passengerData.preferredVehicleType || 'car',
      specialRequests: passengerData.specialRequests || '',
      maxWalkDistance: passengerData.maxWalkDistance || 0.5,
      
      // ✅ SEARCH METADATA
      rideType: passengerData.rideType || 'immediate',
      scheduledTime: passengerData.scheduledTime ? admin.firestore.Timestamp.fromDate(new Date(passengerData.scheduledTime)) : null,
      searchId: passengerData.searchId || `passenger_search_${passengerId}_${Date.now()}`,
      status: 'searching',
      
      // ✅ SYSTEM DATA
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    };

    // 🎯 SAVE TO SEPARATE PASSENGER COLLECTION
    await db.collection(ACTIVE_SEARCHES_PASSENGER_COLLECTION).doc(passengerId).set(passengerSearchData);
    
    console.log(`✅ Passenger search saved to ${ACTIVE_SEARCHES_PASSENGER_COLLECTION}: ${passengerSearchData.passengerName}`);
    console.log(`   - Passenger ID: ${passengerId}`);
    console.log(`   - Passenger Count: ${passengerSearchData.passengerCount}`);
    console.log(`   - Collection: ${ACTIVE_SEARCHES_PASSENGER_COLLECTION}`);
    
    return passengerSearchData;
  } catch (error) {
    console.error('❌ Error saving passenger search:', error);
    throw error;
  }
};

// 🎯 Get driver search from separate driver collection
const getDriverSearch = async (driverId) => {
  try {
    console.log(`🔍 Reading driver search from ${ACTIVE_SEARCHES_DRIVER_COLLECTION}: ${driverId}`);
    
    const doc = await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(driverId).get();

    if (!doc.exists) {
      console.log(`📭 No driver search found in ${ACTIVE_SEARCHES_DRIVER_COLLECTION}: ${driverId}`);
      return null;
    }

    const driverData = doc.data();
    console.log(`✅ Found driver search: ${driverData.driverName}`);
    console.log(`   - Available Seats: ${driverData.availableSeats}/${driverData.capacity}`);
    console.log(`   - Match Status: ${driverData.matchStatus || 'none'}`);
    
    return {
      ...driverData,
      scheduledTime: driverData.scheduledTime ? driverData.scheduledTime.toDate() : null,
      userId: driverData.driverId,
      source: 'driver_collection'
    };
  } catch (error) {
    console.error('❌ Error reading driver search:', error);
    return null;
  }
};

// 🎯 Get passenger search from separate passenger collection
const getPassengerSearch = async (passengerId) => {
  try {
    console.log(`🔍 Reading passenger search from ${ACTIVE_SEARCHES_PASSENGER_COLLECTION}: ${passengerId}`);
    
    const doc = await db.collection(ACTIVE_SEARCHES_PASSENGER_COLLECTION).doc(passengerId).get();

    if (!doc.exists) {
      console.log(`📭 No passenger search found in ${ACTIVE_SEARCHES_PASSENGER_COLLECTION}: ${passengerId}`);
      return null;
    }

    const passengerData = doc.data();
    console.log(`✅ Found passenger search: ${passengerData.passengerName}`);
    console.log(`   - Match Status: ${passengerData.matchStatus || 'none'}`);
    
    return {
      ...passengerData,
      scheduledTime: passengerData.scheduledTime ? passengerData.scheduledTime.toDate() : null,
      userId: passengerData.passengerId,
      source: 'passenger_collection'
    };
  } catch (error) {
    console.error('❌ Error reading passenger search:', error);
    return null;
  }
};

// 🎯 Get all active driver searches from separate collection
const getAllActiveDriverSearches = async () => {
  try {
    const snapshot = await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION)
      .where('status', '==', 'searching')
      .get();

    const activeDrivers = [];
    snapshot.forEach(doc => {
      const driverData = doc.data();
      activeDrivers.push({
        ...driverData,
        scheduledTime: driverData.scheduledTime ? driverData.scheduledTime.toDate() : null,
        userId: driverData.driverId,
        documentId: doc.id
      });
    });

    console.log(`📊 Found ${activeDrivers.length} active driver searches in ${ACTIVE_SEARCHES_DRIVER_COLLECTION}`);
    activeDrivers.forEach(driver => {
      console.log(`   - ${driver.driverName}: ${driver.availableSeats}/${driver.capacity} seats available`);
    });
    
    return activeDrivers;
  } catch (error) {
    console.error('❌ Error getting active driver searches:', error);
    return [];
  }
};

// 🎯 Get all active passenger searches from separate collection
const getAllActivePassengerSearches = async () => {
  try {
    const snapshot = await db.collection(ACTIVE_SEARCHES_PASSENGER_COLLECTION)
      .where('status', '==', 'searching')
      .get();

    const activePassengers = [];
    snapshot.forEach(doc => {
      const passengerData = doc.data();
      activePassengers.push({
        ...passengerData,
        scheduledTime: passengerData.scheduledTime ? passengerData.scheduledTime.toDate() : null,
        userId: passengerData.passengerId,
        documentId: doc.id
      });
    });

    console.log(`📊 Found ${activePassengers.length} active passenger searches in ${ACTIVE_SEARCHES_PASSENGER_COLLECTION}`);
    activePassengers.forEach(passenger => {
      console.log(`   - ${passenger.passengerName} (${passenger.passengerCount} passengers)`);
    });
    
    return activePassengers;
  } catch (error) {
    console.error('❌ Error getting active passenger searches:', error);
    return [];
  }
};

// 🎯 Update driver search in separate collection
const updateDriverSearch = async (driverId, updates) => {
  try {
    await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(driverId).update({
      ...updates,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`✅ Updated driver search in ${ACTIVE_SEARCHES_DRIVER_COLLECTION}: ${driverId}`);
    return true;
  } catch (error) {
    console.error('❌ Error updating driver search:', error);
    return false;
  }
};

// 🎯 Update passenger search in separate collection
const updatePassengerSearch = async (passengerId, updates) => {
  try {
    await db.collection(ACTIVE_SEARCHES_PASSENGER_COLLECTION).doc(passengerId).update({
      ...updates,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`✅ Updated passenger search in ${ACTIVE_SEARCHES_PASSENGER_COLLECTION}: ${passengerId}`);
    return true;
  } catch (error) {
    console.error('❌ Error updating passenger search:', error);
    return false;
  }
};

// 🎯 Stop driver search in separate collection
const stopDriverSearch = async (driverId) => {
  try {
    await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(driverId).update({
      status: 'stopped',
      isSearching: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`🛑 Stopped driver search in ${ACTIVE_SEARCHES_DRIVER_COLLECTION}: ${driverId}`);
    return true;
  } catch (error) {
    console.error('❌ Error stopping driver search:', error);
    return false;
  }
};

// 🎯 Stop passenger search in separate collection
const stopPassengerSearch = async (passengerId) => {
  try {
    await db.collection(ACTIVE_SEARCHES_PASSENGER_COLLECTION).doc(passengerId).update({
      status: 'stopped',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`🛑 Stopped passenger search in ${ACTIVE_SEARCHES_PASSENGER_COLLECTION}: ${passengerId}`);
    return true;
  } catch (error) {
    console.error('❌ Error stopping passenger search:', error);
    return false;
  }
};

// ========== DEDICATED FIRESTORE DRIVER SCHEDULES MANAGEMENT ==========

// 🎯 Save driver schedule to Firestore collection
const saveDriverScheduleToFirestore = async (scheduleData) => {
  try {
    const driverId = scheduleData.driverId || scheduleData.userId;
    if (!driverId) {
      throw new Error('driverId is required for saving schedule');
    }

    const scheduleId = scheduleData.scheduleId || `schedule_${driverId}_${Date.now()}`;
    
    const driverSchedule = {
      scheduleId: scheduleId,
      driverId: driverId,
      userType: 'driver',
      driverName: scheduleData.driverName || 'Unknown Driver',
      driverPhone: scheduleData.driverPhone || 'Not provided',
      driverPhotoUrl: scheduleData.driverPhotoUrl || '',
      driverRating: scheduleData.driverRating || 5.0,
      vehicleInfo: scheduleData.vehicleInfo || {},
      pickupLocation: scheduleData.pickupLocation,
      destinationLocation: scheduleData.destinationLocation,
      pickupName: scheduleData.pickupName || 'Unknown Pickup',
      destinationName: scheduleData.destinationName || 'Unknown Destination',
      routePoints: scheduleData.routePoints || [],
      passengerCount: scheduleData.passengerCount || 0,
      capacity: scheduleData.capacity || 4,
      vehicleType: scheduleData.vehicleType || 'car',
      distance: scheduleData.distance || 0,
      duration: scheduleData.duration || 0,
      fare: scheduleData.fare || 0,
      estimatedFare: scheduleData.estimatedFare || 0,
      maxWaitTime: scheduleData.maxWaitTime || 30,
      preferredVehicleType: scheduleData.preferredVehicleType || 'car',
      specialRequests: scheduleData.specialRequests || '',
      maxWalkDistance: scheduleData.maxWalkDistance || 0.5,
      scheduledTime: admin.firestore.Timestamp.fromDate(new Date(scheduleData.scheduledTime)),
      status: 'scheduled',
      activateImmediately: scheduleData.activateImmediately || TEST_MODE,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection(DRIVER_SCHEDULES_COLLECTION).doc(scheduleId).set(driverSchedule);
    
    console.log(`💾 Saved driver schedule to Firestore: ${scheduleData.driverName}`);
    console.log(`   - Schedule ID: ${scheduleId}`);
    console.log(`   - Driver ID: ${driverId}`);
    console.log(`   - Collection: ${DRIVER_SCHEDULES_COLLECTION}`);
    
    return driverSchedule;
  } catch (error) {
    console.error('❌ Error saving driver schedule to Firestore:', error);
    throw error;
  }
};

// 🎯 Get driver schedule from Firestore by driverId
const getDriverScheduleFromFirestore = async (driverId) => {
  try {
    console.log(`🔍 Reading driver schedule from Firestore for driver: ${driverId}`);
    
    const snapshot = await db.collection(DRIVER_SCHEDULES_COLLECTION)
      .where('driverId', '==', driverId)
      .where('status', 'in', ['scheduled', 'active'])
      .orderBy('scheduledTime', 'desc')
      .limit(1)
      .get();

    if (snapshot.empty) {
      console.log(`📭 No driver schedule found in Firestore for driver: ${driverId}`);
      return null;
    }

    const scheduleData = snapshot.docs[0].data();
    console.log(`✅ Found driver schedule in Firestore: ${scheduleData.scheduleId}`);
    
    return {
      ...scheduleData,
      scheduledTime: scheduleData.scheduledTime.toDate(),
      source: 'firestore'
    };
  } catch (error) {
    console.error('❌ Error reading driver schedule from Firestore:', error);
    return null;
  }
};

// Clean old data from memory
setInterval(() => {
  const now = Date.now();
  
  // Clean processed matches
  for (const [key, timestamp] of processedMatches.entries()) {
    if (now - timestamp > MAX_MATCH_AGE) {
      processedMatches.delete(key);
    }
  }
  
  // Clean expired search timeouts
  for (const [userId, timeout] of searchTimeouts.entries()) {
    if (timeout.expiresAt && now > timeout.expiresAt) {
      searchTimeouts.delete(userId);
    }
  }
}, 60000);

// Generate match key for deduplication
const generateMatchKey = (driverId, passengerId, timestamp = Date.now()) => {
  const timeWindow = Math.floor(timestamp / 30000);
  return `${driverId}_${passengerId}_${timeWindow}`;
};

// ========== MATCH ACCEPTANCE FUNCTIONS ==========

// Create a new active ride document
const createActiveRide = async (driverData, passengerData) => {
  try {
    const rideId = `ride_${uuidv4()}`;
    
    const rideData = {
      rideId: rideId,
      driverId: driverData.driverId || driverData.userId,
      driverName: driverData.driverName,
      driverPhone: driverData.driverPhone,
      driverPhotoUrl: driverData.driverPhotoUrl,
      driverRating: driverData.driverRating,
      vehicleInfo: driverData.vehicleInfo,
      passengerId: passengerData.passengerId || passengerData.userId,
      passengerName: passengerData.passengerName,
      passengerPhone: passengerData.passengerPhone,
      passengerPhotoUrl: passengerData.passengerPhotoUrl,
      pickupLocation: passengerData.pickupLocation || driverData.pickupLocation,
      pickupName: passengerData.pickupName || driverData.pickupName,
      destinationLocation: passengerData.destinationLocation || driverData.destinationLocation,
      destinationName: passengerData.destinationName || driverData.destinationName,
      distance: passengerData.distance || driverData.distance,
      duration: passengerData.duration || driverData.duration,
      estimatedFare: passengerData.estimatedFare || driverData.estimatedFare,
      rideType: driverData.rideType || passengerData.rideType || 'immediate',
      scheduledTime: driverData.scheduledTime || passengerData.scheduledTime,
      status: 'driver_accepted',
      matchId: driverData.matchId,
      tripStatus: 'driver_accepted',
      acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection(ACTIVE_RIDES_COLLECTION).doc(rideId).set(rideData);
    console.log(`✅ Created active ride: ${rideId}`);
    console.log(`   - Driver: ${driverData.driverName}`);
    console.log(`   - Passenger: ${passengerData.passengerName}`);
    
    return rideData;
  } catch (error) {
    console.error('❌ Error creating active ride:', error);
    throw error;
  }
};

// Update driver document with passenger acceptance
const updateDriverWithPassenger = async (driverId, passengerData, matchId, rideId) => {
  try {
    const passengerCount = passengerData.passengerCount || 1;
    const driverDoc = await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(driverId).get();
    if (!driverDoc.exists) {
      throw new Error('Driver not found');
    }
    
    const driverData = driverDoc.data();
    const currentAvailableSeats = driverData.availableSeats || driverData.capacity || 4;
    const currentPassengers = driverData.currentPassengers || 0;
    
    const updates = {
      matchId: matchId,
      matchedWith: passengerData.passengerId || passengerData.userId,
      matchStatus: 'accepted',
      rideId: rideId,
      tripStatus: 'driver_accepted',
      passenger: {
        passengerId: passengerData.passengerId || passengerData.userId,
        passengerName: passengerData.passengerName,
        passengerPhone: passengerData.passengerPhone,
        passengerPhotoUrl: passengerData.passengerPhotoUrl,
        pickupLocation: passengerData.pickupLocation,
        pickupName: passengerData.pickupName,
        destinationLocation: passengerData.destinationLocation,
        destinationName: passengerData.destinationName,
        passengerCount: passengerCount,
        matchAcceptedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      currentPassengers: currentPassengers + passengerCount,
      availableSeats: Math.max(0, currentAvailableSeats - passengerCount),
      acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(driverId).update(updates);
    console.log(`✅ Updated driver ${driverId} with passenger acceptance`);
    console.log(`   - New available seats: ${updates.availableSeats}/${driverData.capacity}`);
    
    return updates;
  } catch (error) {
    console.error('❌ Error updating driver with passenger:', error);
    throw error;
  }
};

// Update passenger document with driver acceptance
const updatePassengerWithDriver = async (passengerId, driverData, matchId, rideId) => {
  try {
    const updates = {
      matchId: matchId,
      matchedWith: driverData.driverId || driverData.userId,
      matchStatus: 'accepted',
      rideId: rideId,
      tripStatus: 'driver_accepted',
      driver: {
        driverId: driverData.driverId || driverData.userId,
        driverName: driverData.driverName,
        driverPhone: driverData.driverPhone,
        driverPhotoUrl: driverData.driverPhotoUrl,
        driverRating: driverData.driverRating,
        vehicleInfo: driverData.vehicleInfo,
        vehicleType: driverData.vehicleType,
        capacity: driverData.capacity,
        currentPassengers: driverData.currentPassengers || 0,
        availableSeats: driverData.availableSeats || driverData.capacity,
        matchAcceptedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection(ACTIVE_SEARCHES_PASSENGER_COLLECTION).doc(passengerId).update(updates);
    console.log(`✅ Updated passenger ${passengerId} with driver acceptance`);
    
    return updates;
  } catch (error) {
    console.error('❌ Error updating passenger with driver:', error);
    throw error;
  }
};

// Reject a match proposal
const rejectMatch = async (userId, userType, matchId) => {
  try {
    if (userType === 'driver') {
      // Update driver document
      await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION).doc(userId).update({
        matchId: null,
        matchedWith: null,
        matchStatus: 'rejected',
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      });
    } else if (userType === 'passenger') {
      // Update passenger document
      await db.collection(ACTIVE_SEARCHES_PASSENGER_COLLECTION).doc(userId).update({
        matchId: null,
        matchedWith: null,
        matchStatus: 'rejected',
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    
    // Update match document
    await db.collection(ACTIVE_MATCHES_COLLECTION).doc(matchId).update({
      matchStatus: 'rejected',
      rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`✅ Match ${matchId} rejected by ${userType} ${userId}`);
    return true;
  } catch (error) {
    console.error('❌ Error rejecting match:', error);
    throw error;
  }
};

// ========== STOP SEARCHING AFTER MATCH FUNCTIONS ==========

// Stop search for a user and clean up
const stopUserSearch = (userId) => {
  try {
    console.log(`🛑 Stopping search for user: ${userId}`);
    
    // Clear timeout first
    clearSearchTimeout(userId);
    
    // Remove from active searches
    if (activeSearches.has(userId)) {
      const search = activeSearches.get(userId);
      activeSearches.delete(userId);
      console.log(`✅ Stopped search for ${search.driverName || search.passengerName}`);
      
      // Notify user via WebSocket
      if (websocketServer) {
        websocketServer.sendSearchStopped(userId, {
          searchId: search.searchId,
          rideType: search.rideType,
          reason: 'match_found',
          message: 'Search stopped - match found!'
        });
      }
    }
    
    return true;
  } catch (error) {
    console.error('❌ Error stopping user search:', error);
    return false;
  }
};

// Track match for a user
const trackUserMatch = (userId, matchId, matchedUserId) => {
  if (!userMatches.has(userId)) {
    userMatches.set(userId, new Set());
  }
  userMatches.get(userId).add(matchId);
  console.log(`📝 Tracked match ${matchId} for user ${userId}`);
};

// ========== WEB SOCKET CONNECTION HELPER ==========

const waitForWebSocketConnection = (userId, maxWaitTime = 5000) => {
  return new Promise((resolve) => {
    if (!websocketServer) {
      console.log('❌ WebSocket server not available');
      return resolve(false);
    }

    const startTime = Date.now();
    
    const checkConnection = () => {
      const isConnected = websocketServer.isUserConnected(userId);
      
      if (isConnected) {
        console.log(`✅ WebSocket connection confirmed for ${userId}`);
        resolve(true);
        return;
      }
      
      const elapsed = Date.now() - startTime;
      if (elapsed > maxWaitTime) {
        console.log(`⏰ WebSocket connection timeout for ${userId}`);
        resolve(false);
        return;
      }
      
      setTimeout(checkConnection, 100);
    };
    
    checkConnection();
  });
};

// ========== SEARCH TIMEOUT MANAGEMENT ==========

const setImmediateSearchTimeout = (userId, searchId) => {
  const timeoutId = setTimeout(() => {
    console.log(`⏰ IMMEDIATE SEARCH TIMEOUT: Auto-stopping search for user ${userId}`);
    
    if (activeSearches.has(userId)) {
      const search = activeSearches.get(userId);
      activeSearches.delete(userId);
      
      if (websocketServer) {
        websocketServer.sendSearchTimeout(userId, {
          searchId: searchId,
          message: 'Search automatically stopped after 5 minutes',
          duration: '5 minutes',
          rideType: 'immediate'
        });
      }
      
      console.log(`🛑 Auto-stopped immediate search: ${search.driverName || search.passengerName}`);
    }
    
    searchTimeouts.delete(userId);
    
  }, IMMEDIATE_SEARCH_TIMEOUT);

  searchTimeouts.set(userId, {
    timeoutId: timeoutId,
    searchId: searchId,
    type: 'immediate',
    startedAt: Date.now(),
    expiresAt: Date.now() + IMMEDIATE_SEARCH_TIMEOUT
  });

  console.log(`⏰ Set 5-minute timeout for immediate search: ${userId}`);
};

const clearSearchTimeout = (userId) => {
  if (searchTimeouts.has(userId)) {
    const timeout = searchTimeouts.get(userId);
    clearTimeout(timeout.timeoutId);
    searchTimeouts.delete(userId);
    console.log(`🧹 Cleared timeout for user: ${userId}`);
  }
};

// ========== MATCH CREATION WITH AUTO-STOP ==========

const storeMatchInFirestore = async (matchData) => {
  try {
    const activeMatchData = {
      matchId: matchData.matchId,
      driverId: matchData.driverId,
      driverName: matchData.driverName,
      driverPhone: matchData.driverPhone,
      driverPhotoUrl: matchData.driverPhotoUrl,
      driverRating: matchData.driverRating,
      vehicleInfo: matchData.vehicleInfo,
      passengerId: matchData.passengerId,
      passengerName: matchData.passengerName,
      passengerPhone: matchData.passengerPhone,
      passengerPhotoUrl: matchData.passengerPhotoUrl,
      similarityScore: matchData.similarityScore,
      pickupName: matchData.pickupName || 'Unknown',
      destinationName: matchData.destinationName || 'Unknown',
      pickupLocation: matchData.pickupLocation,
      destinationLocation: matchData.destinationLocation,
      rideType: matchData.rideType || 'immediate',
      scheduledTime: matchData.scheduledTime,
      matchStatus: 'proposed',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection(ACTIVE_MATCHES_COLLECTION).doc(matchData.matchId).set(activeMatchData);
    console.log(`✅ Match stored in ${ACTIVE_MATCHES_COLLECTION}: ${matchData.driverName} ↔ ${matchData.passengerName}`);
    
    return true;
    
  } catch (error) {
    console.error('❌ Error storing match in Firestore:', error);
    return false;
  }
};

const createActiveMatchForOverlay = async (matchData) => {
  try {
    // First, store the match in Firestore
    await storeMatchInFirestore(matchData);
    
    // Update driver's document with match proposal
    const driverUpdates = {
      matchId: matchData.matchId,
      matchedWith: matchData.passengerId,
      matchStatus: 'proposed',
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    };
    
    await updateDriverSearch(matchData.driverId, driverUpdates);
    
    // Update passenger's document with match proposal
    const passengerUpdates = {
      matchId: matchData.matchId,
      matchedWith: matchData.driverId,
      matchStatus: 'proposed',
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    };
    
    await updatePassengerSearch(matchData.passengerId, passengerUpdates);
    
    console.log(`✅ Match proposal created: ${matchData.driverName} ↔ ${matchData.passengerName}`);
    
    // Send WebSocket notifications
    if (websocketServer) {
      // Send to driver
      websocketServer.sendMatchProposal(matchData.driverId, {
        matchId: matchData.matchId,
        passengerId: matchData.passengerId,
        passengerName: matchData.passengerName,
        passengerPhone: matchData.passengerPhone,
        pickupName: matchData.pickupName,
        destinationName: matchData.destinationName,
        passengerCount: matchData.passengerCount || 1,
        message: 'New passenger match found!',
        timeout: MATCH_PROPOSAL_TIMEOUT
      });
      
      // Send to passenger
      websocketServer.sendMatchProposal(matchData.passengerId, {
        matchId: matchData.matchId,
        driverId: matchData.driverId,
        driverName: matchData.driverName,
        driverPhone: matchData.driverPhone,
        driverPhotoUrl: matchData.driverPhotoUrl,
        driverRating: matchData.driverRating,
        vehicleInfo: matchData.vehicleInfo,
        pickupName: matchData.pickupName,
        destinationName: matchData.destinationName,
        estimatedFare: matchData.estimatedFare,
        message: 'Driver match found! Please wait for driver acceptance.',
        timeout: MATCH_PROPOSAL_TIMEOUT
      });
    }
    
    // Set timeout for match proposal
    setTimeout(async () => {
      const driverData = await getDriverSearch(matchData.driverId);
      const passengerData = await getPassengerSearch(matchData.passengerId);
      
      if (driverData && passengerData) {
        if (driverData.matchStatus === 'proposed' && driverData.matchId === matchData.matchId) {
          // Match proposal expired
          console.log(`⏰ Match proposal expired: ${matchData.matchId}`);
          
          // Reset match status in both collections
          await updateDriverSearch(matchData.driverId, {
            matchId: null,
            matchedWith: null,
            matchStatus: 'expired'
          });
          
          await updatePassengerSearch(matchData.passengerId, {
            matchId: null,
            matchedWith: null,
            matchStatus: 'expired'
          });
          
          // Update match document
          await db.collection(ACTIVE_MATCHES_COLLECTION).doc(matchData.matchId).update({
            matchStatus: 'expired',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          
          // Notify users
          if (websocketServer) {
            websocketServer.sendMatchExpired(matchData.driverId, {
              matchId: matchData.matchId,
              message: 'Match proposal expired - passenger not accepted in time'
            });
            
            websocketServer.sendMatchExpired(matchData.passengerId, {
              matchId: matchData.matchId,
              message: 'Match proposal expired'
            });
          }
        }
      }
    }, MATCH_PROPOSAL_TIMEOUT);
    
    return true;
    
  } catch (error) {
    console.error('❌ Error creating overlay match:', error);
    return false;
  }
};

// ========== ENHANCED SEARCH STORAGE WITH SEPARATE COLLECTIONS ==========

const storeSearchInMemory = async (searchData) => {
  const { userId, userType, rideType = 'immediate' } = searchData;
  
  if (!userId) throw new Error('userId is required');

  const actualUserType = userType || (searchData.driverId ? 'driver' : 'passenger');
  const driverName = searchData.driverName || 'Unknown Driver';
  const passengerName = searchData.passengerName || 'Unknown Passenger';

  const enhancedSearchData = {
    userId: userId,
    userType: actualUserType,
    driverName: driverName,
    passengerName: passengerName,
    
    // ✅ DRIVER PROFILE DATA
    driverPhone: searchData.driverPhone,
    driverPhotoUrl: searchData.driverPhotoUrl,
    driverRating: searchData.driverRating,
    vehicleInfo: searchData.vehicleInfo,
    
    // ✅ PASSENGER DATA
    passengerPhone: searchData.passengerPhone,
    passengerPhotoUrl: searchData.passengerPhotoUrl,
    
    // ✅ LOCATION DATA
    pickupLocation: searchData.pickupLocation || {},
    destinationLocation: searchData.destinationLocation || {},
    pickupName: searchData.pickupName || 'Unknown Pickup',
    destinationName: searchData.destinationName || 'Unknown Destination',
    routePoints: searchData.routePoints || [],
    
    // ✅ CAPACITY & PREFERENCES
    passengerCount: searchData.passengerCount || (actualUserType === 'passenger' ? 1 : 0),
    capacity: searchData.capacity || 4,
    vehicleType: searchData.vehicleType || 'car',
    
    // ✅ ROUTE INFORMATION
    distance: searchData.distance,
    duration: searchData.duration,
    fare: searchData.fare,
    estimatedFare: searchData.estimatedFare,
    maxWaitTime: searchData.maxWaitTime,
    preferredVehicleType: searchData.preferredVehicleType,
    specialRequests: searchData.specialRequests,
    maxWalkDistance: searchData.maxWalkDistance,
    
    // ✅ SEARCH METADATA
    rideType: rideType,
    scheduledTime: searchData.scheduledTime,
    searchId: searchData.searchId || `${rideType}_${userId}_${Date.now()}`,
    status: 'searching',
    lastUpdated: Date.now(),
    createdAt: searchData.createdAt || new Date().toISOString()
  };

  // Store in memory for immediate access
  activeSearches.set(userId, enhancedSearchData);
  
  if (rideType === 'scheduled') {
    console.log(`🎯 SCHEDULED search stored: ${driverName || passengerName}`);
  } else {
    console.log(`🎯 IMMEDIATE search stored: ${driverName || passengerName}`);
  }
  
  if (actualUserType === 'driver') {
    console.log(`   - Available Seats: ${searchData.capacity || 4}`);
  }
  
  setImmediateSearchTimeout(userId, enhancedSearchData.searchId);

  // WebSocket notifications
  const isConnected = await waitForWebSocketConnection(userId);
  if (websocketServer && isConnected) {
    const sent = websocketServer.sendSearchStarted(userId, enhancedSearchData);
    console.log(`📤 WebSocket search notification: ${sent}`);
  }
  
  // Debug stats
  const currentDrivers = Array.from(activeSearches.values()).filter(s => s.userType === 'driver');
  const currentPassengers = Array.from(activeSearches.values()).filter(s => s.userType === 'passenger');
  
  console.log(`📊 Memory Stats - Active: ${activeSearches.size} (D:${currentDrivers.length} P:${currentPassengers.length})`);
  console.log(`🧪 TEST MODE: ${TEST_MODE ? 'ACTIVE' : 'INACTIVE'}`);
  
  return enhancedSearchData;
};

// ========== DRIVER SCHEDULES ENDPOINT ==========

app.post("/api/match/driver-schedule", async (req, res) => {
  try {
    console.log('📅 === DRIVER SCHEDULE ENDPOINT CALLED ===');
    
    const { 
      userId, 
      driverId,
      driverName,
      driverPhone,
      driverPhotoUrl,
      driverRating,
      vehicleInfo,
      pickupLocation,
      destinationLocation,
      pickupName,
      destinationName,
      routePoints,
      capacity,
      passengerCount,
      scheduledTime,
      vehicleType,
      distance,
      duration,
      fare,
      estimatedFare,
      maxWaitTime,
      preferredVehicleType,
      specialRequests,
      maxWalkDistance,
      activateImmediately = TEST_MODE
    } = req.body;
    
    const actualDriverId = driverId || userId;
    
    if (!actualDriverId) {
      return res.status(400).json({ 
        success: false, 
        error: 'driverId or userId is required' 
      });
    }

    if (!scheduledTime) {
      return res.status(400).json({ 
        success: false, 
        error: 'scheduledTime is required for driver schedules' 
      });
    }

    // 🎯 Save driver schedule to dedicated Firestore collection
    const scheduleData = {
      driverId: actualDriverId,
      driverName: driverName,
      driverPhone: driverPhone,
      driverPhotoUrl: driverPhotoUrl,
      driverRating: driverRating,
      vehicleInfo: vehicleInfo,
      pickupLocation: pickupLocation,
      destinationLocation: destinationLocation,
      pickupName: pickupName,
      destinationName: destinationName,
      routePoints: routePoints,
      capacity: capacity,
      passengerCount: passengerCount,
      distance: distance,
      duration: duration,
      fare: fare,
      estimatedFare: estimatedFare,
      maxWaitTime: maxWaitTime,
      preferredVehicleType: preferredVehicleType,
      specialRequests: specialRequests,
      maxWalkDistance: maxWalkDistance,
      scheduledTime: scheduledTime,
      activateImmediately: activateImmediately
    };

    const savedSchedule = await saveDriverScheduleToFirestore(scheduleData);

    let immediateSearchData = null;
    
    // If activating immediately, also create immediate search
    if (activateImmediately) {
      immediateSearchData = {
        userId: actualDriverId,
        userType: 'driver',
        driverName: driverName,
        driverPhone: driverPhone,
        driverPhotoUrl: driverPhotoUrl,
        driverRating: driverRating,
        vehicleInfo: vehicleInfo,
        pickupLocation: pickupLocation,
        destinationLocation: destinationLocation,
        pickupName: pickupName,
        destinationName: destinationName,
        routePoints: routePoints,
        capacity: capacity,
        passengerCount: passengerCount,
        distance: distance,
        duration: duration,
        fare: fare,
        estimatedFare: estimatedFare,
        maxWaitTime: maxWaitTime,
        preferredVehicleType: preferredVehicleType,
        specialRequests: specialRequests,
        maxWalkDistance: maxWalkDistance,
        rideType: 'scheduled',
        scheduledTime: scheduledTime,
        vehicleType: vehicleType,
        activateImmediately: true
      };

      // Save to separate driver collection
      await saveDriverSearch(immediateSearchData);
      await storeSearchInMemory(immediateSearchData);
    }

    res.json({
      success: true,
      message: activateImmediately ? 
        'Driver schedule created and ACTIVATED IMMEDIATELY!' : 
        'Driver schedule created successfully',
      scheduleId: savedSchedule.scheduleId,
      driverId: actualDriverId,
      driverName: driverName,
      driverRating: driverRating,
      vehicleInfo: vehicleInfo,
      scheduledTime: scheduledTime,
      status: activateImmediately ? 'active' : 'scheduled',
      availableSeats: capacity || 4,
      activationTime: activateImmediately ? 'IMMEDIATELY' : '30 minutes before scheduled time',
      storage: {
        schedule: DRIVER_SCHEDULES_COLLECTION,
        search: activateImmediately ? ACTIVE_SEARCHES_DRIVER_COLLECTION : 'Not created'
      },
      immediateSearch: activateImmediately ? 'Created' : 'Not created',
      testMode: TEST_MODE
    });
    
  } catch (error) {
    console.error('❌ Error creating driver schedule:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== GET DRIVER SCHEDULE STATUS ENDPOINT ==========

app.get("/api/match/driver-schedule/:driverId", async (req, res) => {
  try {
    const { driverId } = req.params;
    
    console.log(`🔍 Checking driver schedule from Firestore for: ${driverId}`);
    
    const schedule = await getDriverScheduleFromFirestore(driverId);
    
    if (!schedule) {
      return res.json({
        success: true,
        exists: false,
        message: 'No driver schedule found',
        driverId: driverId
      });
    }

    const now = new Date();
    const timeUntilRide = schedule.scheduledTime.getTime() - now.getTime();
    
    res.json({
      success: true,
      exists: true,
      scheduleId: schedule.scheduleId,
      driverId: schedule.driverId,
      driverName: schedule.driverName,
      driverPhone: schedule.driverPhone,
      driverPhotoUrl: schedule.driverPhotoUrl,
      driverRating: schedule.driverRating,
      vehicleInfo: schedule.vehicleInfo,
      scheduledTime: schedule.scheduledTime.toISOString(),
      status: schedule.status,
      timeUntilRide: Math.round(timeUntilRide / 60000),
      pickupName: schedule.pickupName,
      destinationName: schedule.destinationName,
      capacity: schedule.capacity,
      distance: schedule.distance,
      duration: schedule.duration,
      fare: schedule.fare,
      storage: 'Firestore Schedule Collection',
      testMode: TEST_MODE
    });
    
  } catch (error) {
    console.error('❌ Error getting driver schedule:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== SYMMETRICAL MATCH SEARCH ENDPOINT ==========

app.post("/api/match/search", async (req, res) => {
  try {
    console.log('🎯 === SYMMETRICAL MATCH SEARCH ENDPOINT ===');
    
    const { 
      userId, 
      userType, // 'driver' or 'passenger' - REQUIRED
      driverId,
      driverName,
      driverPhone,
      driverPhotoUrl,
      driverRating,
      totalRides,
      isVerified,
      totalEarnings,
      completedRides,
      isOnline,
      isSearching,
      passengerName,
      passengerPhone,
      passengerPhotoUrl,
      pickupLocation,
      destinationLocation,
      pickupName,
      destinationName,
      routePoints,
      capacity,
      passengerCount,
      vehicleInfo,
      distance,
      duration,
      fare,
      estimatedFare,
      maxWaitTime,
      preferredVehicleType,
      specialRequests,
      maxWalkDistance,
      rideType = 'immediate',
      scheduledTime,
      searchId
    } = req.body;
    
    const actualUserId = userId || driverId;
    
    if (!actualUserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId or driverId is required' 
      });
    }

    if (!userType) {
      return res.status(400).json({ 
        success: false, 
        error: 'userType is required (driver or passenger)' 
      });
    }

    // Clear any existing search
    if (activeSearches.has(actualUserId)) {
      console.log(`🔄 Clearing existing search for user: ${actualUserId}`);
      clearSearchTimeout(actualUserId);
      activeSearches.delete(actualUserId);
    }

    const searchData = {
      userId: actualUserId,
      userType: userType,
      
      // ✅ DRIVER DATA (if driver)
      driverName: driverName,
      driverPhone: driverPhone,
      driverPhotoUrl: driverPhotoUrl,
      driverRating: driverRating,
      totalRides: totalRides,
      isVerified: isVerified,
      totalEarnings: totalEarnings,
      completedRides: completedRides,
      isOnline: isOnline,
      isSearching: isSearching,
      vehicleInfo: vehicleInfo,
      
      // ✅ PASSENGER DATA (if passenger)
      passengerName: passengerName,
      passengerPhone: passengerPhone,
      passengerPhotoUrl: passengerPhotoUrl,
      
      // ✅ LOCATION DATA
      pickupLocation: pickupLocation,
      destinationLocation: destinationLocation,
      pickupName: pickupName,
      destinationName: destinationName,
      routePoints: routePoints,
      
      // ✅ CAPACITY DATA
      capacity: capacity,
      passengerCount: passengerCount,
      
      // ✅ ROUTE DATA
      distance: distance,
      duration: duration,
      fare: fare,
      estimatedFare: estimatedFare,
      maxWaitTime: maxWaitTime,
      preferredVehicleType: preferredVehicleType,
      specialRequests: specialRequests,
      maxWalkDistance: maxWalkDistance,
      
      // ✅ SEARCH METADATA
      rideType: rideType,
      scheduledTime: scheduledTime,
      searchId: searchId || `search_${actualUserId}_${Date.now()}`
    };

    // 🎯 SAVE TO SEPARATE COLLECTIONS BASED ON USER TYPE
    if (userType === 'driver') {
      await saveDriverSearch(searchData);
    } else if (userType === 'passenger') {
      await savePassengerSearch(searchData);
    }
    
    // Also store in memory for immediate access
    await storeSearchInMemory(searchData);

    res.json({
      success: true,
      message: `${userType} search started successfully`,
      searchId: searchData.searchId,
      userId: actualUserId,
      userType: userType,
      driverName: driverName,
      driverRating: driverRating,
      passengerName: passengerName,
      vehicleInfo: vehicleInfo,
      rideType: rideType,
      availableSeats: userType === 'driver' ? (capacity || 4) : null,
      passengerCount: userType === 'passenger' ? (passengerCount || 1) : null,
      timeout: '5 minutes (or until match found)',
      storage: userType === 'driver' ? ACTIVE_SEARCHES_DRIVER_COLLECTION : ACTIVE_SEARCHES_PASSENGER_COLLECTION,
      websocketConnected: websocketServer ? websocketServer.isUserConnected(actualUserId) : false,
      testMode: TEST_MODE,
      unlimitedCapacity: UNLIMITED_CAPACITY,
      dataIncluded: {
        driverProfile: userType === 'driver',
        passengerProfile: userType === 'passenger',
        vehicleInfo: userType === 'driver',
        routeData: true,
        preferences: true,
        matchFields: true
      }
    });
    
  } catch (error) {
    console.error('❌ Error in symmetrical match search:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== DRIVER ACCEPT PASSENGER ENDPOINT ==========

app.post("/api/match/accept", async (req, res) => {
  try {
    console.log('✅ === DRIVER ACCEPT PASSENGER ENDPOINT ===');
    
    const { 
      driverId, 
      userId,
      matchId,
      passengerId 
    } = req.body;
    
    const actualDriverId = driverId || userId;
    
    if (!actualDriverId) {
      return res.status(400).json({ 
        success: false, 
        error: 'driverId or userId is required' 
      });
    }
    
    if (!matchId) {
      return res.status(400).json({ 
        success: false, 
        error: 'matchId is required' 
      });
    }
    
    if (!passengerId) {
      return res.status(400).json({ 
        success: false, 
        error: 'passengerId is required' 
      });
    }
    
    console.log(`🤝 Driver ${actualDriverId} accepting match ${matchId} with passenger ${passengerId}`);
    
    // Get driver document
    const driverData = await getDriverSearch(actualDriverId);
    if (!driverData) {
      return res.status(404).json({ 
        success: false, 
        error: 'Driver not found in active searches' 
      });
    }
    
    // Verify match exists and is proposed
    if (driverData.matchId !== matchId || driverData.matchStatus !== 'proposed') {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid match or match already processed' 
      });
    }
    
    // Verify matched with correct passenger
    if (driverData.matchedWith !== passengerId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Passenger ID does not match proposed match' 
      });
    }
    
    // Get passenger document
    const passengerData = await getPassengerSearch(passengerId);
    if (!passengerData) {
      return res.status(404).json({ 
        success: false, 
        error: 'Passenger not found in active searches' 
      });
    }
    
    // Check if driver has available seats
    const passengerCount = passengerData.passengerCount || 1;
    const availableSeats = driverData.availableSeats || driverData.capacity || 4;
    if (availableSeats < passengerCount) {
      return res.status(400).json({ 
        success: false, 
        error: `Not enough available seats. Available: ${availableSeats}, Needed: ${passengerCount}` 
      });
    }
    
    // Generate ride ID
    const rideId = `ride_${uuidv4()}`;
    
    // Create active ride
    const rideData = await createActiveRide(driverData, passengerData);
    
    // Update driver document
    const driverUpdates = await updateDriverWithPassenger(actualDriverId, passengerData, matchId, rideId);
    
    // Update passenger document
    await updatePassengerWithDriver(passengerId, driverData, matchId, rideId);
    
    // Update match document
    await db.collection(ACTIVE_MATCHES_COLLECTION).doc(matchId).update({
      matchStatus: 'accepted',
      rideId: rideId,
      acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Stop searching for passenger in memory
    stopUserSearch(passengerId);
    
    // Notify both users via WebSocket
    if (websocketServer) {
      // Notify driver
      websocketServer.sendMatchAccepted(actualDriverId, {
        matchId: matchId,
        rideId: rideId,
        passengerId: passengerId,
        passengerName: passengerData.passengerName,
        passengerPhone: passengerData.passengerPhone,
        pickupName: passengerData.pickupName || driverData.pickupName,
        destinationName: passengerData.destinationName || driverData.destinationName,
        passengerCount: passengerCount,
        message: 'Passenger accepted successfully!',
        nextStep: 'Proceed to pickup location'
      });
      
      // Notify passenger
      websocketServer.sendMatchAccepted(passengerId, {
        matchId: matchId,
        rideId: rideId,
        driverId: actualDriverId,
        driverName: driverData.driverName,
        driverPhone: driverData.driverPhone,
        driverPhotoUrl: driverData.driverPhotoUrl,
        driverRating: driverData.driverRating,
        vehicleInfo: driverData.vehicleInfo,
        pickupName: passengerData.pickupName || driverData.pickupName,
        destinationName: passengerData.destinationName || driverData.destinationName,
        estimatedFare: passengerData.estimatedFare || driverData.estimatedFare,
        message: 'Driver has accepted your ride!',
        nextStep: 'Wait for driver to arrive'
      });
    }
    
    res.json({
      success: true,
      message: 'Passenger accepted successfully',
      matchId: matchId,
      rideId: rideId,
      driverId: actualDriverId,
      driverName: driverData.driverName,
      passengerId: passengerId,
      passengerName: passengerData.passengerName,
      passengerCount: passengerCount,
      availableSeats: driverUpdates.availableSeats,
      currentPassengers: driverUpdates.currentPassengers,
      rideData: rideData,
      nextStep: 'Proceed to pickup location',
      websocketNotification: true
    });
    
  } catch (error) {
    console.error('❌ Error accepting passenger:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== DRIVER REJECT PASSENGER ENDPOINT ==========

app.post("/api/match/reject", async (req, res) => {
  try {
    console.log('❌ === DRIVER REJECT PASSENGER ENDPOINT ===');
    
    const { 
      driverId, 
      userId,
      matchId,
      passengerId,
      userType = 'driver'
    } = req.body;
    
    const actualUserId = driverId || userId;
    
    if (!actualUserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId or driverId is required' 
      });
    }
    
    if (!matchId) {
      return res.status(400).json({ 
        success: false, 
        error: 'matchId is required' 
      });
    }
    
    await rejectMatch(actualUserId, userType, matchId);
    
    res.json({
      success: true,
      message: 'Match rejected successfully',
      matchId: matchId,
      userId: actualUserId,
      userType: userType,
      websocketNotification: true
    });
    
  } catch (error) {
    console.error('❌ Error rejecting match:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== GET MATCH STATUS ENDPOINT ==========

app.get("/api/match/status/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    
    console.log(`🔍 Getting match status for user: ${userId}`);
    
    // First check if it's a driver
    let userData = await getDriverSearch(userId);
    let userType = 'driver';
    
    // If not a driver, check if it's a passenger
    if (!userData) {
      userData = await getPassengerSearch(userId);
      userType = 'passenger';
    }
    
    if (!userData) {
      return res.json({
        success: true,
        exists: false,
        message: 'User not found in active searches'
      });
    }
    
    let matchData = null;
    let rideData = null;
    
    if (userData.matchId) {
      const matchDoc = await db.collection(ACTIVE_MATCHES_COLLECTION).doc(userData.matchId).get();
      if (matchDoc.exists) {
        matchData = matchDoc.data();
      }
    }
    
    if (userData.rideId) {
      const rideDoc = await db.collection(ACTIVE_RIDES_COLLECTION).doc(userData.rideId).get();
      if (rideDoc.exists) {
        rideData = rideDoc.data();
      }
    }
    
    const status = {
      success: true,
      userId: userId,
      userType: userType,
      matchStatus: userData.matchStatus,
      matchId: userData.matchId,
      matchedWith: userData.matchedWith,
      tripStatus: userData.tripStatus,
      rideId: userData.rideId,
      currentPassengers: userData.currentPassengers || 0,
      availableSeats: userData.availableSeats || (userData.capacity || 4),
      acceptedAt: userData.acceptedAt,
      matchData: matchData,
      rideData: rideData,
      embeddedData: userType === 'driver' ? userData.passenger : userData.driver,
      collection: userType === 'driver' ? ACTIVE_SEARCHES_DRIVER_COLLECTION : ACTIVE_SEARCHES_PASSENGER_COLLECTION
    };
    
    res.json(status);
    
  } catch (error) {
    console.error('❌ Error getting match status:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== GET DRIVER STATUS ENDPOINT ==========

app.get("/api/match/driver-status/:driverId", async (req, res) => {
  try {
    const { driverId } = req.params;
    
    console.log(`🔍 Getting driver status for: ${driverId}`);
    
    const driverData = await getDriverSearch(driverId);
    
    if (!driverData) {
      return res.json({
        success: true,
        exists: false,
        message: 'Driver not found in active searches',
        driverId: driverId,
        collection: ACTIVE_SEARCHES_DRIVER_COLLECTION
      });
    }
    
    let matchData = null;
    let rideData = null;
    
    if (driverData.matchId) {
      const matchDoc = await db.collection(ACTIVE_MATCHES_COLLECTION).doc(driverData.matchId).get();
      if (matchDoc.exists) {
        matchData = matchDoc.data();
      }
    }
    
    if (driverData.rideId) {
      const rideDoc = await db.collection(ACTIVE_RIDES_COLLECTION).doc(driverData.rideId).get();
      if (rideDoc.exists) {
        rideData = rideDoc.data();
      }
    }
    
    const status = {
      success: true,
      exists: true,
      driverId: driverId,
      driverName: driverData.driverName,
      driverPhone: driverData.driverPhone,
      driverPhotoUrl: driverData.driverPhotoUrl,
      driverRating: driverData.driverRating,
      vehicleInfo: driverData.vehicleInfo,
      matchStatus: driverData.matchStatus,
      matchId: driverData.matchId,
      matchedWith: driverData.matchedWith,
      tripStatus: driverData.tripStatus,
      rideId: driverData.rideId,
      currentPassengers: driverData.currentPassengers || 0,
      availableSeats: driverData.availableSeats || driverData.capacity || 4,
      capacity: driverData.capacity || 4,
      acceptedAt: driverData.acceptedAt,
      passenger: driverData.passenger,
      matchData: matchData,
      rideData: rideData,
      collection: ACTIVE_SEARCHES_DRIVER_COLLECTION,
      searchId: driverData.searchId,
      status: driverData.status,
      rideType: driverData.rideType
    };
    
    res.json(status);
    
  } catch (error) {
    console.error('❌ Error getting driver status:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== GET PASSENGER STATUS ENDPOINT ==========

app.get("/api/match/passenger-status/:passengerId", async (req, res) => {
  try {
    const { passengerId } = req.params;
    
    console.log(`🔍 Getting passenger status for: ${passengerId}`);
    
    const passengerData = await getPassengerSearch(passengerId);
    
    if (!passengerData) {
      return res.json({
        success: true,
        exists: false,
        message: 'Passenger not found in active searches',
        passengerId: passengerId,
        collection: ACTIVE_SEARCHES_PASSENGER_COLLECTION
      });
    }
    
    let matchData = null;
    let rideData = null;
    
    if (passengerData.matchId) {
      const matchDoc = await db.collection(ACTIVE_MATCHES_COLLECTION).doc(passengerData.matchId).get();
      if (matchDoc.exists) {
        matchData = matchDoc.data();
      }
    }
    
    if (passengerData.rideId) {
      const rideDoc = await db.collection(ACTIVE_RIDES_COLLECTION).doc(passengerData.rideId).get();
      if (rideDoc.exists) {
        rideData = rideDoc.data();
      }
    }
    
    const status = {
      success: true,
      exists: true,
      passengerId: passengerId,
      passengerName: passengerData.passengerName,
      passengerPhone: passengerData.passengerPhone,
      passengerPhotoUrl: passengerData.passengerPhotoUrl,
      matchStatus: passengerData.matchStatus,
      matchId: passengerData.matchId,
      matchedWith: passengerData.matchedWith,
      tripStatus: passengerData.tripStatus,
      rideId: passengerData.rideId,
      passengerCount: passengerData.passengerCount || 1,
      acceptedAt: passengerData.acceptedAt,
      driver: passengerData.driver,
      matchData: matchData,
      rideData: rideData,
      collection: ACTIVE_SEARCHES_PASSENGER_COLLECTION,
      searchId: passengerData.searchId,
      status: passengerData.status,
      rideType: passengerData.rideType
    };
    
    res.json(status);
    
  } catch (error) {
    console.error('❌ Error getting passenger status:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== DRIVER REAL-TIME LOCATION UPDATE ENDPOINT ==========

app.post("/api/driver/update-location", async (req, res) => {
  try {
    const { 
      userId, 
      driverId, 
      location, 
      address 
    } = req.body;
    
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
    
    console.log(`📍 === DRIVER LOCATION UPDATE ===`);
    console.log(`   Driver: ${actualDriverId}`);
    console.log(`   Location: ${location.latitude}, ${location.longitude}`);
    
    // Update driver location in separate collection
    await updateDriverSearch(actualDriverId, {
      currentLocation: {
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.accuracy || 0,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      }
    });
    
    // If driver has a passenger, update passenger's embedded driver location
    const driverData = await getDriverSearch(actualDriverId);
    if (driverData && driverData.matchedWith && driverData.passenger) {
      await updatePassengerSearch(driverData.matchedWith, {
        'driver.currentLocation': {
          latitude: location.latitude,
          longitude: location.longitude,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        }
      });
      
      // Notify passenger via WebSocket
      if (websocketServer) {
        websocketServer.sendDriverLocationUpdate(driverData.matchedWith, {
          driverId: actualDriverId,
          driverName: driverData.driverName,
          location: location,
          timestamp: new Date().toISOString()
        });
      }
    }
    
    res.json({
      success: true,
      message: 'Driver location updated successfully',
      driverId: actualDriverId,
      location: location,
      address: address,
      timestamp: new Date().toISOString(),
      passengerNotified: !!driverData?.matchedWith
    });
    
  } catch (error) {
    console.error('❌ Error updating driver location:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== PASSENGER REAL-TIME LOCATION UPDATE ENDPOINT ==========

app.post("/api/passenger/update-location", async (req, res) => {
  try {
    const { 
      userId, 
      passengerId, 
      location, 
      address 
    } = req.body;
    
    const actualUserId = passengerId || userId;
    
    if (!actualUserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'passengerId or userId is required' 
      });
    }
    
    if (!location || !location.latitude || !location.longitude) {
      return res.status(400).json({ 
        success: false, 
        error: 'Valid location with latitude and longitude is required' 
      });
    }
    
    console.log(`📍 === PASSENGER LOCATION UPDATE ===`);
    console.log(`   Passenger: ${actualUserId}`);
    console.log(`   Location: ${location.latitude}, ${location.longitude}`);
    
    // Update passenger location in separate collection
    await updatePassengerSearch(actualUserId, {
      currentLocation: {
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.accuracy || 0,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      }
    });
    
    // If passenger has a driver, update driver's embedded passenger location
    const passengerData = await getPassengerSearch(actualUserId);
    if (passengerData && passengerData.matchedWith && passengerData.driver) {
      await updateDriverSearch(passengerData.matchedWith, {
        'passenger.currentLocation': {
          latitude: location.latitude,
          longitude: location.longitude,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        }
      });
      
      // Notify driver via WebSocket
      if (websocketServer) {
        websocketServer.sendPassengerLocationUpdate(passengerData.matchedWith, {
          passengerId: actualUserId,
          passengerName: passengerData.passengerName,
          location: location,
          timestamp: new Date().toISOString()
        });
      }
    }
    
    res.json({
      success: true,
      message: 'Passenger location updated successfully',
      passengerId: actualUserId,
      location: location,
      address: address,
      timestamp: new Date().toISOString(),
      driverNotified: !!passengerData?.matchedWith
    });
    
  } catch (error) {
    console.error('❌ Error updating passenger location:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== TRIP STATUS UPDATE ENDPOINT ==========

app.post("/api/trip/update-status", async (req, res) => {
  try {
    const { userId, userType, tripStatus, location } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId is required' 
      });
    }
    
    if (!userType) {
      return res.status(400).json({ 
        success: false, 
        error: 'userType is required (driver or passenger)' 
      });
    }
    
    if (!tripStatus) {
      return res.status(400).json({ 
        success: false, 
        error: 'tripStatus is required' 
      });
    }
    
    console.log(`🔄 === TRIP STATUS UPDATE ===`);
    console.log(`   User: ${userId} (${userType})`);
    console.log(`   New Status: ${tripStatus}`);
    
    // Prepare updates
    const updates = {
      tripStatus: tripStatus,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    };
    
    // Add location if provided
    if (location) {
      updates.currentLocation = {
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.accuracy || 0,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      };
    }
    
    // Update trip milestones
    if (tripStatus === 'arrived_at_pickup') {
      updates.arrivedAtPickupTime = admin.firestore.FieldValue.serverTimestamp();
    } else if (tripStatus === 'on_trip') {
      updates.tripStartedAt = admin.firestore.FieldValue.serverTimestamp();
    } else if (tripStatus === 'arrived_at_destination') {
      updates.arrivedAtDestinationTime = admin.firestore.FieldValue.serverTimestamp();
    }
    
    if (userType === 'driver') {
      // Update driver document
      await updateDriverSearch(userId, updates);
      
      // If driver has a passenger, update passenger's embedded driver status
      const driverData = await getDriverSearch(userId);
      if (driverData && driverData.matchedWith && driverData.passenger) {
        const passengerUpdates = {
          'driver.tripStatus': tripStatus,
          lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        };
        
        if (location) {
          passengerUpdates['driver.currentLocation'] = {
            latitude: location.latitude,
            longitude: location.longitude,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          };
        }
        
        await updatePassengerSearch(driverData.matchedWith, passengerUpdates);
        
        // Notify passenger via WebSocket
        if (websocketServer) {
          websocketServer.sendTripStatusUpdate(driverData.matchedWith, {
            driverId: userId,
            driverName: driverData.driverName,
            tripStatus: tripStatus,
            location: location,
            timestamp: new Date().toISOString()
          });
        }
      }
      
    } else if (userType === 'passenger') {
      // Update passenger document
      await updatePassengerSearch(userId, updates);
      
      // If passenger has a driver, update driver's embedded passenger status
      const passengerData = await getPassengerSearch(userId);
      if (passengerData && passengerData.matchedWith && passengerData.driver) {
        const driverUpdates = {
          'passenger.tripStatus': tripStatus,
          lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        };
        
        if (location) {
          driverUpdates['passenger.currentLocation'] = {
            latitude: location.latitude,
            longitude: location.longitude,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          };
        }
        
        await updateDriverSearch(passengerData.matchedWith, driverUpdates);
        
        // Notify driver via WebSocket
        if (websocketServer) {
          websocketServer.sendTripStatusUpdate(passengerData.matchedWith, {
            passengerId: userId,
            passengerName: passengerData.passengerName,
            tripStatus: tripStatus,
            location: location,
            timestamp: new Date().toISOString()
          });
        }
      }
    }
    
    res.json({ 
      success: true, 
      tripStatus: tripStatus,
      userId: userId,
      userType: userType,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error updating trip status:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== STOP SEARCH ENDPOINT ==========

app.post("/api/match/stop-search", async (req, res) => {
  try {
    const { userId, userType, driverId, passengerId } = req.body;
    const actualUserId = userId || driverId || passengerId;
    
    if (!actualUserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId, driverId, or passengerId is required' 
      });
    }

    if (!userType) {
      return res.status(400).json({ 
        success: false, 
        error: 'userType is required (driver or passenger)' 
      });
    }

    console.log(`🛑 Stopping search for ${userType}: ${actualUserId}`);
    
    let stoppedFromMemory = false;
    let stoppedFromFirestore = false;
    
    // Stop from memory
    if (activeSearches.has(actualUserId)) {
      const search = activeSearches.get(actualUserId);
      clearSearchTimeout(actualUserId);
      activeSearches.delete(actualUserId);
      stoppedFromMemory = true;
      console.log(`✅ Stopped memory search: ${search.driverName || search.passengerName}`);
    }
    
    // Stop from Firestore based on user type
    if (userType === 'driver') {
      await stopDriverSearch(actualUserId);
      stoppedFromFirestore = true;
      console.log(`✅ Stopped driver search in ${ACTIVE_SEARCHES_DRIVER_COLLECTION}`);
    } else if (userType === 'passenger') {
      await stopPassengerSearch(actualUserId);
      stoppedFromFirestore = true;
      console.log(`✅ Stopped passenger search in ${ACTIVE_SEARCHES_PASSENGER_COLLECTION}`);
    }
    
    // Notify via WebSocket
    if (websocketServer) {
      websocketServer.sendSearchStopped(actualUserId, {
        userType: userType,
        reason: 'user_requested',
        message: 'Search stopped successfully',
        stoppedFromMemory: stoppedFromMemory,
        stoppedFromFirestore: stoppedFromFirestore
      });
    }
    
    res.json({
      success: true,
      message: 'Search stopped successfully',
      userId: actualUserId,
      userType: userType,
      stoppedFromMemory: stoppedFromMemory,
      stoppedFromFirestore: stoppedFromFirestore,
      collection: userType === 'driver' ? ACTIVE_SEARCHES_DRIVER_COLLECTION : ACTIVE_SEARCHES_PASSENGER_COLLECTION,
      activeSearchesRemaining: activeSearches.size
    });
    
  } catch (error) {
    console.error('❌ Error stopping search:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== OPTIMIZED MATCHING SERVICE WITH SEPARATE COLLECTIONS ==========

const startOptimizedMatching = () => {
  console.log('🔄 Starting Optimized Matching Service...');
  console.log(`🧪 TEST MODE: ${TEST_MODE ? 'ACTIVE' : 'INACTIVE'}`);
  console.log(`🎯 UNLIMITED CAPACITY: ${UNLIMITED_CAPACITY ? 'ACTIVE' : 'INACTIVE'}`);
  console.log(`💾 SEPARATE COLLECTIONS:`);
  console.log(`   - Drivers: ${ACTIVE_SEARCHES_DRIVER_COLLECTION}`);
  console.log(`   - Passengers: ${ACTIVE_SEARCHES_PASSENGER_COLLECTION}`);
  
  const matchingInterval = TEST_MODE ? TEST_MATCHING_INTERVAL : 30000;
  
  setInterval(async () => {
    try {
      console.log(`\n📊 ===== SYMMETRICAL MATCHING CYCLE START =====`);
      console.log(`🧪 TEST MODE: ${TEST_MODE ? 'ACTIVE' : 'INACTIVE'}`);
      
      // 🎯 Get active searches from SEPARATE collections
      const allDrivers = await getAllActiveDriverSearches();
      const allPassengers = await getAllActivePassengerSearches();
      
      console.log(`📊 Matching: ${allDrivers.length} drivers vs ${allPassengers.length} passengers`);
      
      if (allDrivers.length === 0 || allPassengers.length === 0) {
        console.log(`💤 No matches possible`);
        console.log(`📊 ===== SYMMETRICAL MATCHING CYCLE END =====\n`);
        return;
      }

      // Log search details
      console.log('🚗 Active Drivers:');
      allDrivers.forEach(driver => {
        console.log(`   - ${driver.driverName}`);
        console.log(`     Available Seats: ${driver.availableSeats}/${driver.capacity || 4} | Match Status: ${driver.matchStatus || 'none'}`);
      });

      console.log('👤 Active Passengers:');
      allPassengers.forEach(passenger => {
        console.log(`   - ${passenger.passengerName} - Match Status: ${passenger.matchStatus || 'none'}`);
      });
      
      let matchesCreated = 0;
      
      // 🎯 Perform matching
      for (const driver of allDrivers) {
        const driverUserId = driver.driverId || driver.userId;
        
        // Skip if driver already has a match
        if (driver.matchStatus === 'proposed' || driver.matchStatus === 'accepted') {
          console.log(`⏭️ Skipping driver ${driver.driverName} - already has match (${driver.matchStatus})`);
          continue;
        }
        
        // Check available seats
        const availableSeats = driver.availableSeats || driver.capacity || 4;
        if (availableSeats <= 0) {
          console.log(`⏭️ Skipping driver ${driver.driverName} - no available seats`);
          continue;
        }
        
        for (const passenger of allPassengers) {
          const passengerUserId = passenger.passengerId || passenger.userId;
          
          // Skip if passenger already has a match
          if (passenger.matchStatus === 'proposed' || passenger.matchStatus === 'accepted') {
            continue;
          }
          
          if (!driver.routePoints || driver.routePoints.length === 0) continue;
          if (!passenger.routePoints || passenger.routePoints.length === 0) continue;

          // Check passenger count fits in available seats
          const passengerCount = passenger.passengerCount || 1;
          if (passengerCount > availableSeats) {
            continue;
          }

          // Use routeMatching.js intelligent matching
          const match = await routeMatching.performIntelligentMatching(
            db, 
            driver, 
            passenger
          );
          
          if (match) {
            const matchKey = generateMatchKey(driverUserId, passengerUserId, Date.now());
            
            if (!processedMatches.has(matchKey)) {
              const matchData = {
                matchId: match.matchId,
                driverId: driverUserId,
                driverName: driver.driverName || 'Unknown Driver',
                driverPhone: driver.driverPhone,
                driverPhotoUrl: driver.driverPhotoUrl,
                driverRating: driver.driverRating,
                vehicleInfo: driver.vehicleInfo,
                passengerId: passengerUserId,
                passengerName: passenger.passengerName || 'Unknown Passenger',
                passengerPhone: passenger.passengerPhone,
                passengerPhotoUrl: passenger.passengerPhotoUrl,
                similarityScore: match.similarityScore,
                pickupName: passenger.pickupName || driver.pickupName || 'Unknown Location',
                destinationName: passenger.destinationName || driver.destinationName || 'Unknown Destination',
                pickupLocation: passenger.pickupLocation || driver.pickupLocation,
                destinationLocation: passenger.destinationLocation || driver.destinationLocation,
                passengerCount: passengerCount,
                capacity: driver.capacity || 4,
                vehicleType: driver.vehicleType || 'car',
                rideType: driver.rideType || passenger.rideType || 'immediate',
                scheduledTime: driver.scheduledTime || passenger.scheduledTime,
                timestamp: new Date().toISOString(),
                matchType: 'separate_collections',
                unlimitedMode: UNLIMITED_CAPACITY,
                source: 'Separate Collections'
              };

              const matchCreated = await createActiveMatchForOverlay(matchData);
              
              if (matchCreated) {
                matchesCreated++;
                processedMatches.set(matchKey, Date.now());
                console.log(`🎉 MATCH PROPOSAL CREATED: ${driver.driverName} ↔ ${passenger.passengerName}`);
                console.log(`   - Driver Available Seats: ${availableSeats}`);
                console.log(`   - Passenger Count: ${passengerCount}`);
              }
            }
          }
        }
      }

      if (matchesCreated > 0) {
        console.log(`📱 Created ${matchesCreated} match proposals`);
      }
      
      console.log(`📊 ===== SYMMETRICAL MATCHING CYCLE END =====\n`);
      
    } catch (error) {
      console.error('❌ Matching error:', error);
    }
  }, matchingInterval);

  // 🎯 Add cleanup for expired searches
  setInterval(async () => {
    try {
      console.log('🧹 Cleaning up expired searches...');
      
      const now = new Date();
      const expiryTime = new Date(now.getTime() - (30 * 60 * 1000)); // 30 minutes ago
      
      // Clean up expired driver searches
      const driverSnapshot = await db.collection(ACTIVE_SEARCHES_DRIVER_COLLECTION)
        .where('updatedAt', '<', admin.firestore.Timestamp.fromDate(expiryTime))
        .where('status', '==', 'searching')
        .get();
      
      let driverCleanupCount = 0;
      driverSnapshot.forEach(async (doc) => {
        await doc.ref.update({
          status: 'expired',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        driverCleanupCount++;
      });
      
      // Clean up expired passenger searches
      const passengerSnapshot = await db.collection(ACTIVE_SEARCHES_PASSENGER_COLLECTION)
        .where('updatedAt', '<', admin.firestore.Timestamp.fromDate(expiryTime))
        .where('status', '==', 'searching')
        .get();
      
      let passengerCleanupCount = 0;
      passengerSnapshot.forEach(async (doc) => {
        await doc.ref.update({
          status: 'expired',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        passengerCleanupCount++;
      });
      
      if (driverCleanupCount > 0 || passengerCleanupCount > 0) {
        console.log(`🧹 Cleaned up ${driverCleanupCount} driver searches and ${passengerCleanupCount} passenger searches`);
      }
      
    } catch (error) {
      console.error('❌ Error cleaning up expired searches:', error);
    }
  }, 5 * 60 * 1000); // Every 5 minutes
};

// ========== SEARCH STATUS ENDPOINT ==========

app.get("/api/match/search-status/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    
    console.log(`🔍 Getting search status for user: ${userId}`);
    
    const memorySearch = activeSearches.get(userId);
    const driverSchedule = await getDriverScheduleFromFirestore(userId);
    
    // Check both collections
    const driverSearch = await getDriverSearch(userId);
    const passengerSearch = await getPassengerSearch(userId);
    
    const userMatchCount = userMatches.get(userId)?.size || 0;
    const timeout = searchTimeouts.get(userId);
    
    const status = {
      success: true,
      userId: userId,
      memorySearch: memorySearch ? {
        exists: true,
        driverName: memorySearch.driverName,
        passengerName: memorySearch.passengerName,
        userType: memorySearch.userType,
        rideType: memorySearch.rideType,
        status: memorySearch.status,
        searchId: memorySearch.searchId,
        createdAt: memorySearch.createdAt
      } : { exists: false },
      driverSchedule: driverSchedule ? {
        exists: true,
        scheduleId: driverSchedule.scheduleId,
        driverName: driverSchedule.driverName,
        scheduledTime: driverSchedule.scheduledTime.toISOString(),
        status: driverSchedule.status
      } : { exists: false },
      driverSearch: driverSearch ? {
        exists: true,
        driverName: driverSearch.driverName,
        matchStatus: driverSearch.matchStatus,
        availableSeats: driverSearch.availableSeats,
        collection: ACTIVE_SEARCHES_DRIVER_COLLECTION
      } : { exists: false },
      passengerSearch: passengerSearch ? {
        exists: true,
        passengerName: passengerSearch.passengerName,
        matchStatus: passengerSearch.matchStatus,
        passengerCount: passengerSearch.passengerCount,
        collection: ACTIVE_SEARCHES_PASSENGER_COLLECTION
      } : { exists: false },
      matches: {
        count: userMatchCount,
        hasMatches: userMatchCount > 0
      },
      timeout: timeout ? {
        exists: true,
        type: timeout.type,
        startedAt: timeout.startedAt,
        expiresAt: timeout.expiresAt
      } : { exists: false },
      websocketConnected: websocketServer ? websocketServer.isUserConnected(userId) : false,
      stats: {
        activeSearches: activeSearches.size,
        activeTimeouts: searchTimeouts.size,
        usersWithMatches: userMatches.size
      }
    };
    
    res.json(status);
    
  } catch (error) {
    console.error('❌ Error getting search status:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== DEBUG ENDPOINT ==========

app.get("/api/debug/status", async (req, res) => {
  try {
    const memoryDrivers = Array.from(activeSearches.values())
      .filter(search => search.userType === 'driver');
    const memoryPassengers = Array.from(activeSearches.values())
      .filter(search => search.userType === 'passenger');
    
    const driverSchedulesSnapshot = await db.collection(DRIVER_SCHEDULES_COLLECTION)
      .where('status', 'in', ['scheduled', 'active'])
      .get();
    
    const driverSchedules = [];
    driverSchedulesSnapshot.forEach(doc => {
      const data = doc.data();
      driverSchedules.push({
        scheduleId: data.scheduleId,
        driverName: data.driverName,
        driverId: data.driverId,
        status: data.status,
        scheduledTime: data.scheduledTime.toDate().toISOString()
      });
    });
    
    // Get active drivers and passengers from separate collections
    const activeDrivers = await getAllActiveDriverSearches();
    const activePassengers = await getAllActivePassengerSearches();
    
    // Get active matches count
    const activeMatchesSnapshot = await db.collection(ACTIVE_MATCHES_COLLECTION)
      .where('matchStatus', '==', 'proposed')
      .get();
    
    const activeRidesSnapshot = await db.collection(ACTIVE_RIDES_COLLECTION).get();
    
    const debugInfo = {
      server: {
        timestamp: new Date().toISOString(),
        testMode: TEST_MODE,
        unlimitedCapacity: UNLIMITED_CAPACITY,
        websocketConnections: websocketServer ? websocketServer.getConnectedCount() : 0,
        symmetricalMatching: true,
        separateCollections: true
      },
      memory: {
        totalSearches: activeSearches.size,
        drivers: memoryDrivers.length,
        passengers: memoryPassengers.length,
        activeTimeouts: searchTimeouts.size,
        processedMatches: processedMatches.size,
        usersWithMatches: userMatches.size
      },
      firestore: {
        driverSchedules: driverSchedules.length,
        activeDrivers: activeDrivers.length,
        activePassengers: activePassengers.length,
        activeMatches: activeMatchesSnapshot.size,
        activeRides: activeRidesSnapshot.size,
        collections: {
          drivers: ACTIVE_SEARCHES_DRIVER_COLLECTION,
          passengers: ACTIVE_SEARCHES_PASSENGER_COLLECTION,
          schedules: DRIVER_SCHEDULES_COLLECTION,
          matches: ACTIVE_MATCHES_COLLECTION,
          rides: ACTIVE_RIDES_COLLECTION
        }
      },
      memoryDrivers: memoryDrivers.map(d => ({
        driverName: d.driverName,
        availableSeats: d.availableSeats,
        matchStatus: d.matchStatus
      })),
      memoryPassengers: memoryPassengers.map(p => ({
        passengerName: p.passengerName,
        matchStatus: p.matchStatus
      })),
      firestoreDrivers: activeDrivers.map(d => ({
        driverName: d.driverName,
        availableSeats: d.availableSeats,
        matchStatus: d.matchStatus
      })),
      firestorePassengers: activePassengers.map(p => ({
        passengerName: p.passengerName,
        matchStatus: p.matchStatus
      }))
    };
    
    res.json(debugInfo);
    
  } catch (error) {
    console.error('❌ Error in debug endpoint:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== HEALTH CHECK ENDPOINT ==========

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "ShareWay Symmetrical Matching Server is running",
    timestamp: new Date().toISOString(),
    version: "5.0.0",
    features: {
      symmetricalMatching: true,
      separateCollections: true,
      driverSchedules: true,
      firestoreStorage: true,
      websocketNotifications: true,
      matchAcceptance: true,
      tripStatusUpdates: true,
      testMode: TEST_MODE,
      unlimitedCapacity: UNLIMITED_CAPACITY,
      realTimeLocationUpdates: true,
      symmetricalEndpoints: true
    },
    collections: {
      drivers: ACTIVE_SEARCHES_DRIVER_COLLECTION,
      passengers: ACTIVE_SEARCHES_PASSENGER_COLLECTION,
      schedules: DRIVER_SCHEDULES_COLLECTION,
      matches: ACTIVE_MATCHES_COLLECTION,
      rides: ACTIVE_RIDES_COLLECTION,
      notifications: NOTIFICATIONS_COLLECTION
    },
    endpoints: {
      symmetrical: {
        search: "POST /api/match/search (works for both drivers & passengers)",
        updateLocation: {
          driver: "POST /api/driver/update-location",
          passenger: "POST /api/passenger/update-location"
        }
      },
      matchAcceptance: {
        accept: "POST /api/match/accept (driver accepts passenger)",
        reject: "POST /api/match/reject (reject match)",
        status: "GET /api/match/status/:userId (get match status)",
        driverStatus: "GET /api/match/driver-status/:driverId",
        passengerStatus: "GET /api/match/passenger-status/:passengerId"
      },
      driverSpecific: {
        schedule: "POST /api/match/driver-schedule",
        getSchedule: "GET /api/match/driver-schedule/:driverId"
      },
      trip: {
        updateStatus: "POST /api/trip/update-status"
      },
      utility: {
        stopSearch: "POST /api/match/stop-search",
        searchStatus: "GET /api/match/search-status/:userId",
        debug: "GET /api/debug/status",
        health: "GET /api/health"
      }
    },
    stats: {
      activeSearches: activeSearches.size,
      driverSchedules: "Check /api/debug/status",
      websocketConnections: websocketServer ? websocketServer.getConnectedCount() : 0
    }
  });
});

// ========== START SERVER ==========

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 ShareWay SYMMETRICAL MATCHING Server Started!
📍 Port: ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
🔥 Firebase: Complete Firestore Integration
💾 SEPARATE COLLECTIONS:
   - Drivers: ${ACTIVE_SEARCHES_DRIVER_COLLECTION}/{driverId}
   - Passengers: ${ACTIVE_SEARCHES_PASSENGER_COLLECTION}/{passengerId}
🔌 WebSocket: Real-time notifications

🎯 SYMMETRICAL ARCHITECTURE WITH SEPARATE COLLECTIONS:
   - Separate collections for drivers and passengers
   - Driver can accept/reject passenger matches
   - Real-time match proposals and acceptance flow
   - Embedded passenger/driver data in documents
   - Capacity tracking with available seats

🧪 TEST MODE: ${TEST_MODE ? 'ACTIVE' : 'INACTIVE'}
🎯 UNLIMITED CAPACITY: ${UNLIMITED_CAPACITY ? 'ACTIVE 🚀' : 'INACTIVE'}

📊 Current Stats:
- Active Searches in Memory: ${activeSearches.size}
- Processed Matches: ${processedMatches.size} (in memory)
- Active Timeouts: ${searchTimeouts.size} (in memory)
- Users with Matches: ${userMatches.size} (in memory)
- WebSocket Connections: ${websocketServer ? websocketServer.getConnectedCount() : 0}

💾 FIRESTORE COLLECTIONS:
- ${ACTIVE_SEARCHES_DRIVER_COLLECTION}: Driver searches with complete data
- ${ACTIVE_SEARCHES_PASSENGER_COLLECTION}: Passenger searches
- ${DRIVER_SCHEDULES_COLLECTION}: Driver schedules
- ${ACTIVE_MATCHES_COLLECTION}: Active match proposals
- ${ACTIVE_RIDES_COLLECTION}: Active rides after acceptance
- ${NOTIFICATIONS_COLLECTION}: User notifications

✅ FULLY SEPARATE COLLECTIONS SYSTEM 🎉
   - Drivers: ${ACTIVE_SEARCHES_DRIVER_COLLECTION}/{driverId}
   - Passengers: ${ACTIVE_SEARCHES_PASSENGER_COLLECTION}/{passengerId}
   - Match proposals with 2-minute timeout
   - Real-time WebSocket notifications
   - Capacity tracking and seat management

📱 SYMMETRICAL ENDPOINTS:
- POST /api/match/search - Start search (works for both drivers & passengers)
- POST /api/match/accept - Driver accepts passenger match
- POST /api/match/reject - Reject match proposal
- GET /api/match/status/:userId - Get match acceptance status
- GET /api/match/driver-status/:driverId - Get driver status
- GET /api/match/passenger-status/:passengerId - Get passenger status
- POST /api/driver/update-location - Update driver location
- POST /api/passenger/update-location - Update passenger location
- POST /api/trip/update-status - Update trip progression status
- POST /api/match/driver-schedule - Create driver schedule
- GET /api/match/driver-schedule/:driverId - Get driver schedule
- POST /api/match/stop-search - Stop search
- GET /api/debug/status - Debug information
- GET /api/health - Health check with symmetrical architecture info
    `);
  });

  setupWebSocket(server);
  startOptimizedMatching();

  server.on('error', (error) => {
    console.error('❌ Server error:', error);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    for (const [userId, timeout] of searchTimeouts.entries()) {
      clearTimeout(timeout.timeoutId);
    }
    searchTimeouts.clear();
    
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
