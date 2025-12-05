// utils/schedulerouteMatching.js - HYBRID APPROACH FOR BILLING MINIMIZATION
const admin = require('firebase-admin'); // CHANGE THIS LINE

// TEST MODE - Set to true for immediate testing
const TEST_MODE = process.env.TEST_MODE === 'true';
const TEST_ACTIVATION_BUFFER = 1 * 60 * 1000; // 1 minute for testing

// Memory storage for ACTIVE MATCHING (cost optimization)
const scheduledSearches = new Map(); // For frequent matching cycles
const scheduledMatches = new Map(); // For duplicate prevention
const ACTIVATION_BUFFER = 30 * 60 * 1000; // 30 minutes before scheduled time

// FIRESTORE COLLECTION NAMES
const SCHEDULED_SEARCHES_COLLECTION = 'scheduled_searches';
const SCHEDULED_MATCHES_COLLECTION = 'scheduled_matches';

// 🎯 HYBRID: Save to Firestore once for persistence + memory for matching
const initializeScheduledSearch = async (db, searchData) => {
  try {
    const { userId, userType, scheduledTime, searchId } = searchData;
    
    const scheduledSearch = {
      searchId: searchId || `scheduled_${userId}_${Date.now()}`,
      userId,
      userType,
      driverName: searchData.driverName || 'Unknown Driver',
      passengerName: searchData.passengerName || 'Unknown Passenger',
      pickupLocation: searchData.pickupLocation,
      destinationLocation: searchData.destinationLocation,
      pickupName: searchData.pickupName || 'Unknown Pickup',
      destinationName: searchData.destinationName || 'Unknown Destination',
      routePoints: searchData.routePoints || [],
      passengerCount: searchData.passengerCount || 1,
      capacity: searchData.capacity || 4,
      vehicleType: searchData.vehicleType || 'car',
      scheduledTime: new Date(scheduledTime),
      status: 'scheduled', // scheduled, activating, active, expired
      createdAt: new Date(),
      lastUpdated: Date.now(),
      testMode: TEST_MODE
    };

    // 🎯 CRITICAL: Save to Firestore ONCE for persistence
    await saveScheduledSearchToFirestore(db, scheduledSearch);
    console.log(`💾 Saved to Firestore: ${scheduledSearch.searchId}`);

    // 🎯 ALSO store in memory for FAST MATCHING (cost optimization)
    scheduledSearches.set(userId, scheduledSearch);
    
    console.log(`📅 INITIALIZED scheduled search for user: ${userId} (${userType})`);
    console.log(`   Scheduled: ${scheduledSearch.scheduledTime.toISOString()}`);
    console.log(`   Storage: Firestore + Memory`);
    console.log(`   Test Mode: ${TEST_MODE}`);
    
    // 🎯 CRITICAL FIX: Auto-activate immediately in test mode
    if (TEST_MODE) {
      console.log(`   🚨 TEST MODE: Auto-activating immediately!`);
      scheduledSearch.status = 'activating';
      scheduledSearch.lastUpdated = Date.now();
      scheduledSearch.forceActivated = true;
      
      // Update Firestore status
      await updateScheduledSearchStatus(db, userId, 'activating');
    }
    
    return scheduledSearch;
  } catch (error) {
    console.error('❌ Error initializing scheduled search:', error);
    throw error;
  }
};

