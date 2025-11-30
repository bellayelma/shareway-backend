// src/app.js - COMPLETE UPDATED SCRIPT SAVING BY DRIVER ID
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
const DRIVER_SCHEDULES_COLLECTION = 'driver_schedules'; // Changed to driver_schedules
const ACTIVE_MATCHES_COLLECTION = 'active_matches';
const NOTIFICATIONS_COLLECTION = 'notifications';

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

// ========== SIMPLIFIED DRIVER SCHEDULES MANAGEMENT ==========

// 🎯 SIMPLIFIED: Save driver schedule to Firestore based on driver ID
const saveDriverScheduleToFirestore = async (scheduleData) => {
  try {
    const scheduleId = scheduleData.scheduleId || `schedule_${scheduleData.driverId}_${Date.now()}`;
    
    // ✅ SIMPLIFIED DATA STRUCTURE - ONLY ESSENTIAL FIELDS
    const driverSchedule = {
      // ✅ BASIC IDENTIFICATION
      id: scheduleId,
      driverId: scheduleData.driverId, // Primary key for queries
      driverName: scheduleData.driverName || 'Unknown Driver',
      
      // ✅ LOCATION DATA (ONLY WHAT YOU NEED)
      pickupName: scheduleData.pickupName || 'Unknown Pickup',
      destinationName: scheduleData.destinationName || 'Unknown Destination',
      
      // ✅ SCHEDULING & PRICING
      scheduledTime: admin.firestore.Timestamp.fromDate(new Date(scheduleData.scheduledTime)),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      estimatedFare: scheduleData.estimatedFare || scheduleData.fare || 0,
      capacity: scheduleData.capacity || 4,
      
      // ✅ SYSTEM FIELDS
      status: 'scheduled', // scheduled, active, completed, cancelled
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      activateImmediately: scheduleData.activateImmediately || TEST_MODE
    };

    await db.collection(DRIVER_SCHEDULES_COLLECTION).doc(scheduleId).set(driverSchedule);
    
    console.log(`💾 Saved driver schedule to Firestore: ${scheduleData.driverName}`);
    console.log(`   - Schedule ID: ${scheduleId}`);
    console.log(`   - Driver ID: ${scheduleData.driverId}`);
    console.log(`   - Route: ${scheduleData.pickupName} → ${scheduleData.destinationName}`);
    console.log(`   - Scheduled: ${scheduleData.scheduledTime}`);
    console.log(`   - Fare: ETB ${driverSchedule.estimatedFare}`);
    console.log(`   - Capacity: ${driverSchedule.capacity} seats`);
    console.log(`   - Collection: ${DRIVER_SCHEDULES_COLLECTION}`);
    
    return driverSchedule;
  } catch (error) {
    console.error('❌ Error saving driver schedule to Firestore:', error);
    throw error;
  }
};

// 🎯 SIMPLIFIED: Get driver schedules by driver ID
const getDriverSchedulesFromFirestore = async (driverId) => {
  try {
    console.log(`🔍 Reading schedules from Firestore for driver: ${driverId}`);
    
    const snapshot = await db.collection(DRIVER_SCHEDULES_COLLECTION)
      .where('driverId', '==', driverId)
      .where('status', 'in', ['scheduled', 'active'])
      .orderBy('scheduledTime', 'desc')
      .get();

    if (snapshot.empty) {
      console.log(`📭 No schedules found in Firestore for driver: ${driverId}`);
      return [];
    }

    const schedules = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        ...data,
        scheduledTime: data.scheduledTime.toDate(),
        createdAt: data.createdAt.toDate(),
        documentId: doc.id
      };
    });

    console.log(`✅ Found ${schedules.length} schedules for driver: ${driverId}`);
    
    return schedules;
  } catch (error) {
    console.error('❌ Error reading driver schedules from Firestore:', error);
    return [];
  }
};

// 🎯 Get single schedule by driver ID (latest one)
const getDriverScheduleFromFirestore = async (driverId) => {
  try {
    console.log(`🔍 Reading latest schedule for driver: ${driverId}`);
    
    const snapshot = await db.collection(DRIVER_SCHEDULES_COLLECTION)
      .where('driverId', '==', driverId)
      .where('status', 'in', ['scheduled', 'active'])
      .orderBy('scheduledTime', 'desc')
      .limit(1)
      .get();

    if (snapshot.empty) {
      console.log(`📭 No schedule found for driver: ${driverId}`);
      return null;
    }

    const scheduleData = snapshot.docs[0].data();
    console.log(`✅ Found schedule for driver: ${driverId}`);
    
    return {
      ...scheduleData,
      scheduledTime: scheduleData.scheduledTime.toDate(),
      createdAt: scheduleData.createdAt.toDate(),
      source: 'firestore'
    };
  } catch (error) {
    console.error('❌ Error reading driver schedule from Firestore:', error);
    return null;
  }
};

