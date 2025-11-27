// utils/schedulerouteMatching.js - FIXED FOR IMMEDIATE TESTING
const admin = require('firebase-admin');

// Scheduled search management
const scheduledSearches = new Map();
const scheduledMatches = new Map();
const ACTIVATION_BUFFER = 30 * 60 * 1000; // 30 minutes before scheduled time

// TEST MODE - Set to true for immediate testing
const TEST_MODE = true;
const TEST_ACTIVATION_BUFFER = 1 * 60 * 1000; // 1 minute for testing

// Initialize scheduled search
const initializeScheduledSearch = (searchData) => {
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
    lastUpdated: Date.now()
  };

  scheduledSearches.set(userId, scheduledSearch);
  
  console.log(`📅 INITIALIZED scheduled search: ${scheduledSearch.driverName || scheduledSearch.passengerName}`);
  console.log(`   - User: ${userId} (${userType})`);
  console.log(`   - Scheduled: ${scheduledSearch.scheduledTime.toISOString()}`);
  console.log(`   - Route: ${scheduledSearch.pickupName} → ${scheduledSearch.destinationName}`);
  console.log(`   - TEST MODE: ${TEST_MODE ? 'ACTIVE' : 'INACTIVE'}`);
  
  // IMMEDIATE ACTIVATION FOR TESTING
  if (TEST_MODE) {
    console.log(`   🚨 TEST MODE: Auto-activating scheduled search immediately!`);
    scheduledSearch.status = 'activating';
    scheduledSearch.lastUpdated = Date.now();
  }
  
  return scheduledSearch;
};

// Check and activate scheduled searches - FIXED FOR TESTING
const checkScheduledSearchActivation = () => {
  const now = new Date();
  let activatedCount = 0;
  let expiredCount = 0;

  console.log(`\n🕒 Checking scheduled searches activation... (Total: ${scheduledSearches.size})`);

  for (const [userId, search] of scheduledSearches.entries()) {
    const timeUntilRide = search.scheduledTime.getTime() - now.getTime();
    
    // USE TEST BUFFER IN TEST MODE
    const activationBuffer = TEST_MODE ? TEST_ACTIVATION_BUFFER : ACTIVATION_BUFFER;
    const timeUntilActivation = timeUntilRide - activationBuffer;
    
    console.log(`   - ${search.driverName || search.passengerName}:`);
    console.log(`     Status: ${search.status}`);
    console.log(`     Scheduled: ${search.scheduledTime.toISOString()}`);
    console.log(`     Time until ride: ${Math.round(timeUntilRide / 60000)}min`);
    console.log(`     Time until activation: ${Math.round(timeUntilActivation / 60000)}min`);
    console.log(`     TEST MODE: ${TEST_MODE ? 'ACTIVE' : 'INACTIVE'}`);

    // Check if search should be expired (more than 2 hours past scheduled time)
    if (timeUntilRide < -120 * 60 * 1000) {
      search.status = 'expired';
      expiredCount++;
      console.log(`     ❌ EXPIRED: More than 2 hours past scheduled time`);
      continue;
    }

    // TEST MODE: Auto-activate all searches immediately
    if (TEST_MODE && search.status === 'scheduled') {
      search.status = 'activating';
      search.lastUpdated = Date.now();
      activatedCount++;
      console.log(`     🚨 TEST MODE: Auto-activating immediately!`);
      continue;
    }

    // NORMAL MODE: Check if search should be activated (within activation buffer of scheduled time)
    if (!TEST_MODE && timeUntilActivation <= 0 && search.status === 'scheduled') {
      search.status = 'activating';
      search.lastUpdated = Date.now();
      activatedCount++;
      console.log(`     🔄 ACTIVATING: Within activation buffer of scheduled time`);
    }

    // Check if search should be fully active (within 5 minutes of scheduled time)
    if (timeUntilRide <= 5 * 60 * 1000 && search.status === 'activating') {
      search.status = 'active';
      console.log(`     ✅ ACTIVE: Within 5 minutes of scheduled time`);
    }
  }

  if (activatedCount > 0) {
    console.log(`\n🎯 Activated ${activatedCount} scheduled searches for matching`);
  }
  if (expiredCount > 0) {
    console.log(`\n🧹 Cleaned ${expiredCount} expired scheduled searches`);
    // Remove expired searches
    for (const [userId, search] of scheduledSearches.entries()) {
      if (search.status === 'expired') {
        scheduledSearches.delete(userId);
      }
    }
  }

  return { activatedCount, expiredCount };
};

