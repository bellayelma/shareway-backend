// src/app.js - COMPLETE SYMMETRICAL SCRIPT WITH ROUTEMATCHING INTEGRATION & TRIP STATUS UPDATES
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

// ========== FIRESTORE COLLECTION NAMES ==========
const DRIVER_SCHEDULES_COLLECTION = 'driver_schedules';
const ACTIVE_MATCHES_COLLECTION = 'active_matches';
const NOTIFICATIONS_COLLECTION = 'notifications';
const ACTIVE_SEARCHES_COLLECTION = 'active_searches';

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

// ========== DEDICATED FIRESTORE DRIVER SCHEDULES MANAGEMENT ==========

// 🎯 Save driver schedule to Firestore collection USING DRIVER_SCHEDULES
const saveDriverScheduleToFirestore = async (scheduleData) => {
  try {
    const driverId = scheduleData.driverId || scheduleData.userId;
    if (!driverId) {
      throw new Error('driverId is required for saving schedule');
    }

    const scheduleId = scheduleData.scheduleId || `schedule_${driverId}_${Date.now()}`;
    
    const driverSchedule = {
      // ✅ BASIC IDENTIFICATION
      scheduleId: scheduleId,
      driverId: driverId,
      userType: 'driver',
      
      // ✅ COMPLETE DRIVER PROFILE DATA
      driverName: scheduleData.driverName || 'Unknown Driver',
      driverPhone: scheduleData.driverPhone || 'Not provided',
      driverPhotoUrl: scheduleData.driverPhotoUrl || '',
      driverRating: scheduleData.driverRating || 5.0,
      totalRides: scheduleData.totalRides || 0,
      isVerified: scheduleData.isVerified || false,
      totalEarnings: scheduleData.totalEarnings || 0.0,
      completedRides: scheduleData.completedRides || 0,
      isOnline: scheduleData.isOnline || true,
      isSearching: scheduleData.isSearching || false,
      
      // ✅ COMPLETE VEHICLE INFORMATION
      vehicleInfo: scheduleData.vehicleInfo || {
        model: scheduleData.vehicleModel || 'Unknown Model',
        plate: scheduleData.vehiclePlate || 'Unknown Plate',
        color: scheduleData.vehicleColor || 'Unknown Color',
        type: scheduleData.vehicleType || 'car',
        year: scheduleData.vehicleYear || 'Unknown',
        passengerCapacity: scheduleData.capacity || 4
      },
      
      // ✅ LOCATION DATA
      pickupLocation: scheduleData.pickupLocation,
      destinationLocation: scheduleData.destinationLocation,
      pickupName: scheduleData.pickupName || 'Unknown Pickup',
      destinationName: scheduleData.destinationName || 'Unknown Destination',
      
      // ✅ ROUTE GEOMETRY
      routePoints: scheduleData.routePoints || [],
      
      // ✅ VEHICLE & CAPACITY DATA
      passengerCount: scheduleData.passengerCount || 0,
      capacity: scheduleData.capacity || 4,
      vehicleType: scheduleData.vehicleType || 'car',
      
      // ✅ ROUTE INFORMATION
      distance: scheduleData.distance || 0,
      duration: scheduleData.duration || 0,
      fare: scheduleData.fare || 0,
      estimatedFare: scheduleData.estimatedFare || 0,
      
      // ✅ PREFERENCES & SETTINGS
      maxWaitTime: scheduleData.maxWaitTime || 30,
      preferredVehicleType: scheduleData.preferredVehicleType || 'car',
      specialRequests: scheduleData.specialRequests || '',
      maxWalkDistance: scheduleData.maxWalkDistance || 0.5,
      
      // ✅ SCHEDULING DATA
      scheduledTime: admin.firestore.Timestamp.fromDate(new Date(scheduleData.scheduledTime)),
      status: 'scheduled', // scheduled, active, completed, cancelled
      
      // ✅ SYSTEM DATA
      activateImmediately: scheduleData.activateImmediately || TEST_MODE,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // 🎯 SAVE TO DRIVER_SCHEDULES COLLECTION USING DRIVER ID
    await db.collection(DRIVER_SCHEDULES_COLLECTION).doc(scheduleId).set(driverSchedule);
    
    console.log(`💾 Saved COMPLETE driver schedule to Firestore: ${scheduleData.driverName}`);
    console.log(`   - Schedule ID: ${scheduleId}`);
    console.log(`   - Driver ID: ${driverId}`);
    console.log(`   - Driver: ${scheduleData.driverName} (${scheduleData.driverPhone})`);
    console.log(`   - Vehicle: ${scheduleData.vehicleInfo?.model || 'Unknown'}`);
    console.log(`   - Rating: ${scheduleData.driverRating || 5.0}`);
    console.log(`   - Rides: ${scheduleData.totalRides || 0}`);
    console.log(`   - Verified: ${scheduleData.isVerified || false}`);
    console.log(`   - Scheduled: ${scheduleData.scheduledTime}`);
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
    console.log(`   - Driver: ${scheduleData.driverName}`);
    console.log(`   - Vehicle: ${scheduleData.vehicleInfo?.model || 'Unknown'}`);
    console.log(`   - Rating: ${scheduleData.driverRating}`);
    
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

// 🎯 Update driver schedule status in Firestore
const updateDriverScheduleStatus = async (scheduleId, newStatus) => {
  try {
    await db.collection(DRIVER_SCHEDULES_COLLECTION).doc(scheduleId).update({
      status: newStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`🔄 Updated driver schedule status: ${scheduleId} -> ${newStatus}`);
    return true;
  } catch (error) {
    console.error('❌ Error updating driver schedule status:', error);
    return false;
  }
};

// 🎯 Get all active driver schedules from Firestore (for matching)
const getActiveDriverSchedulesFromFirestore = async () => {
  try {
    const now = new Date();
    const snapshot = await db.collection(DRIVER_SCHEDULES_COLLECTION)
      .where('status', '==', 'active')
      .where('scheduledTime', '>=', admin.firestore.Timestamp.fromDate(now))
      .get();

    const activeSchedules = [];
    snapshot.forEach(doc => {
      const scheduleData = doc.data();
      activeSchedules.push({
        ...scheduleData,
        scheduledTime: scheduleData.scheduledTime.toDate(),
        documentId: doc.id
      });
    });

    console.log(`📊 Found ${activeSchedules.length} active driver schedules in Firestore`);
    activeSchedules.forEach(schedule => {
      console.log(`   - ${schedule.driverName} (${schedule.vehicleInfo?.model || 'Unknown'}) - Rating: ${schedule.driverRating}`);
    });
    
    return activeSchedules;
  } catch (error) {
    console.error('❌ Error getting active driver schedules:', error);
    return [];
  }
};

// 🎯 Check and activate driver schedules (runs periodically)
const checkDriverSchedulesActivation = async () => {
  try {
    console.log(`\n🕒 Checking driver schedules activation...`);
    
    const now = new Date();
    const activationTime = new Date(now.getTime() + (30 * 60 * 1000)); // 30 minutes from now
    
    const snapshot = await db.collection(DRIVER_SCHEDULES_COLLECTION)
      .where('status', '==', 'scheduled')
      .where('scheduledTime', '<=', admin.firestore.Timestamp.fromDate(activationTime))
      .get();

    let activatedCount = 0;
    
    snapshot.forEach(async (doc) => {
      const scheduleData = doc.data();
      const scheduledTime = scheduleData.scheduledTime.toDate();
      
      console.log(`   - ${scheduleData.driverName}:`);
      console.log(`     Vehicle: ${scheduleData.vehicleInfo?.model || 'Unknown'}`);
      console.log(`     Rating: ${scheduleData.driverRating}`);
      console.log(`     Scheduled: ${scheduledTime.toISOString()}`);
      console.log(`     Time until ride: ${Math.round((scheduledTime - now) / 60000)}min`);
      
      // Activate the schedule
      await doc.ref.update({
        status: 'active',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      activatedCount++;
      console.log(`     ✅ ACTIVATED: Schedule is now active for matching`);
      
      // Notify driver via WebSocket
      if (websocketServer) {
        websocketServer.sendScheduledSearchActivated(scheduleData.driverId, {
          scheduleId: scheduleData.scheduleId,
          driverName: scheduleData.driverName,
          vehicleInfo: scheduleData.vehicleInfo,
          scheduledTime: scheduledTime.toISOString(),
          message: 'Your scheduled route is now active and searching for passengers!'
        });
      }
    });

    if (activatedCount > 0) {
      console.log(`🎯 Activated ${activatedCount} driver schedules`);
    } else {
      console.log(`⏳ No driver schedules ready for activation yet`);
    }
    
    return activatedCount;
  } catch (error) {
    console.error('❌ Error checking driver schedules activation:', error);
    return 0;
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

// Check if user should stop searching
const shouldStopSearching = (userId, userType) => {
  if (UNLIMITED_CAPACITY && userType === 'driver') {
    console.log(`🎯 UNLIMITED CAPACITY: Driver ${userId} can accept unlimited passengers`);
    return false;
  }
  
  if (userType === 'passenger') {
    return true;
  }
  
  if (userType === 'driver') {
    const search = activeSearches.get(userId);
    if (search) {
      const capacity = search.capacity || 4;
      const currentMatches = userMatches.get(userId)?.size || 0;
      const shouldStop = currentMatches >= capacity;
      if (shouldStop) {
        console.log(`🚗 Driver ${search.driverName} reached capacity: ${currentMatches}/${capacity}`);
      }
      return shouldStop;
    }
  }
  
  return false;
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
      totalRides: matchData.totalRides,
      isVerified: matchData.isVerified,
      vehicleInfo: matchData.vehicleInfo,
      passengerId: matchData.passengerId,
      passengerName: matchData.passengerName,
      similarityScore: matchData.similarityScore,
      pickupName: matchData.pickupName || 'Unknown',
      destinationName: matchData.destinationName || 'Unknown',
      pickupLocation: matchData.pickupLocation,
      destinationLocation: matchData.destinationLocation,
      rideType: matchData.rideType || 'immediate',
      scheduledTime: matchData.scheduledTime,
      overlayTriggered: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection(ACTIVE_MATCHES_COLLECTION).doc(matchData.matchId).set(activeMatchData);
    console.log(`✅ Match stored in Firestore: ${matchData.driverName} ↔ ${matchData.passengerName}`);
    console.log(`   - Driver: ${matchData.driverName} (Rating: ${matchData.driverRating})`);
    console.log(`   - Vehicle: ${matchData.vehicleInfo?.model || 'Unknown'}`);
    
    return true;
    
  } catch (error) {
    console.error('❌ Error storing match in Firestore:', error);
    return false;
  }
};

const createActiveMatchForOverlay = async (matchData) => {
  try {
    if (websocketServer) {
      const result = websocketServer.sendMatchToUsers(matchData);
      
      if (result.driverSent || result.passengerSent) {
        console.log(`✅ Match sent to Flutter apps via WebSocket: ${matchData.driverName} ↔ ${matchData.passengerName}`);
        console.log(`   - Driver: ${matchData.driverName} (Rating: ${matchData.driverRating})`);
        console.log(`   - Vehicle: ${matchData.vehicleInfo?.model || 'Unknown'}`);
        
        trackUserMatch(matchData.driverId, matchData.matchId, matchData.passengerId);
        trackUserMatch(matchData.passengerId, matchData.matchId, matchData.driverId);
        
        const driverSearch = activeSearches.get(matchData.driverId);
        const passengerSearch = activeSearches.get(matchData.passengerId);
        
        if (driverSearch && shouldStopSearching(matchData.driverId, 'driver')) {
          console.log(`🚗 Stopping driver search: ${matchData.driverName} found enough passengers`);
          stopUserSearch(matchData.driverId);
        }
        
        if (passengerSearch && shouldStopSearching(matchData.passengerId, 'passenger')) {
          console.log(`👤 Stopping passenger search: ${matchData.passengerName} found a driver`);
          stopUserSearch(matchData.passengerId);
        }
        
        setTimeout(() => {
          storeMatchInFirestore(matchData).catch(console.error);
        }, 1000);
        
        return true;
      } else {
        console.log(`⚠️ Both users offline, storing in Firestore as backup`);
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

// ========== ENHANCED SEARCH STORAGE WITH FIRESTORE INTEGRATION ==========

const storeSearchInMemory = async (searchData) => {
  const { userId, userType, rideType = 'immediate', activateImmediately = TEST_MODE } = searchData;
  
  if (!userId) throw new Error('userId is required');

  const actualUserType = userType || (searchData.driverId ? 'driver' : 'passenger');
  const driverName = searchData.driverName || 'Unknown Driver';
  const passengerName = searchData.passengerName || 'Unknown Passenger';

  const enhancedSearchData = {
    userId: userId,
    userType: actualUserType,
    driverName: driverName,
    passengerName: passengerName,
    
    // ✅ COMPLETE DRIVER PROFILE DATA
    driverPhone: searchData.driverPhone,
    driverPhotoUrl: searchData.driverPhotoUrl,
    driverRating: searchData.driverRating,
    totalRides: searchData.totalRides,
    isVerified: searchData.isVerified,
    totalEarnings: searchData.totalEarnings,
    completedRides: searchData.completedRides,
    isOnline: searchData.isOnline,
    isSearching: searchData.isSearching,
    
    // ✅ VEHICLE INFORMATION
    vehicleInfo: searchData.vehicleInfo,
    
    // ✅ LOCATION DATA
    pickupLocation: searchData.pickupLocation || {},
    destinationLocation: searchData.destinationLocation || {},
    pickupName: searchData.pickupName || 'Unknown Pickup',
    destinationName: searchData.destinationName || 'Unknown Destination',
    routePoints: searchData.routePoints || [],
    
    // ✅ CAPACITY & PREFERENCES
    passengerCount: searchData.passengerCount || 1,
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
    createdAt: searchData.createdAt || new Date().toISOString(),
    activateImmediately: activateImmediately
  };

  // 🎯 SCHEDULED SEARCH: Save to DRIVER_SCHEDULES collection
  if (rideType === 'scheduled' && actualUserType === 'driver') {
    try {
      const savedSchedule = await saveDriverScheduleToFirestore({
        ...enhancedSearchData,
        driverId: userId, // Explicitly set driverId
        activateImmediately: activateImmediately
      });
      
      console.log(`📅 DRIVER SCHEDULE saved to Firestore: ${driverName}`);
      console.log(`   - Driver: ${driverName} (Rating: ${searchData.driverRating || 5.0})`);
      console.log(`   - Vehicle: ${searchData.vehicleInfo?.model || 'Unknown'}`);
      console.log(`   - Collection: ${DRIVER_SCHEDULES_COLLECTION}`);
      
      // If activating immediately, also store in memory for immediate matching
      if (activateImmediately) {
        activeSearches.set(userId, enhancedSearchData);
        console.log(`🎯 Driver schedule ACTIVATED IMMEDIATELY for matching`);
        setImmediateSearchTimeout(userId, enhancedSearchData.searchId);
      }
      
    } catch (error) {
      console.error('❌ Error saving driver schedule:', error);
      throw error;
    }
  } else {
    // IMMEDIATE SEARCH: Store in memory only
    activeSearches.set(userId, enhancedSearchData);
    
    if (rideType === 'scheduled') {
      console.log(`🎯 SCHEDULED search ACTIVATED IMMEDIATELY: ${driverName || passengerName}`);
    } else {
      console.log(`🎯 IMMEDIATE search stored: ${driverName || passengerName}`);
    }
    
    console.log(`   - Driver: ${driverName} (Rating: ${searchData.driverRating || 5.0})`);
    console.log(`   - Vehicle: ${searchData.vehicleInfo?.model || 'Unknown'}`);
    
    setImmediateSearchTimeout(userId, enhancedSearchData.searchId);
  }

  // WebSocket notifications
  const isConnected = await waitForWebSocketConnection(userId);
  if (websocketServer && isConnected) {
    const sent = websocketServer.sendSearchStarted(userId, enhancedSearchData);
    console.log(`📤 WebSocket search notification: ${sent}`);
    
    if (rideType === 'scheduled') {
      websocketServer.sendSearchStatusUpdate(userId, {
        searchId: enhancedSearchData.searchId,
        status: enhancedSearchData.status,
        rideType: 'scheduled',
        scheduledTime: searchData.scheduledTime,
        pickupName: enhancedSearchData.pickupName,
        destinationName: enhancedSearchData.destinationName,
        driverName: enhancedSearchData.driverName,
        driverRating: enhancedSearchData.driverRating,
        vehicleInfo: enhancedSearchData.vehicleInfo,
        activatedImmediately: activateImmediately,
        storage: rideType === 'scheduled' && actualUserType === 'driver' ? 'Firestore Collection' : 'Memory',
        matchingStatus: activateImmediately ? 'Starting immediately' : 'Will start 30 minutes before scheduled time',
        autoStop: 'Will stop when match found'
      });
    }
  }
  
  // Debug stats
  const currentDrivers = Array.from(activeSearches.values()).filter(s => s.userType === 'driver');
  const currentPassengers = Array.from(activeSearches.values()).filter(s => s.userType === 'passenger');
  
  console.log(`📊 Memory Stats - Active: ${activeSearches.size} (D:${currentDrivers.length} P:${currentPassengers.length})`);
  console.log(`⏰ Active Timeouts: ${searchTimeouts.size}`);
  console.log(`🎯 User Matches: ${userMatches.size} users with matches`);
  console.log(`🧪 TEST MODE: ${TEST_MODE ? 'ACTIVE' : 'INACTIVE'}`);
  console.log(`🎯 UNLIMITED CAPACITY: ${UNLIMITED_CAPACITY ? 'ACTIVE' : 'INACTIVE'}`);
  console.log(`💾 DRIVER SCHEDULES: Stored in Firestore collection: ${DRIVER_SCHEDULES_COLLECTION}`);
  
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
      totalRides,
      isVerified,
      totalEarnings,
      completedRides,
      isOnline,
      isSearching,
      pickupLocation,
      destinationLocation,
      pickupName,
      destinationName,
      routePoints,
      capacity,
      passengerCount,
      scheduledTime,
      vehicleType,
      vehicleInfo,
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

    // 🎯 Save driver schedule to dedicated Firestore collection WITH COMPLETE DATA
    const scheduleData = {
      driverId: actualDriverId,
      
      // ✅ DRIVER PROFILE
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
      
      // ✅ VEHICLE INFO
      vehicleInfo: vehicleInfo,
      vehicleType: vehicleType,
      
      // ✅ LOCATION DATA
      pickupLocation: pickupLocation,
      destinationLocation: destinationLocation,
      pickupName: pickupName,
      destinationName: destinationName,
      
      // ✅ ROUTE DATA
      routePoints: routePoints,
      capacity: capacity,
      passengerCount: passengerCount,
      distance: distance,
      duration: duration,
      fare: fare,
      estimatedFare: estimatedFare,
      
      // ✅ PREFERENCES
      maxWaitTime: maxWaitTime,
      preferredVehicleType: preferredVehicleType,
      specialRequests: specialRequests,
      maxWalkDistance: maxWalkDistance,
      
      // ✅ SCHEDULING
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
        
        // ✅ INCLUDE ALL DRIVER DATA FOR IMMEDIATE SEARCH TOO
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
      activationTime: activateImmediately ? 'IMMEDIATELY' : '30 minutes before scheduled time',
      storage: `Firestore Collection: ${DRIVER_SCHEDULES_COLLECTION}`,
      immediateSearch: activateImmediately ? 'Created' : 'Not created',
      testMode: TEST_MODE,
      unlimitedCapacity: UNLIMITED_CAPACITY,
      dataSaved: {
        driverProfile: true,
        vehicleInfo: true,
        routeData: true,
        preferences: true,
        scheduling: true
      }
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
      totalRides: schedule.totalRides,
      isVerified: schedule.isVerified,
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
      storage: 'Firestore Collection',
      testMode: TEST_MODE,
      source: schedule.source
    });
    
  } catch (error) {
    console.error('❌ Error getting driver schedule:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== SYMMETRICAL MATCH SEARCH ENDPOINT (UPDATED WITH ROUTEMATCHING) ==========

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
      
      // ✅ COMPLETE DRIVER DATA (if driver)
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
      
      // ✅ VEHICLE DATA (if driver)
      vehicleInfo: vehicleInfo,
      
      // ✅ PASSENGER DATA (if passenger)
      passengerName: passengerName,
      
      // ✅ LOCATION DATA (both driver and passenger)
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

    // 🎯 SYMMETRICAL: Use routeMatching.js for BOTH drivers AND passengers
    await routeMatching.saveActiveSearch(db, searchData);
    
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
      timeout: '5 minutes (or until match found)',
      matches: [],
      matchCount: 0,
      storage: 'Memory + Firestore (via routeMatching.js)',
      websocketConnected: websocketServer ? websocketServer.isUserConnected(actualUserId) : false,
      testMode: TEST_MODE,
      unlimitedCapacity: UNLIMITED_CAPACITY,
      dataIncluded: {
        driverProfile: userType === 'driver',
        passengerProfile: userType === 'passenger',
        vehicleInfo: userType === 'driver',
        routeData: true,
        preferences: true
      },
      autoStop: UNLIMITED_CAPACITY ? 
        'Drivers: NEVER (unlimited mode) | Passengers: After first match' : 
        'Search will stop automatically when match is found'
    });
    
  } catch (error) {
    console.error('❌ Error in symmetrical match search:', error);
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
    
    console.log(`📍 === REAL-TIME LOCATION UPDATE WITH MATCHING ===`);
    console.log(`   Driver: ${actualDriverId}`);
    console.log(`   Location: ${location.latitude}, ${location.longitude}`);
    
    // 🎯 Call routeMatching function to process location and trigger matching
    const matchResult = await routeMatching.processLocationUpdateAndMatch(
      db, 
      actualDriverId, 
      location,
      websocketServer
    );
    
    res.json({
      success: true,
      message: 'Location updated and matching triggered',
      driverId: actualDriverId,
      location: location,
      address: address,
      timestamp: new Date().toISOString(),
      matchFound: matchResult !== null,
      matchId: matchResult?.matchId || null,
      similarityScore: matchResult?.similarityScore || null
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
    
    console.log(`📍 === PASSENGER REAL-TIME LOCATION UPDATE ===`);
    console.log(`   Passenger: ${actualUserId}`);
    console.log(`   Location: ${location.latitude}, ${location.longitude}`);
    
    // 🎯 SYMMETRICAL: Use the SAME function as drivers
    const matchResult = await routeMatching.processUserLocationUpdateAndMatch(
      db, 
      actualUserId, 
      'passenger', // Specify user type
      location,
      websocketServer
    );
    
    res.json({
      success: true,
      message: 'Passenger location updated and matching triggered',
      passengerId: actualUserId,
      location: location,
      address: address,
      timestamp: new Date().toISOString(),
      matchFound: matchResult !== null,
      matchId: matchResult?.matchId || null,
      similarityScore: matchResult?.similarityScore || null
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
    const { userId, tripStatus, location } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId is required' 
      });
    }
    
    if (!tripStatus) {
      return res.status(400).json({ 
        success: false, 
        error: 'tripStatus is required' 
      });
    }
    
    console.log(`🔄 === TRIP STATUS UPDATE ===`);
    console.log(`   User: ${userId}`);
    console.log(`   New Status: ${tripStatus}`);
    if (location) {
      console.log(`   Location: ${location.latitude}, ${location.longitude}`);
    }
    
    // Update user's own active_searches
    const userDoc = await db.collection(ACTIVE_SEARCHES_COLLECTION).doc(userId).get();
    
    if (!userDoc.exists) {
      console.log(`❌ User not found in active_searches: ${userId}`);
      return res.status(404).json({ 
        success: false, 
        error: 'User not found in active searches' 
      });
    }
    
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
    
    await db.collection(ACTIVE_SEARCHES_COLLECTION).doc(userId).update(updates);
    console.log(`✅ Updated trip status for user ${userId}: ${tripStatus}`);
    
    // If driver, also update passenger's document with driver status
    const userData = userDoc.data();
    if (userData.userType === 'driver' && userData.matchedWith) {
      console.log(`📤 Updating passenger ${userData.matchedWith} with driver status`);
      
      const passengerUpdates = {
        [`driver.tripStatus`]: tripStatus,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      };
      
      if (location) {
        passengerUpdates[`driver.currentLocation`] = {
          latitude: location.latitude,
          longitude: location.longitude,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        };
      }
      
      await db.collection(ACTIVE_SEARCHES_COLLECTION).doc(userData.matchedWith).update(passengerUpdates);
      console.log(`✅ Updated passenger with driver trip status: ${tripStatus}`);
      
      // Notify passenger via WebSocket
      if (websocketServer) {
        websocketServer.sendTripStatusUpdate(userData.matchedWith, {
          driverId: userId,
          driverName: userData.driverName,
          tripStatus: tripStatus,
          location: location,
          timestamp: new Date().toISOString()
        });
      }
    }
    
    // If passenger, also update driver's document with passenger status
    if (userData.userType === 'passenger' && userData.matchedWith) {
      console.log(`📤 Updating driver ${userData.matchedWith} with passenger status`);
      
      const driverUpdates = {
        [`passenger.tripStatus`]: tripStatus,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      };
      
      if (location) {
        driverUpdates[`passenger.currentLocation`] = {
          latitude: location.latitude,
          longitude: location.longitude,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        };
      }
      
      await db.collection(ACTIVE_SEARCHES_COLLECTION).doc(userData.matchedWith).update(driverUpdates);
      console.log(`✅ Updated driver with passenger trip status: ${tripStatus}`);
      
      // Notify driver via WebSocket
      if (websocketServer) {
        websocketServer.sendTripStatusUpdate(userData.matchedWith, {
          passengerId: userId,
          passengerName: userData.passengerName,
          tripStatus: tripStatus,
          location: location,
          timestamp: new Date().toISOString()
        });
      }
    }
    
    res.json({ 
      success: true, 
      tripStatus: tripStatus,
      userId: userId,
      userType: userData.userType,
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

// ========== OPTIMIZED MATCHING SERVICE WITH FIRESTORE INTEGRATION ==========

const startOptimizedMatching = () => {
  console.log('🔄 Starting Optimized Matching Service...');
  console.log(`🧪 TEST MODE: ${TEST_MODE ? 'ACTIVE' : 'INACTIVE'}`);
  console.log(`🎯 UNLIMITED CAPACITY: ${UNLIMITED_CAPACITY ? 'ACTIVE' : 'INACTIVE'}`);
  console.log(`💾 STORAGE: All searches → Firestore via routeMatching.js`);
  
  const matchingInterval = TEST_MODE ? TEST_MATCHING_INTERVAL : 30000;
  
  setInterval(async () => {
    try {
      console.log(`\n📊 ===== SYMMETRICAL MATCHING CYCLE START =====`);
      console.log(`🧪 TEST MODE: ${TEST_MODE ? 'ACTIVE' : 'INACTIVE'}`);
      
      // 🎯 Check and activate driver schedules from Firestore
      await checkDriverSchedulesActivation();

      // 🎯 SYMMETRICAL: Get BOTH drivers AND passengers from Firestore
      const allDrivers = await routeMatching.getActiveSearchesByType(db, 'driver');
      const allPassengers = await routeMatching.getActiveSearchesByType(db, 'passenger');
      
      console.log(`📊 Matching: ${allDrivers.length} drivers vs ${allPassengers.length} passengers (both from Firestore)`);
      
      if (allDrivers.length === 0 || allPassengers.length === 0) {
        console.log(`💤 No matches possible`);
        console.log(`📊 ===== SYMMETRICAL MATCHING CYCLE END =====\n`);
        return;
      }

      // Log search details
      console.log('🚗 Active Drivers:');
      allDrivers.forEach(driver => {
        const matchCount = userMatches.get(driver.userId || driver.driverId)?.size || 0;
        console.log(`   - ${driver.driverName}`);
        console.log(`     Vehicle: ${driver.vehicleInfo?.model || 'Unknown'}`);
        console.log(`     Rating: ${driver.driverRating} | Matches: ${matchCount}/${UNLIMITED_CAPACITY ? '∞' : driver.capacity || 4}`);
      });

      console.log('👤 Active Passengers:');
      allPassengers.forEach(passenger => {
        const matchCount = userMatches.get(passenger.userId)?.size || 0;
        console.log(`   - ${passenger.passengerName} - Matches: ${matchCount}/1`);
      });
      
      let matchesCreated = 0;
      
      // 🎯 SYMMETRICAL: Perform matching in BOTH directions
      // Driver → Passenger matching
      for (const driver of allDrivers) {
        const driverUserId = driver.userId || driver.driverId;
        
        if (!UNLIMITED_CAPACITY) {
          const driverMatchCount = userMatches.get(driverUserId)?.size || 0;
          if (driverMatchCount >= (driver.capacity || 4)) {
            console.log(`⏭️ Skipping driver ${driver.driverName} - reached capacity`);
            continue;
          }
        }
        
        for (const passenger of allPassengers) {
          const passengerMatchCount = userMatches.get(passenger.userId)?.size || 0;
          if (passengerMatchCount >= 1) {
            console.log(`⏭️ Skipping passenger ${passenger.passengerName} - already has match`);
            continue;
          }

          if (!driver.routePoints || driver.routePoints.length === 0) continue;
          if (!passenger.routePoints || passenger.routePoints.length === 0) continue;

          if (!UNLIMITED_CAPACITY) {
            const passengerCount = passenger.passengerCount || 1;
            const hasSeats = routeMatching.hasCapacity(driver, passengerCount);
            if (!hasSeats) continue;
          }

          // Use routeMatching.js intelligent matching
          const match = await routeMatching.performIntelligentMatching(
            db, 
            driver, 
            passenger
          );
          
          if (match) {
            const matchKey = generateMatchKey(driverUserId, passenger.userId, Date.now());
            
            if (!processedMatches.has(matchKey)) {
              const matchData = {
                matchId: match.matchId,
                driverId: driverUserId,
                driverName: driver.driverName || 'Unknown Driver',
                driverPhone: driver.driverPhone,
                driverPhotoUrl: driver.driverPhotoUrl,
                driverRating: driver.driverRating,
                totalRides: driver.totalRides,
                isVerified: driver.isVerified,
                vehicleInfo: driver.vehicleInfo,
                passengerId: passenger.userId,
                passengerName: passenger.passengerName || 'Unknown Passenger',
                similarityScore: match.similarityScore,
                pickupName: passenger.pickupName || driver.pickupName || 'Unknown Location',
                destinationName: passenger.destinationName || driver.destinationName || 'Unknown Destination',
                pickupLocation: passenger.pickupLocation || driver.pickupLocation,
                destinationLocation: passenger.destinationLocation || driver.destinationLocation,
                passengerCount: passenger.passengerCount || 1,
                capacity: driver.capacity || 4,
                vehicleType: driver.vehicleType || 'car',
                rideType: driver.rideType || passenger.rideType || 'immediate',
                scheduledTime: driver.scheduledTime || passenger.scheduledTime,
                timestamp: new Date().toISOString(),
                matchType: 'firestore_match',
                unlimitedMode: UNLIMITED_CAPACITY,
                source: 'Firestore'
              };

              const matchCreated = await createActiveMatchForOverlay(matchData);
              
              if (matchCreated) {
                matchesCreated++;
                processedMatches.set(matchKey, Date.now());
                console.log(`🎉 MATCH CREATED: ${driver.driverName} ↔ ${passenger.passengerName}`);
                console.log(`   - Driver Rating: ${driver.driverRating}`);
                console.log(`   - Vehicle: ${driver.vehicleInfo?.model || 'Unknown'}`);
                console.log(`   - Similarity Score: ${match.similarityScore}`);
              }
            }
          }
        }
      }
      
      // 🎯 BONUS: Also try Passenger → Driver (bidirectional initiation)
      console.log(`🔄 Checking Passenger → Driver matching...`);
      for (const passenger of allPassengers) {
        const passengerMatchCount = userMatches.get(passenger.userId)?.size || 0;
        if (passengerMatchCount >= 1) {
          continue; // Skip if already matched
        }
        
        for (const driver of allDrivers) {
          const driverUserId = driver.userId || driver.driverId;
          
          if (!UNLIMITED_CAPACITY) {
            const driverMatchCount = userMatches.get(driverUserId)?.size || 0;
            if (driverMatchCount >= (driver.capacity || 4)) {
              continue;
            }
          }

          if (!driver.routePoints || driver.routePoints.length === 0) continue;
          if (!passenger.routePoints || passenger.routePoints.length === 0) continue;

          // Use routeMatching.js intelligent matching (same function)
          const match = await routeMatching.performIntelligentMatching(
            db, 
            driver, 
            passenger
          );
          
          if (match) {
            const matchKey = generateMatchKey(driverUserId, passenger.userId, Date.now());
            
            if (!processedMatches.has(matchKey)) {
              const matchData = {
                matchId: match.matchId,
                driverId: driverUserId,
                driverName: driver.driverName || 'Unknown Driver',
                driverPhone: driver.driverPhone,
                driverPhotoUrl: driver.driverPhotoUrl,
                driverRating: driver.driverRating,
                totalRides: driver.totalRides,
                isVerified: driver.isVerified,
                vehicleInfo: driver.vehicleInfo,
                passengerId: passenger.userId,
                passengerName: passenger.passengerName || 'Unknown Passenger',
                similarityScore: match.similarityScore,
                pickupName: passenger.pickupName || driver.pickupName || 'Unknown Location',
                destinationName: passenger.destinationName || driver.destinationName || 'Unknown Destination',
                pickupLocation: passenger.pickupLocation || driver.pickupLocation,
                destinationLocation: passenger.destinationLocation || driver.destinationLocation,
                passengerCount: passenger.passengerCount || 1,
                capacity: driver.capacity || 4,
                vehicleType: driver.vehicleType || 'car',
                rideType: driver.rideType || passenger.rideType || 'immediate',
                scheduledTime: driver.scheduledTime || passenger.scheduledTime,
                timestamp: new Date().toISOString(),
                matchType: 'bidirectional_firestore_match',
                unlimitedMode: UNLIMITED_CAPACITY,
                source: 'Firestore'
              };

              const matchCreated = await createActiveMatchForOverlay(matchData);
              
              if (matchCreated) {
                matchesCreated++;
                processedMatches.set(matchKey, Date.now());
                console.log(`🎉 BIDIRECTIONAL MATCH CREATED: ${driver.driverName} ↔ ${passenger.passengerName}`);
                console.log(`   - Initiated by: Passenger`);
                console.log(`   - Similarity Score: ${match.similarityScore}`);
              }
            }
          }
        }
      }

      if (matchesCreated > 0) {
        console.log(`📱 Created ${matchesCreated} matches (including bidirectional)`);
      }
      
      console.log(`📊 ===== SYMMETRICAL MATCHING CYCLE END =====\n`);
      
    } catch (error) {
      console.error('❌ Matching error:', error);
    }
  }, matchingInterval);

  // Check driver schedules every 10 seconds
  setInterval(checkDriverSchedulesActivation, SCHEDULED_SEARCH_CHECK_INTERVAL);
  
  // 🎯 Add cleanup for expired searches
  setInterval(async () => {
    await routeMatching.cleanupExpiredSearches(db);
  }, 5 * 60 * 1000); // Every 5 minutes
};

// ========== STOP SEARCH ENDPOINT ==========

app.post("/api/match/stop-search", async (req, res) => {
  try {
    const { userId, userType, rideType = 'immediate', driverId, passengerId } = req.body;
    const actualUserId = userId || driverId || passengerId;
    
    if (!actualUserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId, driverId, or passengerId is required' 
      });
    }

    console.log(`🛑 Stopping search for user: ${actualUserId}, rideType: ${rideType}`);
    
    let stoppedFromMemory = false;
    let stoppedFromFirestore = false;
    
    // Stop from memory (immediate searches)
    if (activeSearches.has(actualUserId)) {
      const search = activeSearches.get(actualUserId);
      clearSearchTimeout(actualUserId);
      activeSearches.delete(actualUserId);
      stoppedFromMemory = true;
      console.log(`✅ Stopped memory search: ${search.driverName || search.passengerName}`);
    }
    
    // Stop from Firestore (driver schedules)
    if (rideType === 'scheduled') {
      const schedule = await getDriverScheduleFromFirestore(actualUserId);
      if (schedule) {
        await updateDriverScheduleStatus(schedule.scheduleId, 'cancelled');
        stoppedFromFirestore = true;
        console.log(`✅ Cancelled driver schedule in Firestore: ${schedule.scheduleId}`);
      }
    }
    
    // Stop from routeMatching.js Firestore searches
    try {
      await routeMatching.stopSearch(db, actualUserId);
      console.log(`✅ Stopped search in routeMatching.js`);
    } catch (error) {
      console.log(`ℹ️ No active search in routeMatching.js: ${error.message}`);
    }
    
    // Notify via WebSocket
    if (websocketServer) {
      websocketServer.sendSearchStopped(actualUserId, {
        rideType: rideType,
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
      rideType: rideType,
      stoppedFromMemory: stoppedFromMemory,
      stoppedFromFirestore: stoppedFromFirestore,
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

// ========== SEARCH STATUS ENDPOINT ==========

app.get("/api/match/search-status/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    
    console.log(`🔍 Getting search status for user: ${userId}`);
    
    const memorySearch = activeSearches.get(userId);
    const driverSchedule = await getDriverScheduleFromFirestore(userId);
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
        status: driverSchedule.status,
        activateImmediately: driverSchedule.activateImmediately
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
        scheduledTime: data.scheduledTime.toDate().toISOString(),
        vehicleInfo: data.vehicleInfo,
        driverRating: data.driverRating
      });
    });
    
    // Get routeMatching.js stats
    const routeMatchingStats = {
      activeDrivers: 'Check routeMatching.js',
      activePassengers: 'Check routeMatching.js',
      totalSearches: 'Check routeMatching.js'
    };
    
    const debugInfo = {
      server: {
        timestamp: new Date().toISOString(),
        testMode: TEST_MODE,
        unlimitedCapacity: UNLIMITED_CAPACITY,
        websocketConnections: websocketServer ? websocketServer.getConnectedCount() : 0,
        symmetricalMatching: true
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
        collection: DRIVER_SCHEDULES_COLLECTION
      },
      routeMatching: routeMatchingStats,
      memoryDrivers: memoryDrivers.map(d => ({
        driverName: d.driverName,
        vehicleInfo: d.vehicleInfo,
        rating: d.driverRating,
        rideType: d.rideType,
        matches: userMatches.get(d.userId)?.size || 0
      })),
      memoryPassengers: memoryPassengers.map(p => ({
        passengerName: p.passengerName,
        matches: userMatches.get(p.userId)?.size || 0
      })),
      driverSchedules: driverSchedules
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
    version: "3.0.0",
    features: {
      symmetricalMatching: true,
      driverSchedules: true,
      firestoreStorage: true,
      websocketNotifications: true,
      testMode: TEST_MODE,
      unlimitedCapacity: UNLIMITED_CAPACITY,
      routeMatchingIntegration: true,
      realTimeLocationUpdates: true,
      symmetricalEndpoints: true,
      tripStatusUpdates: true
    },
    endpoints: {
      symmetrical: {
        search: "POST /api/match/search (works for both drivers & passengers)",
        updateLocation: {
          driver: "POST /api/driver/update-location",
          passenger: "POST /api/passenger/update-location"
        }
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
💾 Storage: All searches → Firestore via routeMatching.js
🔌 WebSocket: Real-time notifications

🎯 SYMMETRICAL ARCHITECTURE:
   - One search endpoint for BOTH drivers AND passengers
   - Separate but symmetrical location update endpoints
   - All data stored in Firestore via routeMatching.js
   - Bidirectional matching (Driver→Passenger & Passenger→Driver)
   - Real-time trip status updates for progression

🧪 TEST MODE: ${TEST_MODE ? 'ACTIVE' : 'INACTIVE'}
🎯 UNLIMITED CAPACITY: ${UNLIMITED_CAPACITY ? 'ACTIVE 🚀' : 'INACTIVE'}

📊 Current Stats:
- Active Searches in Memory: ${activeSearches.size}
- Processed Matches: ${processedMatches.size} (in memory)
- Active Timeouts: ${searchTimeouts.size} (in memory)
- Users with Matches: ${userMatches.size} (in memory)
- WebSocket Connections: ${websocketServer ? websocketServer.getConnectedCount() : 0}

💾 FIRESTORE COLLECTIONS:
- ${DRIVER_SCHEDULES_COLLECTION}: Driver schedules with complete data
- ${ACTIVE_SEARCHES_COLLECTION}: All active searches (via routeMatching.js)
- ${ACTIVE_MATCHES_COLLECTION}: Active matches with profiles
- ${NOTIFICATIONS_COLLECTION}: User notifications

✅ FULLY SYMMETRICAL SYSTEM 🎉
   - Single search endpoint: /api/match/search
   - Symmetrical location updates: /api/driver/update-location & /api/passenger/update-location
   - Trip status updates: /api/trip/update-status
   - Both use routeMatching.js functions
   - Bidirectional matching algorithm

📱 SYMMETRICAL ENDPOINTS:
- POST /api/match/search - Start search (works for both drivers & passengers)
- POST /api/driver/update-location - Update driver location (triggers matching)
- POST /api/passenger/update-location - Update passenger location (triggers matching)
- POST /api/trip/update-status - Update trip progression status
- POST /api/match/driver-schedule - Create driver schedule (driver-specific)
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