// 🎯 Update driver schedule status
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
      console.log(`     Route: ${scheduleData.pickupName} → ${scheduleData.destinationName}`);
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
          scheduleId: scheduleData.id,
          driverName: scheduleData.driverName,
          scheduledTime: scheduledTime.toISOString(),
          pickupName: scheduleData.pickupName,
          destinationName: scheduleData.destinationName,
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
      passengerId: matchData.passengerId,
      passengerName: matchData.passengerName,
      similarityScore: matchData.similarityScore,
      pickupName: matchData.pickupName || 'Unknown',
      destinationName: matchData.destinationName || 'Unknown',
      rideType: matchData.rideType || 'immediate',
      scheduledTime: matchData.scheduledTime,
      overlayTriggered: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection(ACTIVE_MATCHES_COLLECTION).doc(matchData.matchId).set(activeMatchData);
    console.log(`✅ Match stored in Firestore: ${matchData.driverName} ↔ ${matchData.passengerName}`);
    
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
    
    // ✅ SIMPLIFIED LOCATION DATA
    pickupLocation: searchData.pickupLocation || {},
    destinationLocation: searchData.destinationLocation || {},
    pickupName: searchData.pickupName || 'Unknown Pickup',
    destinationName: searchData.destinationName || 'Unknown Destination',
    routePoints: searchData.routePoints || [],
    
    // ✅ CAPACITY & PRICING
    passengerCount: searchData.passengerCount || 1,
    capacity: searchData.capacity || 4,
    vehicleType: searchData.vehicleType || 'car',
    
    // ✅ ROUTE INFORMATION
    distance: searchData.distance,
    duration: searchData.duration,
    fare: searchData.fare,
    estimatedFare: searchData.estimatedFare,
    
    // ✅ SEARCH METADATA
    rideType: rideType,
    scheduledTime: searchData.scheduledTime,
    searchId: searchData.searchId || `${rideType}_${userId}_${Date.now()}`,
    status: 'searching',
    lastUpdated: Date.now(),
    createdAt: searchData.createdAt || new Date().toISOString(),
    activateImmediately: activateImmediately
  };

  // 🎯 DRIVER SCHEDULE: Save to Firestore collection
  if (rideType === 'scheduled' && actualUserType === 'driver') {
    try {
      const savedSchedule = await saveDriverScheduleToFirestore({
        driverId: userId, // Use driverId as primary key
        driverName: driverName,
        pickupName: searchData.pickupName,
        destinationName: searchData.destinationName,
        scheduledTime: searchData.scheduledTime,
        estimatedFare: searchData.estimatedFare,
        capacity: searchData.capacity,
        activateImmediately: activateImmediately
      });
      
      console.log(`📅 DRIVER SCHEDULE saved to Firestore: ${driverName}`);
      console.log(`   - Driver ID: ${userId}`);
      console.log(`   - Route: ${searchData.pickupName} → ${searchData.destinationName}`);
      
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
    
    setImmediateSearchTimeout(userId, enhancedSearchData.searchId);
  }

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
      driverId,
      driverName,
      pickupName,
      destinationName,
      scheduledTime,
      estimatedFare,
      capacity,
      activateImmediately = TEST_MODE
    } = req.body;
    
    if (!driverId) {
      return res.status(400).json({ 
        success: false, 
        error: 'driverId is required' 
      });
    }

    if (!scheduledTime) {
      return res.status(400).json({ 
        success: false, 
        error: 'scheduledTime is required for schedules' 
      });
    }

    // 🎯 Save driver schedule to Firestore collection
    const scheduleData = {
      driverId: driverId,
      driverName: driverName,
      pickupName: pickupName,
      destinationName: destinationName,
      scheduledTime: scheduledTime,
      estimatedFare: estimatedFare,
      capacity: capacity,
      activateImmediately: activateImmediately
    };

    const savedSchedule = await saveDriverScheduleToFirestore(scheduleData);

    let immediateSearchData = null;
    
    // If activating immediately, also create immediate search
    if (activateImmediately) {
      immediateSearchData = {
        userId: driverId,
        userType: 'driver',
        driverName: driverName,
        pickupName: pickupName,
        destinationName: destinationName,
        scheduledTime: scheduledTime,
        estimatedFare: estimatedFare,
        capacity: capacity,
        rideType: 'scheduled',
        activateImmediately: true
      };

      await storeSearchInMemory(immediateSearchData);
    }

    res.json({
      success: true,
      message: activateImmediately ? 
        'Driver schedule created and ACTIVATED IMMEDIATELY!' : 
        'Driver schedule created successfully',
      scheduleId: savedSchedule.id,
      driverId: driverId,
      driverName: driverName,
      pickupName: pickupName,
      destinationName: destinationName,
      scheduledTime: scheduledTime,
      estimatedFare: savedSchedule.estimatedFare,
      capacity: savedSchedule.capacity,
      status: activateImmediately ? 'active' : 'scheduled',
      activationTime: activateImmediately ? 'IMMEDIATELY' : '30 minutes before scheduled time',
      storage: 'Firestore Collection: driver_schedules',
      immediateSearch: activateImmediately ? 'Created' : 'Not created',
      testMode: TEST_MODE,
      unlimitedCapacity: UNLIMITED_CAPACITY
    });
    
  } catch (error) {
    console.error('❌ Error creating driver schedule:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== GET DRIVER SCHEDULES ENDPOINT ==========

app.get("/api/match/driver-schedules/:driverId", async (req, res) => {
  try {
    const { driverId } = req.params;
    
    console.log(`🔍 Getting schedules for driver: ${driverId}`);
    
    const schedules = await getDriverSchedulesFromFirestore(driverId);
    
    res.json({
      success: true,
      driverId: driverId,
      schedules: schedules.map(schedule => ({
        id: schedule.id,
        driverId: schedule.driverId,
        driverName: schedule.driverName,
        pickupName: schedule.pickupName,
        destinationName: schedule.destinationName,
        scheduledTime: schedule.scheduledTime.toISOString(),
        createdAt: schedule.createdAt.toISOString(),
        estimatedFare: schedule.estimatedFare,
        capacity: schedule.capacity,
        status: schedule.status,
        activateImmediately: schedule.activateImmediately
      })),
      count: schedules.length,
      storage: 'Firestore Collection: driver_schedules'
    });
    
  } catch (error) {
    console.error('❌ Error getting driver schedules:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========== GET DRIVER SCHEDULE ENDPOINT ==========

app.get("/api/match/driver-schedule/:driverId", async (req, res) => {
  try {
    const { driverId } = req.params;
    
    console.log(`🔍 Getting latest schedule for driver: ${driverId}`);
    
    const schedule = await getDriverScheduleFromFirestore(driverId);
    
    if (!schedule) {
      return res.json({
        success: true,
        exists: false,
        message: 'No schedule found',
        driverId: driverId
      });
    }

    const now = new Date();
    const timeUntilRide = schedule.scheduledTime.getTime() - now.getTime();
    
    res.json({
      success: true,
      exists: true,
      id: schedule.id,
      driverId: schedule.driverId,
      driverName: schedule.driverName,
      pickupName: schedule.pickupName,
      destinationName: schedule.destinationName,
      scheduledTime: schedule.scheduledTime.toISOString(),
      createdAt: schedule.createdAt.toISOString(),
      estimatedFare: schedule.estimatedFare,
      capacity: schedule.capacity,
      status: schedule.status,
      timeUntilRide: Math.round(timeUntilRide / 60000),
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

// ========== IMMEDIATE MATCH SEARCH ENDPOINT ==========

app.post("/api/match/search", async (req, res) => {
  try {
    console.log('🎯 === IMMEDIATE MATCH SEARCH ENDPOINT CALLED ===');
    
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
      passengerCount,
      distance,
      duration,
      fare,
      estimatedFare,
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

    // Clear any existing search
    if (activeSearches.has(actualUserId)) {
      console.log(`🔄 Clearing existing search for user: ${actualUserId}`);
      clearSearchTimeout(actualUserId);
      activeSearches.delete(actualUserId);
    }

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
      passengerCount: passengerCount,
      distance: distance,
      duration: duration,
      fare: fare,
      estimatedFare: estimatedFare,
      rideType: rideType,
      scheduledTime: scheduledTime,
      searchId: searchId || `search_${actualUserId}_${Date.now()}`
    };

    await storeSearchInMemory(searchData);

    res.json({
      success: true,
      message: 'Immediate search started successfully',
      searchId: searchData.searchId,
      userId: actualUserId,
      driverName: driverName,
      rideType: rideType,
      timeout: '5 minutes (or until match found)',
      matches: [],
      matchCount: 0,
      storage: 'Memory only',
      websocketConnected: websocketServer ? websocketServer.isUserConnected(actualUserId) : false,
      testMode: TEST_MODE,
      unlimitedCapacity: UNLIMITED_CAPACITY,
      autoStop: UNLIMITED_CAPACITY ? 
        'Drivers: NEVER (unlimited mode) | Passengers: After first match' : 
        'Search will stop automatically when match is found'
    });
    
  } catch (error) {
    console.error('❌ Error in immediate match search:', error);
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
  console.log(`💾 STORAGE: Immediate searches → Memory | Driver schedules → Firestore collection`);
  
  const matchingInterval = TEST_MODE ? TEST_MATCHING_INTERVAL : 30000;
  
  setInterval(async () => {
    try {
      console.log(`\n📊 ===== MATCHING CYCLE START =====`);
      console.log(`🧪 TEST MODE: ${TEST_MODE ? 'ACTIVE' : 'INACTIVE'}`);
      
      // 🎯 Check and activate driver schedules from Firestore
      await checkDriverSchedulesActivation();

      // Get drivers from both memory and active driver schedules
      const memoryDrivers = Array.from(activeSearches.values())
        .filter(search => search.userType === 'driver' && search.status === 'searching');
      
      const scheduledDrivers = await getActiveDriverSchedulesFromFirestore();
      
      const allDrivers = [...memoryDrivers, ...scheduledDrivers];
      const passengers = Array.from(activeSearches.values())
        .filter(search => search.userType === 'passenger' && search.status === 'searching');

      console.log(`📊 Matching: ${allDrivers.length} drivers (Memory: ${memoryDrivers.length}, Scheduled: ${scheduledDrivers.length}) vs ${passengers.length} passengers`);
      
      if (allDrivers.length === 0 || passengers.length === 0) {
        console.log(`💤 No matches possible`);
        console.log(`📊 ===== MATCHING CYCLE END =====\n`);
        return;
      }

      // Log search details
      console.log('🚗 Active Drivers:');
      allDrivers.forEach(driver => {
        const matchCount = userMatches.get(driver.userId || driver.driverId)?.size || 0;
        const source = driver.documentId ? 'Firestore' : 'Memory';
        console.log(`   - ${driver.driverName} (${source}) - Matches: ${matchCount}/${UNLIMITED_CAPACITY ? '∞' : driver.capacity || 4}`);
      });

      console.log('👤 Active Passengers:');
      passengers.forEach(passenger => {
        const matchCount = userMatches.get(passenger.userId)?.size || 0;
        console.log(`   - ${passenger.passengerName} - Matches: ${matchCount}/1`);
      });
      
      let matchesCreated = 0;
      
      // Perform matching
      for (const driver of allDrivers) {
        if (!UNLIMITED_CAPACITY) {
          const driverId = driver.userId || driver.driverId;
          const driverMatchCount = userMatches.get(driverId)?.size || 0;
          if (driverMatchCount >= (driver.capacity || 4)) {
            console.log(`⏭️ Skipping driver ${driver.driverName} - reached capacity`);
            continue;
          }
        }
        
        for (const passenger of passengers) {
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

          const similarity = routeMatching.calculateRouteSimilarity(
            passenger.routePoints,
            driver.routePoints,
            { 
              similarityThreshold: 0.001, 
              maxDistanceThreshold: 50.0
            }
          );

          console.log(`🔍 ${driver.driverName} ↔ ${passenger.passengerName}: Score=${similarity.toFixed(3)}`);

          if (similarity > 0.01) {
            const driverId = driver.userId || driver.driverId;
            const matchKey = generateMatchKey(driverId, passenger.userId, Date.now());
            
            if (!processedMatches.has(matchKey)) {
              const matchData = {
                matchId: `match_${driverId}_${passenger.userId}_${Date.now()}`,
                driverId: driverId,
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
                rideType: driver.rideType || passenger.rideType || 'immediate',
                scheduledTime: driver.scheduledTime || passenger.scheduledTime,
                timestamp: new Date().toISOString(),
                matchType: driver.documentId ? 'driver_schedule_match' : 'immediate_match',
                unlimitedMode: UNLIMITED_CAPACITY,
                source: driver.documentId ? 'Firestore' : 'Memory'
              };

              const matchCreated = await createActiveMatchForOverlay(matchData);
              
              if (matchCreated) {
                matchesCreated++;
                processedMatches.set(matchKey, Date.now());
                console.log(`🎉 MATCH CREATED: ${driver.driverName} ↔ ${passenger.passengerName}`);
                
                if (driver.documentId) {
                  console.log(`   📅 DRIVER SCHEDULE MATCH from Firestore!`);
                }
              }
            }
          }
        }
      }

      if (matchesCreated > 0) {
        console.log(`📱 Created ${matchesCreated} matches`);
      }
      
      console.log(`📊 ===== MATCHING CYCLE END =====\n`);
      
    } catch (error) {
      console.error('❌ Matching error:', error);
    }
  }, matchingInterval);

  // Check driver schedules every 10 seconds
  setInterval(checkDriverSchedulesActivation, SCHEDULED_SEARCH_CHECK_INTERVAL);
};

// ========== STOP SEARCH ENDPOINT ==========

app.post("/api/match/stop-search", async (req, res) => {
  try {
    const { userId, userType, rideType = 'immediate', driverId } = req.body;
    const actualUserId = userId || driverId;
    
    if (!actualUserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId or driverId is required' 
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
        await updateDriverScheduleStatus(schedule.id, 'cancelled');
        stoppedFromFirestore = true;
        console.log(`✅ Cancelled driver schedule in Firestore: ${schedule.id}`);
      }
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
        rideType: memorySearch.rideType,
        status: memorySearch.status,
        searchId: memorySearch.searchId,
        createdAt: memorySearch.createdAt
      } : { exists: false },
      driverSchedule: driverSchedule ? {
        exists: true,
        id: driverSchedule.id,
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
        id: data.id,
        driverId: data.driverId,
        driverName: data.driverName,
        status: data.status,
        scheduledTime: data.scheduledTime.toDate().toISOString(),
        pickupName: data.pickupName,
        destinationName: data.destinationName,
        estimatedFare: data.estimatedFare,
        capacity: data.capacity
      });
    });
    
    const debugInfo = {
      server: {
        timestamp: new Date().toISOString(),
        testMode: TEST_MODE,
        unlimitedCapacity: UNLIMITED_CAPACITY,
        websocketConnections: websocketServer ? websocketServer.getConnectedCount() : 0
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
      memoryDrivers: memoryDrivers.map(d => ({
        driverName: d.driverName,
        rideType: d.rideType,
        matches: userMatches.get(d.userId)?.size || 0
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
    message: "ShareWay Driver Schedule Server is running",
    timestamp: new Date().toISOString(),
    version: "3.0.0",
    features: {
      immediateMatching: true,
      driverSchedules: true,
      firestoreStorage: true,
      websocketNotifications: true,
      testMode: TEST_MODE,
      unlimitedCapacity: UNLIMITED_CAPACITY
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
🚀 ShareWay DRIVER SCHEDULES Server Started!
📍 Port: ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
🔥 Firebase: Driver Schedule Storage Mode
💾 Memory Cache: Immediate searches only
💾 Firestore: Driver schedules based on driver ID
🔌 WebSocket: CONNECTION TIMING FIXED

🎯 STORAGE STRATEGY:
   - Immediate searches: Memory only (fast)
   - Driver schedules: Firestore collection by driver ID
   - Simplified data: Only essential schedule information

🧪 TEST MODE: ${TEST_MODE ? 'ACTIVE' : 'INACTIVE'}
🎯 UNLIMITED CAPACITY: ${UNLIMITED_CAPACITY ? 'ACTIVE 🚀' : 'INACTIVE'}

📊 Current Stats:
- Active Searches: ${activeSearches.size} (in memory)
- Processed Matches: ${processedMatches.size} (in memory)
- Active Timeouts: ${searchTimeouts.size} (in memory)
- Users with Matches: ${userMatches.size} (in memory)
- WebSocket Connections: ${websocketServer ? websocketServer.getConnectedCount() : 0}

💾 FIRESTORE COLLECTIONS:
- ${DRIVER_SCHEDULES_COLLECTION}: Driver schedules by driver ID
- ${ACTIVE_MATCHES_COLLECTION}: Active matches
- ${NOTIFICATIONS_COLLECTION}: User notifications

✅ DRIVER SCHEDULES NOW SAVED BY DRIVER ID! 🎉
   - Collection: ${DRIVER_SCHEDULES_COLLECTION}
   - Primary key: driverId
   - Essential data: pickup, destination, time, fare, capacity

📱 ENDPOINTS:
- POST /api/match/driver-schedule - Save driver schedule
- GET /api/match/driver-schedules/:driverId - Get all driver schedules
- GET /api/match/driver-schedule/:driverId - Get latest driver schedule
- POST /api/match/search - Start immediate search
- POST /api/match/stop-search - Stop search
- GET /api/debug/status - Debug information
- GET /api/health - Health check
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