// Get scheduled searches ready for matching - FIXED FOR TESTING
const getScheduledSearchesForMatching = (userType) => {
  const matchingSearches = Array.from(scheduledSearches.values())
    .filter(search => {
      const shouldMatch = search.userType === userType && 
        (search.status === 'activating' || search.status === 'active');
      
      if (shouldMatch) {
        console.log(`   ✅ ${search.driverName || search.passengerName}: ${search.status} - READY FOR MATCHING`);
      }
      
      return shouldMatch;
    });

  console.log(`📊 Scheduled ${userType}s ready for matching: ${matchingSearches.length}`);
  
  if (matchingSearches.length === 0 && scheduledSearches.size > 0) {
    console.log(`   ⚠️  No ${userType}s ready - checking status:`);
    Array.from(scheduledSearches.values())
      .filter(s => s.userType === userType)
      .forEach(s => {
        console.log(`     - ${s.driverName || s.passengerName}: ${s.status}`);
      });
  }

  return matchingSearches;
};

// Dedicated scheduled search matching - FIXED FOR TESTING
const performScheduledMatching = async (db) => {
  try {
    console.log(`\n📅 ===== SCHEDULED MATCHING CYCLE START =====`);
    console.log(`🚨 TEST MODE: ${TEST_MODE ? 'ACTIVE - Matching immediately!' : 'INACTIVE'}`);
    
    // First, check and update activation status
    const activationResult = checkScheduledSearchActivation();
    
    // Get scheduled drivers and passengers ready for matching
    const scheduledDrivers = getScheduledSearchesForMatching('driver');
    const scheduledPassengers = getScheduledSearchesForMatching('passenger');

    console.log(`📊 Scheduled Matching: ${scheduledDrivers.length} drivers vs ${scheduledPassengers.length} passengers`);

    if (scheduledDrivers.length === 0 || scheduledPassengers.length === 0) {
      const reason = scheduledDrivers.length === 0 ? 'No drivers' : 'No passengers';
      console.log(`💤 No scheduled matches possible: ${reason}`);
      console.log(`   Total scheduled searches: ${scheduledSearches.size}`);
      console.log(`   - Drivers: ${Array.from(scheduledSearches.values()).filter(s => s.userType === 'driver').length}`);
      console.log(`   - Passengers: ${Array.from(scheduledSearches.values()).filter(s => s.userType === 'passenger').length}`);
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
          console.log(`⚠️ Skipping scheduled driver ${driver.driverName} - no route points`);
          continue;
        }
        if (!passenger.routePoints || passenger.routePoints.length === 0) {
          console.log(`⚠️ Skipping scheduled passenger ${passenger.passengerName} - no route points`);
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
            maxDistanceThreshold: 100.0 // Increased for testing
          }
        );

        console.log(`🔍 SCHEDULED ${driver.driverName} ↔ ${passenger.passengerName}: Score=${similarity.toFixed(3)}`);

        // LOWER THRESHOLD FOR TESTING - match even with lower similarity
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
              testMode: TEST_MODE // Flag for testing
            };

            // Create scheduled match
            const created = await createScheduledMatch(db, matchData);
            if (created) {
              matchesCreated++;
              scheduledMatches.set(matchKey, Date.now());
              console.log(`🎉 SCHEDULED MATCH CREATED: ${driver.driverName} ↔ ${passenger.passengerName} (Score: ${similarity.toFixed(3)})`);
              
              // In test mode, also create immediate match for testing
              if (TEST_MODE) {
                await createImmediateMatchFromScheduled(db, driver, passenger, similarity);
              }
            }
          } else {
            console.log(`🔁 Skipping duplicate scheduled match: ${matchKey}`);
          }
        } else {
          console.log(`📉 Scheduled similarity too low: ${similarity.toFixed(3)} (threshold: ${matchThreshold})`);
        }
      }
    }

    console.log(`📱 Created ${matchesCreated} scheduled matches this cycle`);
    console.log(`📅 ===== SCHEDULED MATCHING CYCLE END =====\n`);

    return { matchesCreated, activationResult };

  } catch (error) {
    console.error('❌ Error in scheduled matching:', error);
    return { matchesCreated: 0, error: error.message };
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

    console.log(`🧪 TEST: Created immediate match from scheduled: ${driver.driverName} ↔ ${passenger.passengerName}`);
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

    await db.collection('scheduled_matches').doc(matchData.matchId).set(scheduledMatchData);
    console.log(`✅ Scheduled match stored: ${matchData.driverName} ↔ ${matchData.passengerName}`);

    // Send scheduled match notification
    await sendScheduledMatchNotification(db, matchData);

    return true;
  } catch (error) {
    console.error('❌ Error creating scheduled match:', error);
    return false;
  }
};

