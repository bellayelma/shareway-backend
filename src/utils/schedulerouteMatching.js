// utils/schedulerouteMatching.js - DEDICATED SCHEDULED SEARCH MATCHING
const admin = require('firebase-admin');

// Scheduled search management
const scheduledSearches = new Map();
const scheduledMatches = new Map();
const ACTIVATION_BUFFER = 30 * 60 * 1000; // 30 minutes before scheduled time

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
  
  return scheduledSearch;
};

// Check and activate scheduled searches
const checkScheduledSearchActivation = () => {
  const now = new Date();
  let activatedCount = 0;
  let expiredCount = 0;

  console.log(`\n🕒 Checking scheduled searches activation... (Total: ${scheduledSearches.size})`);

  for (const [userId, search] of scheduledSearches.entries()) {
    const timeUntilRide = search.scheduledTime.getTime() - now.getTime();
    const timeUntilActivation = timeUntilRide - ACTIVATION_BUFFER;
    
    console.log(`   - ${search.driverName || search.passengerName}:`);
    console.log(`     Scheduled: ${search.scheduledTime.toISOString()}`);
    console.log(`     Time until ride: ${Math.round(timeUntilRide / 60000)}min`);
    console.log(`     Time until activation: ${Math.round(timeUntilActivation / 60000)}min`);
    console.log(`     Status: ${search.status}`);

    // Check if search should be expired (more than 2 hours past scheduled time)
    if (timeUntilRide < -120 * 60 * 1000) {
      search.status = 'expired';
      expiredCount++;
      console.log(`     ❌ EXPIRED: More than 2 hours past scheduled time`);
      continue;
    }

    // Check if search should be activated (within 30 minutes of scheduled time)
    if (timeUntilActivation <= 0 && search.status === 'scheduled') {
      search.status = 'activating';
      search.lastUpdated = Date.now();
      activatedCount++;
      console.log(`     🔄 ACTIVATING: Within 30 minutes of scheduled time`);
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

// Get scheduled searches ready for matching
const getScheduledSearchesForMatching = (userType) => {
  const matchingSearches = Array.from(scheduledSearches.values())
    .filter(search => 
      search.userType === userType && 
      (search.status === 'activating' || search.status === 'active')
    );

  console.log(`📊 Scheduled ${userType}s ready for matching: ${matchingSearches.length}`);
  matchingSearches.forEach(search => {
    console.log(`   - ${search.driverName || search.passengerName}: ${search.status}`);
  });

  return matchingSearches;
};

// Dedicated scheduled search matching
const performScheduledMatching = async (db) => {
  try {
    console.log(`\n📅 ===== SCHEDULED MATCHING CYCLE START =====`);
    
    // First, check and update activation status
    const activationResult = checkScheduledSearchActivation();
    
    // Get scheduled drivers and passengers ready for matching
    const scheduledDrivers = getScheduledSearchesForMatching('driver');
    const scheduledPassengers = getScheduledSearchesForMatching('passenger');

    console.log(`📊 Scheduled Matching: ${scheduledDrivers.length} drivers vs ${scheduledPassengers.length} passengers`);

    if (scheduledDrivers.length === 0 || scheduledPassengers.length === 0) {
      console.log(`💤 No scheduled matches possible this cycle`);
      console.log(`📅 ===== SCHEDULED MATCHING CYCLE END =====\n`);
      return { matchesCreated: 0, reason: 'No matching pairs' };
    }

    let matchesCreated = 0;

    // Perform matching between scheduled searches
    for (const driver of scheduledDrivers) {
      for (const passenger of scheduledPassengers) {
        // Skip if same user
        if (driver.userId === passenger.userId) continue;

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

        // Calculate similarity
        const similarity = calculateRouteSimilarity(
          passenger.routePoints,
          driver.routePoints,
          { 
            similarityThreshold: 0.001, 
            maxDistanceThreshold: 50.0
          }
        );

        console.log(`🔍 SCHEDULED ${driver.driverName} ↔ ${passenger.passengerName}: Score=${similarity.toFixed(3)}`);

        // Process matches with threshold
        if (similarity > 0.01) {
          const matchKey = `scheduled_${driver.userId}_${passenger.userId}_${Math.floor(Date.now() / 300000)}`; // 5-minute windows

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
              timestamp: new Date().toISOString()
            };

            // Create scheduled match
            const created = await createScheduledMatch(db, matchData);
            if (created) {
              matchesCreated++;
              scheduledMatches.set(matchKey, Date.now());
              console.log(`🎉 SCHEDULED MATCH CREATED: ${driver.driverName} ↔ ${passenger.passengerName} (Score: ${similarity.toFixed(3)})`);
            }
          } else {
            console.log(`🔁 Skipping duplicate scheduled match: ${matchKey}`);
          }
        } else {
          console.log(`📉 Scheduled similarity too low: ${similarity.toFixed(3)}`);
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

// Create scheduled match in Firestore
const createScheduledMatch = async (db, matchData) => {
  try {
    const scheduledMatchData = {
      ...matchData,
      isScheduled: true,
      preMatch: true, // This is a pre-match before the actual ride time
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
        similarityScore: matchData.similarityScore
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
        similarityScore: matchData.similarityScore
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

// Convert scheduled search to active search when ride time approaches
const convertScheduledToActive = (userId) => {
  const scheduledSearch = scheduledSearches.get(userId);
  
  if (!scheduledSearch) {
    console.log(`❌ No scheduled search found for user: ${userId}`);
    return null;
  }

  if (scheduledSearch.status !== 'active') {
    console.log(`❌ Scheduled search not yet active: ${userId} (status: ${scheduledSearch.status})`);
    return null;
  }

  // Create active search data from scheduled search
  const activeSearch = {
    userId: scheduledSearch.userId,
    userType: scheduledSearch.userType,
    driverName: scheduledSearch.driverName,
    passengerName: scheduledSearch.passengerName,
    pickupLocation: scheduledSearch.pickupLocation,
    destinationLocation: scheduledSearch.destinationLocation,
    pickupName: scheduledSearch.pickupName,
    destinationName: scheduledSearch.destinationName,
    routePoints: scheduledSearch.routePoints,
    passengerCount: scheduledSearch.passengerCount,
    capacity: scheduledSearch.capacity,
    vehicleType: scheduledSearch.vehicleType,
    rideType: 'immediate', // Convert to immediate
    searchId: `converted_${scheduledSearch.searchId}`,
    originalScheduledTime: scheduledSearch.scheduledTime.toISOString(),
    convertedAt: new Date().toISOString()
  };

  // Remove from scheduled searches
  scheduledSearches.delete(userId);
  
  console.log(`🔄 CONVERTED scheduled to active: ${scheduledSearch.driverName || scheduledSearch.passengerName}`);
  console.log(`   - Original scheduled time: ${scheduledSearch.scheduledTime.toISOString()}`);
  console.log(`   - Converted at: ${new Date().toISOString()}`);

  return activeSearch;
};

// Get all scheduled searches that should be converted to active
const getScheduledSearchesForConversion = () => {
  const now = new Date();
  const conversions = [];

  for (const [userId, search] of scheduledSearches.entries()) {
    const timeUntilRide = search.scheduledTime.getTime() - now.getTime();
    
    // Convert if within 5 minutes of scheduled time and status is active
    if (timeUntilRide <= 5 * 60 * 1000 && search.status === 'active') {
      conversions.push(userId);
    }
  }

  console.log(`🔄 Scheduled searches ready for conversion: ${conversions.length}`);
  return conversions;
};

// Clean up old scheduled matches
const cleanupOldScheduledMatches = async (db, olderThanHours = 24) => {
  try {
    const cutoffTime = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
    const oldMatches = await db.collection('scheduled_matches')
      .where('createdAt', '<', cutoffTime)
      .where('status', 'in', ['proposed', 'pending'])
      .get();

    const batch = db.batch();
    oldMatches.forEach(doc => {
      batch.delete(doc.ref);
    });

    await batch.commit();
    console.log(`🧹 Cleaned up ${oldMatches.size} old scheduled matches`);
  } catch (error) {
    console.error('❌ Error cleaning up old scheduled matches:', error);
  }
};

// Get scheduled search status
const getScheduledSearchStatus = (userId) => {
  const search = scheduledSearches.get(userId);
  if (!search) {
    return { exists: false, message: 'No scheduled search found' };
  }

  const now = new Date();
  const timeUntilRide = search.scheduledTime.getTime() - now.getTime();
  const timeUntilActivation = timeUntilRide - ACTIVATION_BUFFER;

  return {
    exists: true,
    searchId: search.searchId,
    userId: search.userId,
    userType: search.userType,
    scheduledTime: search.scheduledTime.toISOString(),
    status: search.status,
    timeUntilRide: Math.round(timeUntilRide / 60000), // minutes
    timeUntilActivation: Math.round(timeUntilActivation / 60000), // minutes
    pickupName: search.pickupName,
    destinationName: search.destinationName,
    routePoints: search.routePoints.length
  };
};

// Remove scheduled search
const removeScheduledSearch = (userId) => {
  if (scheduledSearches.has(userId)) {
    const search = scheduledSearches.get(userId);
    scheduledSearches.delete(userId);
    console.log(`🗑️ Removed scheduled search: ${search.driverName || search.passengerName}`);
    return true;
  }
  return false;
};

// Get statistics
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
    totalScheduledMatches: scheduledMatches.size
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
  
  // Maintenance
  cleanupOldScheduledMatches,
  
  // Monitoring
  getScheduledMatchingStats,
  
  // Data access (for debugging)
  getAllScheduledSearches: () => Array.from(scheduledSearches.values()),
  getAllScheduledMatches: () => Array.from(scheduledMatches.values())
};
