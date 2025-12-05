const { TIMEOUTS, TEST_MODE } = require('../config/constants');
const cache = require('../utils/cache');

// In-memory storage for active searches
const activeSearches = new Map();
const searchTimeouts = new Map();

class SearchService {
  constructor(firestoreService, websocketServer) {
    this.firestoreService = firestoreService;
    this.websocketServer = websocketServer;
    this.processedMatches = new Map();
    this.userMatches = new Map();
  }
  
  // Store search in memory
  storeSearchInMemory(searchData) {
    const { userId, userType, rideType = 'immediate' } = searchData;
    
    if (!userId) throw new Error('userId is required');
    
    const enhancedSearchData = {
      userId: userId,
      userType: userType,
      driverName: searchData.driverName || 'Unknown Driver',
      passengerName: searchData.passengerName || 'Unknown Passenger',
      pickupLocation: searchData.pickupLocation || {},
      destinationLocation: searchData.destinationLocation || {},
      pickupName: searchData.pickupName || 'Unknown Pickup',
      destinationName: searchData.destinationName || 'Unknown Destination',
      routePoints: searchData.routePoints || [],
      passengerCount: searchData.passengerCount || (userType === 'passenger' ? 1 : 0),
      capacity: searchData.capacity || 4,
      distance: searchData.distance,
      duration: searchData.duration,
      fare: searchData.fare,
      estimatedFare: searchData.estimatedFare,
      rideType: rideType,
      scheduledTime: searchData.scheduledTime,
      searchId: searchData.searchId || `${rideType}_${userId}_${Date.now()}`,
      status: 'searching',
      lastUpdated: Date.now(),
      createdAt: searchData.createdAt || new Date().toISOString()
    };
    
    activeSearches.set(userId, enhancedSearchData);
    
    // Set timeout for immediate searches
    if (rideType === 'immediate') {
      this.setImmediateSearchTimeout(userId, enhancedSearchData.searchId);
    }
    
    console.log(`🎯 ${rideType.toUpperCase()} search stored: ${enhancedSearchData.driverName || enhancedSearchData.passengerName}`);
    
    return enhancedSearchData;
  }
  
  // Set timeout for immediate search
  setImmediateSearchTimeout(userId, searchId) {
    const timeoutId = setTimeout(() => {
      console.log(`⏰ IMMEDIATE SEARCH TIMEOUT: Auto-stopping search for user ${userId}`);
      
      if (activeSearches.has(userId)) {
        const search = activeSearches.get(userId);
        activeSearches.delete(userId);
        
        if (this.websocketServer) {
          this.websocketServer.sendSearchTimeout(userId, {
            searchId: searchId,
            message: 'Search automatically stopped after 5 minutes',
            duration: '5 minutes',
            rideType: 'immediate'
          });
        }
      }
      
      searchTimeouts.delete(userId);
      
    }, TIMEOUTS.IMMEDIATE_SEARCH);
    
    searchTimeouts.set(userId, {
      timeoutId: timeoutId,
      searchId: searchId,
      type: 'immediate',
      startedAt: Date.now(),
      expiresAt: Date.now() + TIMEOUTS.IMMEDIATE_SEARCH
    });
    
    console.log(`⏰ Set 5-minute timeout for immediate search: ${userId}`);
  }
  
  // Clear search timeout
  clearSearchTimeout(userId) {
    if (searchTimeouts.has(userId)) {
      const timeout = searchTimeouts.get(userId);
      clearTimeout(timeout.timeoutId);
      searchTimeouts.delete(userId);
      console.log(`🧹 Cleared timeout for user: ${userId}`);
    }
  }
  
  // Stop user search
  stopUserSearch(userId) {
    try {
      console.log(`🛑 Stopping search for user: ${userId}`);
      
      this.clearSearchTimeout(userId);
      
      if (activeSearches.has(userId)) {
        const search = activeSearches.get(userId);
        activeSearches.delete(userId);
        
        if (this.websocketServer) {
          this.websocketServer.sendSearchStopped(userId, {
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
  }
  
  // Get search from memory
  getSearchFromMemory(userId) {
    return activeSearches.get(userId);
  }
  
  // Get all active searches from memory
  getAllActiveSearchesFromMemory() {
    const drivers = Array.from(activeSearches.values())
      .filter(search => search.userType === 'driver');
    const passengers = Array.from(activeSearches.values())
      .filter(search => search.userType === 'passenger');
    
    return { drivers, passengers };
  }
  
  // Get search status
  getSearchStatus(userId) {
    const memorySearch = activeSearches.get(userId);
    const timeout = searchTimeouts.get(userId);
    const userMatchCount = this.userMatches.get(userId)?.size || 0;
    
    return {
      memorySearch: memorySearch ? {
        exists: true,
        driverName: memorySearch.driverName,
        passengerName: memorySearch.passengerName,
        userType: memorySearch.userType,
        rideType: memorySearch.rideType,
        status: memorySearch.status,
        searchId: memorySearch.searchId
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
      stats: {
        activeSearches: activeSearches.size,
        activeTimeouts: searchTimeouts.size,
        usersWithMatches: this.userMatches.size
      }
    };
  }
  
  // Track user match
  trackUserMatch(userId, matchId, matchedUserId) {
    if (!this.userMatches.has(userId)) {
      this.userMatches.set(userId, new Set());
    }
    this.userMatches.get(userId).add(matchId);
  }
  
  // Clean old data
  cleanupOldData() {
    const now = Date.now();
    
    // Clean old processed matches
    for (const [key, timestamp] of this.processedMatches.entries()) {
      if (now - timestamp > TIMEOUTS.MAX_MATCH_AGE) {
        this.processedMatches.delete(key);
      }
    }
    
    // Clean expired timeouts
    for (const [userId, timeout] of searchTimeouts.entries()) {
      if (timeout.expiresAt && now > timeout.expiresAt) {
        searchTimeouts.delete(userId);
      }
    }
  }
  
  // Get statistics
  getStats() {
    return {
      activeSearches: activeSearches.size,
      searchTimeouts: searchTimeouts.size,
      processedMatches: this.processedMatches.size,
      userMatches: this.userMatches.size,
      memory: {
        drivers: Array.from(activeSearches.values()).filter(s => s.userType === 'driver').length,
        passengers: Array.from(activeSearches.values()).filter(s => s.userType === 'passenger').length
      }
    };
  }
}

module.exports = SearchService;