// 🎯 HYBRID: Save to Firestore once (for persistence)
const saveScheduledSearchToFirestore = async (db, searchData) => {
  try {
    const searchDoc = {
      ...searchData,
      scheduledTime: admin.firestore.Timestamp.fromDate(new Date(searchData.scheduledTime)),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection(SCHEDULED_SEARCHES_COLLECTION).doc(searchData.searchId).set(searchDoc);
    console.log(`✅ Saved scheduled search to Firestore: ${searchData.searchId}`);
    return true;
  } catch (error) {
    console.error('❌ Error saving scheduled search to Firestore:', error);
    throw error;
  }
};

// 🎯 FOR SCHEDULE TIME CHECKING: Read from Firestore (infrequent - cheap)
const getScheduledSearchFromFirestore = async (db, userId) => {
  try {
    console.log(`🔍 Reading scheduled search from Firestore for user: ${userId}`);
    
    // Use simpler query without composite index requirements
    const snapshot = await db.collection(SCHEDULED_SEARCHES_COLLECTION)
      .where('userId', '==', userId)
      .get();

    if (snapshot.empty) {
      console.log(`📭 No scheduled search found in Firestore for user: ${userId}`);
      return null;
    }

    // Filter in memory to avoid composite index requirement
    const validSearches = snapshot.docs
      .map(doc => {
        const data = doc.data();
        return {
          ...data,
          scheduledTime: data.scheduledTime.toDate(),
          exists: true,
          source: 'firestore'
        };
      })
      .filter(search => 
        ['scheduled', 'activating', 'active'].includes(search.status)
      )
      .sort((a, b) => b.scheduledTime - a.scheduledTime); // Sort by most recent

    if (validSearches.length === 0) {
      console.log(`📭 No active scheduled searches for user: ${userId}`);
      return null;
    }

    const searchData = validSearches[0];
    console.log(`✅ Found scheduled search in Firestore: ${searchData.searchId}`);
    
    return searchData;
  } catch (error) {
    console.error('❌ Error reading scheduled search from Firestore:', error);
    return null;
  }
};

// 🎯 FOR MATCHING: Use memory (frequent - free)
const getScheduledSearchFromMemory = (userId) => {
  const search = scheduledSearches.get(userId);
  if (search) {
    return {
      ...search,
      exists: true,
      source: 'memory'
    };
  }
  return {
    exists: false,
    source: 'memory'
  };
};

// 🎯 HYBRID: Get scheduled search status (prefers memory, falls back to Firestore)
const getScheduledSearchStatus = async (db, userId) => {
  try {
    // First check memory (fastest, free)
    const memorySearch = scheduledSearches.get(userId);
    if (memorySearch) {
      console.log(`⚡ Status check from memory: ${userId}`);
      return formatSearchStatus(memorySearch, 'memory');
    }

    // Fallback to Firestore (for schedule time checking)
    console.log(`🔍 Memory miss, checking Firestore for: ${userId}`);
    const firestoreSearch = await getScheduledSearchFromFirestore(db, userId);
    if (firestoreSearch) {
      return formatSearchStatus(firestoreSearch, 'firestore');
    }

    return { 
      exists: false, 
      message: 'No scheduled search found',
      source: 'both' 
    };

  } catch (error) {
    console.error('❌ Error getting scheduled search status:', error);
    return { 
      exists: false, 
      error: error.message,
      source: 'error' 
    };
  }
};

// Helper function to format search status
const formatSearchStatus = (search, source) => {
  const now = new Date();
  const timeUntilRide = search.scheduledTime.getTime() - now.getTime();
  const activationBuffer = TEST_MODE ? TEST_ACTIVATION_BUFFER : ACTIVATION_BUFFER;
  const timeUntilActivation = timeUntilRide - activationBuffer;

  return {
    exists: true,
    searchId: search.searchId,
    userId: search.userId,
    userType: search.userType,
    scheduledTime: search.scheduledTime.toISOString(),
    status: search.status,
    timeUntilRide: Math.round(timeUntilRide / 60000),
    timeUntilActivation: Math.round(timeUntilActivation / 60000),
    pickupName: search.pickupName,
    destinationName: search.destinationName,
    routePoints: search.routePoints.length,
    testMode: TEST_MODE,
    readyForMatching: search.status === 'activating' || search.status === 'active',
    forceActivated: search.forceActivated || false,
    source: source // 'memory' or 'firestore'
  };
};

// 🎯 HYBRID: Update status in both memory and Firestore
const updateScheduledSearchStatus = async (db, userId, newStatus) => {
  try {
    // Update memory first (immediate)
    const memorySearch = scheduledSearches.get(userId);
    if (memorySearch) {
      memorySearch.status = newStatus;
      memorySearch.lastUpdated = Date.now();
      console.log(`🔄 Memory status updated: ${userId} -> ${newStatus}`);
    }

    // Update Firestore for persistence
    const snapshot = await db.collection(SCHEDULED_SEARCHES_COLLECTION)
      .where('userId', '==', userId)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      const doc = snapshot.docs[0];
      await doc.ref.update({
        status: newStatus,
        lastUpdated: Date.now(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`💾 Firestore status updated: ${userId} -> ${newStatus}`);
    }

    return true;
  } catch (error) {
    console.error('❌ Error updating scheduled search status:', error);
    return false;
  }
};

// 🎯 FIXED: Load scheduled searches from Firestore to memory (no composite index needed)
const loadScheduledSearchesToMemory = async (db) => {
  try {
    console.log('🔄 Loading scheduled searches from Firestore to memory...');
    
    // Use simpler query without composite index
    const snapshot = await db.collection(SCHEDULED_SEARCHES_COLLECTION)
      .where('status', 'in', ['scheduled', 'activating', 'active'])
      .get();

    let loadedCount = 0;
    const now = new Date();
    
    snapshot.forEach(doc => {
      const searchData = doc.data();
      
      // Convert Firestore Timestamp to Date
      searchData.scheduledTime = searchData.scheduledTime.toDate();
      searchData.createdAt = searchData.createdAt.toDate();
      
      // Filter out expired searches (more than 2 hours past scheduled time)
      const timeUntilRide = searchData.scheduledTime.getTime() - now.getTime();
      if (timeUntilRide < -120 * 60 * 1000) {
        console.log(`🗑️ Skipping expired search: ${searchData.searchId}`);
        return; // Skip expired searches
      }
      
      scheduledSearches.set(searchData.userId, searchData);
      loadedCount++;
    });

    console.log(`✅ Loaded ${loadedCount} scheduled searches from Firestore to memory`);
    return loadedCount;
  } catch (error) {
    console.error('❌ Error loading scheduled searches to memory:', error);
    
    // Provide helpful error message
    if (error.code === 9) {
      console.error('⚠️ Firestore composite index is building or missing.');
      console.error('⚠️ To create the index, visit the link in the error message or run:');
      console.error('⚠️ firebase deploy --only firestore:indexes');
      console.error('⚠️ For now, using fallback loading method...');
      
      // Fallback: Load all and filter in memory
      return await fallbackLoadScheduledSearches(db);
    }
    
    return 0;
  }
};

// Fallback method for loading scheduled searches
const fallbackLoadScheduledSearches = async (db) => {
  try {
    console.log('🔄 Using fallback method to load scheduled searches...');
    
    const snapshot = await db.collection(SCHEDULED_SEARCHES_COLLECTION).get();
    
    let loadedCount = 0;
    const now = new Date();
    
    snapshot.forEach(doc => {
      const searchData = doc.data();
      
      // Convert Firestore Timestamp to Date
      searchData.scheduledTime = searchData.scheduledTime.toDate();
      searchData.createdAt = searchData.createdAt.toDate();
      
      // Filter in memory
      const timeUntilRide = searchData.scheduledTime.getTime() - now.getTime();
      const isActiveStatus = ['scheduled', 'activating', 'active'].includes(searchData.status);
      const isNotExpired = timeUntilRide >= -120 * 60 * 1000; // Not more than 2 hours past
      const isFutureOrNearFuture = timeUntilRide >= -30 * 60 * 1000; // Within 30 minutes past
      
      if (isActiveStatus && isNotExpired) {
        scheduledSearches.set(searchData.userId, searchData);
        loadedCount++;
      }
    });

    console.log(`✅ Fallback loaded ${loadedCount} scheduled searches`);
    return loadedCount;
  } catch (error) {
    console.error('❌ Error in fallback loading:', error);
    return 0;
  }
};

// 🎯 FIXED: Check and activate scheduled searches with TEST MODE (USES MEMORY)
const checkScheduledSearchActivation = async (db) => {
  const now = new Date();
  let activatedCount = 0;
  let expiredCount = 0;

  console.log(`\n🕒 Checking scheduled searches activation (${scheduledSearches.size} total)`);
  console.log(`🧪 Test Mode: ${TEST_MODE}`);

  for (const [userId, search] of scheduledSearches.entries()) {
    const timeUntilRide = search.scheduledTime.getTime() - now.getTime();
    
    // 🎯 USE TEST BUFFER IN TEST MODE
    const activationBuffer = TEST_MODE ? TEST_ACTIVATION_BUFFER : ACTIVATION_BUFFER;
    const timeUntilActivation = timeUntilRide - activationBuffer;
    
    console.log(`   ${search.userType}: ${search.driverName || search.passengerName}`);
    console.log(`     Status: ${search.status}`);
    console.log(`     Time until activation: ${Math.round(timeUntilActivation / 60000)}min`);

    // Check if search should be expired (more than 2 hours past scheduled time)
    if (timeUntilRide < -120 * 60 * 1000) {
      search.status = 'expired';
      await updateScheduledSearchStatus(db, userId, 'expired');
      expiredCount++;
      console.log(`     ❌ EXPIRED: More than 2 hours past`);
      continue;
    }

    // 🎯 TEST MODE: Auto-activate all searches immediately
    if (TEST_MODE && search.status === 'scheduled') {
      search.status = 'activating';
      search.lastUpdated = Date.now();
      search.forceActivated = true;
      await updateScheduledSearchStatus(db, userId, 'activating');
      activatedCount++;
      console.log(`     🚨 TEST MODE: Auto-activating!`);
      continue;
    }

    // NORMAL MODE: Check if search should be activated (within activation buffer of scheduled time)
    if (!TEST_MODE && timeUntilActivation <= 0 && search.status === 'scheduled') {
      search.status = 'activating';
      search.lastUpdated = Date.now();
      await updateScheduledSearchStatus(db, userId, 'activating');
      activatedCount++;
      console.log(`     🔄 ACTIVATING: Within activation buffer`);
    }

    // Check if search should be fully active (within 5 minutes of scheduled time)
    if (timeUntilRide <= 5 * 60 * 1000 && search.status === 'activating') {
      search.status = 'active';
      await updateScheduledSearchStatus(db, userId, 'active');
      console.log(`     ✅ ACTIVE: Within 5 minutes of ride`);
    }
  }

  if (activatedCount > 0) {
    console.log(`\n🎯 Activated ${activatedCount} scheduled searches`);
  }
  if (expiredCount > 0) {
    console.log(`\n🧹 Cleaned ${expiredCount} expired scheduled searches`);
    // Remove expired searches from memory
    for (const [userId, search] of scheduledSearches.entries()) {
      if (search.status === 'expired') {
        scheduledSearches.delete(userId);
      }
    }
  }

  return { activatedCount, expiredCount };
};

// 🎯 FIXED: Get scheduled searches ready for matching with TEST MODE (USES MEMORY)
const getScheduledSearchesForMatching = (userType) => {
  const matchingSearches = Array.from(scheduledSearches.values())
    .filter(search => {
      const shouldMatch = search.userType === userType && 
        (search.status === 'activating' || search.status === 'active');
      
      if (shouldMatch) {
        console.log(`   ✅ ${search.userType}: ${search.driverName || search.passengerName} - READY`);
        if (search.forceActivated) {
          console.log(`      🚨 FORCE ACTIVATED`);
        }
      }
      
      return shouldMatch;
    });

  console.log(`📊 Scheduled ${userType}s ready: ${matchingSearches.length}`);
  
  if (matchingSearches.length === 0 && scheduledSearches.size > 0) {
    console.log(`   ⚠️  No ${userType}s ready - checking status:`);
    Array.from(scheduledSearches.values())
      .filter(s => s.userType === userType)
      .forEach(s => {
        console.log(`     - ${s.driverName || s.passengerName}: ${s.status}`);
        if (s.status === 'scheduled') {
          const timeUntilRide = s.scheduledTime.getTime() - new Date().getTime();
          console.log(`       ⏰ Time until activation: ${Math.round((timeUntilRide - ACTIVATION_BUFFER) / 60000)}min`);
        }
      });
  }

  return matchingSearches;
};

// 🎯 FIXED: Dedicated scheduled search matching with TEST MODE (USES MEMORY)
const performScheduledMatching = async (db) => {
  try {
    console.log(`\n📅 ===== SCHEDULED MATCHING CYCLE START =====`);
    console.log(`🧪 Test Mode: ${TEST_MODE}`);
    
    // First, check and update activation status
    const activationResult = await checkScheduledSearchActivation(db);
    
    // Get scheduled drivers and passengers ready for matching FROM MEMORY
    const scheduledDrivers = getScheduledSearchesForMatching('driver');
    const scheduledPassengers = getScheduledSearchesForMatching('passenger');

    console.log(`📊 Scheduled Matching: ${scheduledDrivers.length} drivers vs ${scheduledPassengers.length} passengers`);

    if (scheduledDrivers.length === 0 || scheduledPassengers.length === 0) {
      const reason = scheduledDrivers.length === 0 ? 'No drivers' : 'No passengers';
      console.log(`💤 No scheduled matches possible: ${reason}`);
      console.log(`📅 ===== SCHEDULED MATCHING CYCLE END =====\n`);
      return { matchesCreated: 0, reason };
    }

    let matchesCreated = 0;

    // Perform matching between scheduled searches
    for (const driver of scheduledDrivers) {
      for (const passenger of scheduledPassengers) {
        // Skip if same user
        if (driver.userId === passenger.userId) {
          console.log(`⏭️ Skipping - same user: ${driver.userId}`);
          continue;
        }

        // Enhanced validation
        if (!driver.routePoints || driver.routePoints.length === 0) {
          console.log(`⚠️ Skipping driver ${driver.driverName} - no route points`);
          continue;
        }
        if (!passenger.routePoints || passenger.routePoints.length === 0) {
          console.log(`⚠️ Skipping passenger ${passenger.passengerName} - no route points`);
          continue;
        }

        // Check capacity
        const passengerCount = passenger.passengerCount || 1;
        const hasSeats = hasCapacity(driver, passengerCount);
        if (!hasSeats) {
          console.log(`⚠️ Skipping - no capacity: ${driver.capacity} vs ${passengerCount}`);
          continue;
        }

        // Calculate similarity - LOWER THRESHOLD FOR TESTING
        const similarity = calculateRouteSimilarity(
          passenger.routePoints,
          driver.routePoints,
          { 
            similarityThreshold: 0.001, 
            maxDistanceThreshold: TEST_MODE ? 100.0 : 50.0 // Increased for testing
          }
        );

        console.log(`🔍 ${driver.driverName} ↔ ${passenger.passengerName}: Score=${similarity.toFixed(3)}`);

        // 🎯 LOWER THRESHOLD FOR TESTING - match even with lower similarity
        const matchThreshold = TEST_MODE ? 0.005 : 0.01;
        
        if (similarity > matchThreshold) {
          const matchKey = `scheduled_${driver.userId}_${passenger.userId}_${Math.floor(Date.now() / 300000)}`;

          if (!scheduledMatches.has(matchKey)) {
            const matchData = {
              matchId: `scheduled_match_${driver.userId}_${passenger.userId}_${Date.now()}`,
              driverId: driver.userId,
              driverName: driver.driverName,
              passengerId: passenger.userId,
              passengerName: passenger.passengerName,
              similarityScore: similarity,
              pickupName: passenger.pickupName || driver.pickupName || 'Unknown Location',
              destinationName: passenger.destinationName || driver.destinationName || 'Unknown Destination',
              pickupLocation: passenger.pickupLocation || driver.pickupLocation,
              destinationLocation: passenger.destinationLocation || driver.destinationLocation,
              passengerCount: passenger.passengerCount || 1,
              capacity: driver.capacity || 4,
              vehicleType: driver.vehicleType || 'car',
              rideType: 'scheduled',
              scheduledTime: driver.scheduledTime.toISOString(),
              matchType: 'scheduled_pre_match',
              status: 'proposed',
              timestamp: new Date().toISOString(),
              testMode: TEST_MODE
            };

            // Create scheduled match
            const created = await createScheduledMatch(db, matchData);
            if (created) {
              matchesCreated++;
              scheduledMatches.set(matchKey, Date.now());
              console.log(`🎉 SCHEDULED MATCH: ${driver.driverName} ↔ ${passenger.passengerName} (${similarity.toFixed(3)})`);
              
              // In test mode, also create immediate match for testing
              if (TEST_MODE) {
                await createImmediateMatchFromScheduled(db, driver, passenger, similarity);
              }
            }
          } else {
            console.log(`🔁 Skipping duplicate: ${matchKey}`);
          }
        } else {
          console.log(`📉 Similarity too low: ${similarity.toFixed(3)} (threshold: ${matchThreshold})`);
          
          // 🎯 TEST MODE: Force create match even with low similarity
          if (TEST_MODE && similarity > 0.001) {
            console.log(`🧪 TEST MODE: Force creating match`);
            const forceMatch = await forceCreateScheduledMatch(db, driver, passenger, similarity);
            if (forceMatch) {
              matchesCreated++;
            }
          }
        }
      }
    }

    console.log(`📱 Created ${matchesCreated} scheduled matches`);
    console.log(`📅 ===== SCHEDULED MATCHING CYCLE END =====\n`);

    return { matchesCreated, activationResult };

  } catch (error) {
    console.error('❌ Error in scheduled matching:', error);
    return { matchesCreated: 0, error: error.message };
  }
};

// 🎯 NEW: Force create scheduled match for testing
const forceCreateScheduledMatch = async (db, driver, passenger, similarity) => {
  try {
    const timestamp = Date.now();
    const matchId = `force_scheduled_${driver.userId}_${passenger.userId}_${timestamp}`;
    
    const matchData = {
      matchId,
      driverId: driver.userId,
      driverName: driver.driverName,
      passengerId: passenger.userId,
      passengerName: passenger.passengerName,
      similarityScore: Math.max(similarity, 0.1), // Ensure minimum score
      matchQuality: 'test_forced',
      pickupName: passenger.pickupName || driver.pickupName || 'Test Location',
      destinationName: passenger.destinationName || driver.destinationName || 'Test Destination',
      pickupLocation: passenger.pickupLocation || driver.pickupLocation,
      destinationLocation: passenger.destinationLocation || driver.destinationLocation,
      passengerCount: passenger.passengerCount || 1,
      capacity: driver.capacity || 4,
      vehicleType: driver.vehicleType || 'car',
      rideType: 'scheduled',
      scheduledTime: driver.scheduledTime.toISOString(),
      matchType: 'scheduled_forced_match',
      status: 'proposed',
      timestamp: new Date(timestamp).toISOString(),
      forceCreated: true,
      testMode: true
    };

    await db.collection(SCHEDULED_MATCHES_COLLECTION).doc(matchId).set({
      ...matchData,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`🧪 FORCE CREATED: ${driver.driverName} ↔ ${passenger.passengerName}`);
    return matchData;
  } catch (error) {
    console.error('❌ Error force creating scheduled match:', error);
    return null;
  }
};

// Create immediate match from scheduled for testing
const createImmediateMatchFromScheduled = async (db, driver, passenger, similarity) => {
  try {
    const immediateMatchData = {
      matchId: `immediate_test_${driver.userId}_${passenger.userId}_${Date.now()}`,
      driverId: driver.userId,
      driverName: driver.driverName,
      passengerId: passenger.userId,
      passengerName: passenger.passengerName,
      similarityScore: similarity,
      pickupName: passenger.pickupName,
      destinationName: passenger.destinationName,
      pickupLocation: passenger.pickupLocation,
      destinationLocation: passenger.destinationLocation,
      passengerCount: passenger.passengerCount || 1,
      capacity: driver.capacity || 4,
      vehicleType: driver.vehicleType || 'car',
      rideType: 'immediate',
      matchType: 'test_immediate_from_scheduled',
      status: 'proposed',
      timestamp: new Date().toISOString(),
      isTest: true,
      originalScheduledTime: driver.scheduledTime.toISOString()
    };

    await db.collection('matches').doc(immediateMatchData.matchId).set({
      ...immediateMatchData,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`🧪 TEST: Created immediate match`);
    return true;
  } catch (error) {
    console.error('❌ Error creating test immediate match:', error);
    return false;
  }
};

// Create scheduled match in Firestore
const createScheduledMatch = async (db, matchData) => {
  try {
    const scheduledMatchData = {
      ...matchData,
      isScheduled: true,
      preMatch: true,
      notificationSent: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection(SCHEDULED_MATCHES_COLLECTION).doc(matchData.matchId).set(scheduledMatchData);
    console.log(`✅ Scheduled match stored: ${matchData.driverName} ↔ ${matchData.passengerName}`);

    return true;
  } catch (error) {
    console.error('❌ Error creating scheduled match:', error);
    return false;
  }
};

// Import necessary utility functions from routeMatching
const calculateRouteSimilarity = require('./routeMatching').calculateRouteSimilarity;
const hasCapacity = require('./routeMatching').hasCapacity;

// Helper function for cleaner logs
const log = {
  info: (message, data = null) => {
    const timestamp = new Date().toISOString().substr(11, 8);
    console.log(`[${timestamp}] ℹ️  ${message}`);
    if (data) console.log(`   ${JSON.stringify(data, null, 2)}`);
  },
  success: (message, data = null) => {
    const timestamp = new Date().toISOString().substr(11, 8);
    console.log(`[${timestamp}] ✅ ${message}`);
    if (data) console.log(`   ${JSON.stringify(data, null, 2)}`);
  },
  error: (message, error = null) => {
    const timestamp = new Date().toISOString().substr(11, 8);
    console.log(`[${timestamp}] ❌ ${message}`);
    if (error) console.log(`   Error: ${error.message || error}`);
  },
  warning: (message, data = null) => {
    const timestamp = new Date().toISOString().substr(11, 8);
    console.log(`[${timestamp}] ⚠️  ${message}`);
    if (data) console.log(`   ${JSON.stringify(data, null, 2)}`);
  },
  debug: (message, data = null) => {
    if (process.env.DEBUG === 'true') {
      const timestamp = new Date().toISOString().substr(11, 8);
      console.log(`[${timestamp}] 🐛 ${message}`);
      if (data) console.log(`   ${JSON.stringify(data, null, 2)}`);
    }
  }
};

module.exports = {
  // Core scheduled search management
  initializeScheduledSearch,
  checkScheduledSearchActivation,
  getScheduledSearchesForMatching,
  performScheduledMatching,
  
  // 🎯 NEW HYBRID STORAGE FUNCTIONS
  saveScheduledSearchToFirestore,
  getScheduledSearchFromFirestore,
  getScheduledSearchFromMemory,
  getScheduledSearchStatus,
  updateScheduledSearchStatus,
  loadScheduledSearchesToMemory,
  fallbackLoadScheduledSearches, // Export fallback method
  
  // Match management
  createScheduledMatch,
  forceCreateScheduledMatch,
  createImmediateMatchFromScheduled,
  
  // TESTING FUNCTIONS
  forceActivateAllScheduledSearches: async (db) => {
    let activatedCount = 0;
    
    for (const [userId, search] of scheduledSearches.entries()) {
      if (search.status === 'scheduled') {
        search.status = 'activating';
        search.lastUpdated = Date.now();
        search.forceActivated = true;
        await updateScheduledSearchStatus(db, userId, 'activating');
        activatedCount++;
      }
    }
    
    log.success(`Force activated ${activatedCount} scheduled searches`);
    return activatedCount;
  },
  
  // Maintenance
  cleanupOldScheduledMatches: () => {}, // Placeholder
  
  // Monitoring
  getScheduledMatchingStats: () => {
    return {
      totalScheduledSearches: scheduledSearches.size,
      scheduledDrivers: Array.from(scheduledSearches.values()).filter(s => s.userType === 'driver').length,
      scheduledPassengers: Array.from(scheduledSearches.values()).filter(s => s.userType === 'passenger').length,
      byStatus: {
        scheduled: Array.from(scheduledSearches.values()).filter(s => s.status === 'scheduled').length,
        activating: Array.from(scheduledSearches.values()).filter(s => s.status === 'activating').length,
        active: Array.from(scheduledSearches.values()).filter(s => s.status === 'active').length,
        expired: Array.from(scheduledSearches.values()).filter(s => s.status === 'expired').length
      },
      totalScheduledMatches: scheduledMatches.size,
      testMode: TEST_MODE,
      readyForMatching: Array.from(scheduledSearches.values()).filter(s => 
        s.status === 'activating' || s.status === 'active'
      ).length,
      forceActivated: Array.from(scheduledSearches.values()).filter(s => 
        s.forceActivated
      ).length,
      storageStrategy: 'HYBRID (Firestore persistence + Memory matching)',
      costOptimization: 'Matching uses memory (free), schedule checks use Firestore (cheap)'
    };
  },
  
  // Data access (for debugging)
  getAllScheduledSearches: () => Array.from(scheduledSearches.values()),
  getAllScheduledMatches: () => Array.from(scheduledMatches.values()),
  
  // Utility functions
  log, // Export log utility
  
  // Test mode flag
  TEST_MODE
};