// Send notification for scheduled match
const sendScheduledMatchNotification = async (db, matchData) => {
  try {
    const batch = db.batch();
    const timestamp = admin.firestore.FieldValue.serverTimestamp();

    // Format scheduled time for display
    const scheduledTime = new Date(matchData.scheduledTime);
    const timeString = scheduledTime.toLocaleString();

    // Driver notification
    const driverNotificationRef = db.collection('notifications').doc();
    batch.set(driverNotificationRef, {
      type: 'scheduled_match_proposal',
      userId: matchData.driverId,
      title: '📅 Scheduled Passenger Found!',
      message: `Passenger ${matchData.passengerName} scheduled for ${timeString}. Route similarity: ${(matchData.similarityScore * 100).toFixed(1)}%`,
      read: false,
      createdAt: timestamp,
      data: {
        matchId: matchData.matchId,
        matchType: 'scheduled',
        scheduledTime: matchData.scheduledTime,
        driverId: matchData.driverId,
        passengerId: matchData.passengerId,
        similarityScore: matchData.similarityScore,
        testMode: TEST_MODE
      }
    });

    // Passenger notification
    const passengerNotificationRef = db.collection('notifications').doc();
    batch.set(passengerNotificationRef, {
      type: 'scheduled_match_proposal',
      userId: matchData.passengerId,
      title: '📅 Scheduled Driver Found!',
      message: `Driver ${matchData.driverName} scheduled for ${timeString}. Route similarity: ${(matchData.similarityScore * 100).toFixed(1)}%`,
      read: false,
      createdAt: timestamp,
      data: {
        matchId: matchData.matchId,
        matchType: 'scheduled',
        scheduledTime: matchData.scheduledTime,
        driverId: matchData.driverId,
        passengerId: matchData.passengerId,
        similarityScore: matchData.similarityScore,
        testMode: TEST_MODE
      }
    });

    await batch.commit();
    console.log(`✅ Scheduled match notifications sent for: ${matchData.matchId}`);

    // Update match with notification status
    await db.collection('scheduled_matches').doc(matchData.matchId).update({
      notificationSent: true,
      notifiedAt: timestamp
    });

    return true;
  } catch (error) {
    console.error('❌ Error sending scheduled match notifications:', error);
    return false;
  }
};

// Force activate all scheduled searches for testing
const forceActivateAllScheduledSearches = () => {
  let activatedCount = 0;
  
  for (const [userId, search] of scheduledSearches.entries()) {
    if (search.status === 'scheduled') {
      search.status = 'activating';
      search.lastUpdated = Date.now();
      activatedCount++;
      console.log(`🚨 FORCE ACTIVATED: ${search.driverName || search.passengerName}`);
    }
  }
  
  console.log(`🎯 Force activated ${activatedCount} scheduled searches`);
  return activatedCount;
};

// Get scheduled search status with test mode info
const getScheduledSearchStatus = (userId) => {
  const search = scheduledSearches.get(userId);
  if (!search) {
    return { exists: false, message: 'No scheduled search found' };
  }

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
    readyForMatching: search.status === 'activating' || search.status === 'active'
  };
};

// Get statistics with test mode info
const getScheduledMatchingStats = () => {
  const stats = {
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
    ).length
  };

  return stats;
};

// Import necessary utility functions from routeMatching
const calculateRouteSimilarity = require('./routeMatching').calculateRouteSimilarity;
const hasCapacity = require('./routeMatching').hasCapacity;

module.exports = {
  // Core scheduled search management
  initializeScheduledSearch,
  checkScheduledSearchActivation,
  getScheduledSearchesForMatching,
  performScheduledMatching,
  
  // Conversion to active searches
  convertScheduledToActive,
  getScheduledSearchesForConversion,
  
  // Match management
  createScheduledMatch,
  sendScheduledMatchNotification,
  
  // Search management
  getScheduledSearchStatus,
  removeScheduledSearch,
  
  // TESTING FUNCTIONS
  forceActivateAllScheduledSearches,
  
  // Maintenance
  cleanupOldScheduledMatches,
  
  // Monitoring
  getScheduledMatchingStats,
  
  // Data access (for debugging)
  getAllScheduledSearches: () => Array.from(scheduledSearches.values()),
  getAllScheduledMatches: () => Array.from(scheduledMatches.values())
};
