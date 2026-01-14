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
  
  // ========== ADD THESE CRITICAL METHODS ==========
  
  // Add driver search with Firestore save
  async addDriverSearch(searchData) {
    try {
      console.log('🚗 SearchService.addDriverSearch called with:');
      console.log('  driverName:', searchData.driverName);
      console.log('  driverPhone:', searchData.driverPhone);
      console.log('  driverPhotoUrl:', searchData.driverPhotoUrl || searchData.driverPhoto);
      console.log('  All keys:', Object.keys(searchData));
      
      // Store in memory
      const memorySearch = this.storeSearchInMemory(searchData);
      
      // ✅ CRITICAL: Save to Firestore
      const firestoreResult = await this.firestoreService.saveDriverSearch({
        driverPhone: searchData.driverPhone || searchData.userId,
        driverName: searchData.driverName,
        driverPhotoUrl: searchData.driverPhotoUrl || searchData.driverPhoto || '',
        driverRating: searchData.driverRating,
        pickupLocation: searchData.pickupLocation,
        destinationLocation: searchData.destinationLocation,
        pickupName: searchData.pickupName,
        destinationName: searchData.destinationName,
        routePoints: searchData.routePoints,
        capacity: searchData.capacity || 4,
        distance: searchData.distance,
        duration: searchData.duration,
        estimatedFare: searchData.estimatedFare,
        rideType: searchData.rideType || 'immediate',
        searchId: searchData.searchId || `driver_${Date.now()}`,
        status: 'searching'
      });
      
      console.log('✅ Driver search saved to Firestore:', {
        documentId: firestoreResult?.documentId,
        driverName: firestoreResult?.driverName,
        driverPhotoUrl: firestoreResult?.driverPhotoUrl
      });
      return memorySearch;
      
    } catch (error) {
      console.error('❌ Error in addDriverSearch:', error);
      throw error;
    }
  }
  
  // Add passenger search with Firestore save
  async addPassengerSearch(searchData) {
    try {
      console.log('👤 SearchService.addPassengerSearch called with:');
      console.log('  passengerName:', searchData.passengerName);
      console.log('  passengerPhone:', searchData.passengerPhone);
      console.log('  passengerPhotoUrl:', searchData.passengerPhotoUrl || searchData.passengerPhoto);
      console.log('  All keys:', Object.keys(searchData));
      
      // Store in memory
      const memorySearch = this.storeSearchInMemory(searchData);
      
      // ✅ CRITICAL: Save to Firestore
      const firestoreResult = await this.firestoreService.savePassengerSearch({
        passengerPhone: searchData.passengerPhone || searchData.userId,
        passengerName: searchData.passengerName,
        passengerPhotoUrl: searchData.passengerPhotoUrl || searchData.passengerPhoto || '',
        passengerRating: searchData.passengerRating,
        pickupLocation: searchData.pickupLocation || searchData.pickup?.location,
        destinationLocation: searchData.destinationLocation || searchData.dropoff?.location,
        pickupName: searchData.pickupName || searchData.pickup?.address,
        destinationName: searchData.destinationName || searchData.dropoff?.address,
        routePoints: searchData.routePoints,
        passengerCount: searchData.passengerCount || searchData.numberOfPassengers || 1,
        distance: searchData.distance,
        duration: searchData.duration,
        estimatedFare: searchData.estimatedFare,
        rideType: searchData.rideType || 'immediate',
        searchId: searchData.searchId || `passenger_${Date.now()}`,
        status: 'searching'
      });
      
      console.log('✅ Passenger search saved to Firestore:', {
        documentId: firestoreResult?.documentId,
        passengerName: firestoreResult?.passengerName,
        passengerPhotoUrl: firestoreResult?.passengerPhotoUrl || 'No photo saved'
      });
      return memorySearch;
      
    } catch (error) {
      console.error('❌ Error in addPassengerSearch:', error);
      throw error;
    }
  }
  
  // ========== EXISTING METHODS (UPDATED) ==========
  
  // Store search in memory
  storeSearchInMemory(searchData) {
    const { userId, userType, rideType = 'immediate' } = searchData;
    
    if (!userId) throw new Error('userId is required');
    
    // ✅ Extract photos - supporting both formats
    const { passengerPhoto, passengerPhotoUrl, driverPhoto, driverPhotoUrl } = searchData;
    
    // Use photoUrl format if available, fall back to photo format
    const enhancedSearchData = {
      userId: userId,
      userType: userType,
      driverName: searchData.driverName || 'Unknown Driver',
      passengerName: searchData.passengerName || 'Unknown Passenger',
      
      // ✅ SUPPORT BOTH FORMATS: photoUrl takes priority, falls back to photo
      driverPhoto: driverPhotoUrl || driverPhoto || null,
      passengerPhoto: passengerPhotoUrl || passengerPhoto || null,
      
      // Generic photo field for easier access
      userPhoto: this.getUserPhoto(searchData, userType),
      
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
    console.log(`📸 Photo: ${enhancedSearchData.userPhoto || 'No photo'}`);
    
    return enhancedSearchData;
  }
  
  // Helper method to get user photo based on user type
  getUserPhoto(searchData, userType) {
    // ✅ Check photoUrl format first, then photo format
    if (userType === 'driver') {
      return searchData.driverPhotoUrl || searchData.driverPhoto || searchData.userPhoto || null;
    } else if (userType === 'passenger') {
      return searchData.passengerPhotoUrl || searchData.passengerPhoto || searchData.userPhoto || null;
    }
    return null;
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
            rideType: 'immediate',
            // Include user info in timeout message
            userInfo: this.getUserInfoForWebsocket(search)
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
  stopUserSearch(userId, reason = 'match_found') {
    try {
      console.log(`🛑 Stopping search for user: ${userId} (Reason: ${reason})`);
      
      this.clearSearchTimeout(userId);
      
      if (activeSearches.has(userId)) {
        const search = activeSearches.get(userId);
        activeSearches.delete(userId);
        
        if (this.websocketServer) {
          this.websocketServer.sendSearchStopped(userId, {
            searchId: search.searchId,
            rideType: search.rideType,
            reason: reason,
            message: this.getStopMessage(reason),
            userInfo: this.getUserInfoForWebsocket(search)
          });
        }
      }
      
      return true;
    } catch (error) {
      console.error('❌ Error stopping user search:', error);
      return false;
    }
  }
  
  // Helper method to get stop message based on reason
  getStopMessage(reason) {
    const messages = {
      'match_found': 'Search stopped - match found!',
      'user_cancelled': 'Search cancelled by user',
      'timeout': 'Search timed out',
      'system': 'Search stopped by system'
    };
    return messages[reason] || 'Search stopped';
  }
  
  // Get search from memory
  getSearchFromMemory(userId) {
    const search = activeSearches.get(userId);
    if (search) {
      // ✅ Ensure both photo formats are accessible
      return {
        ...search,
        driverPhoto: search.driverPhoto || null,
        passengerPhoto: search.passengerPhoto || null,
        // Also provide photoUrl format for backward compatibility
        driverPhotoUrl: search.driverPhoto || null,
        passengerPhotoUrl: search.passengerPhoto || null,
        userPhoto: search.userPhoto || null
      };
    }
    return null;
  }
  
  // Get all active searches from memory
  getAllActiveSearchesFromMemory() {
    const drivers = Array.from(activeSearches.values())
      .filter(search => search.userType === 'driver')
      .map(search => ({
        ...search,
        // ✅ Include both formats
        photo: search.userPhoto || search.driverPhoto || null,
        driverPhoto: search.driverPhoto || null,
        driverPhotoUrl: search.driverPhoto || null
      }));
    
    const passengers = Array.from(activeSearches.values())
      .filter(search => search.userType === 'passenger')
      .map(search => ({
        ...search,
        // ✅ Include both formats
        photo: search.userPhoto || search.passengerPhoto || null,
        passengerPhoto: search.passengerPhoto || null,
        passengerPhotoUrl: search.passengerPhoto || null
      }));
    
    return { drivers, passengers };
  }
  
  // Get filtered active searches (e.g., for matching)
  getActiveSearchesByType(userType) {
    return Array.from(activeSearches.values())
      .filter(search => search.userType === userType)
      .map(search => {
        const photo = this.getUserPhoto(search, userType);
        
        return {
          userId: search.userId,
          userType: search.userType,
          name: userType === 'driver' ? search.driverName : search.passengerName,
          photo: photo,
          // ✅ Include photoUrl format for API responses
          photoUrl: photo,
          pickupLocation: search.pickupLocation,
          destinationLocation: search.destinationLocation,
          pickupName: search.pickupName,
          destinationName: search.destinationName,
          routePoints: search.routePoints,
          passengerCount: search.passengerCount,
          capacity: search.capacity,
          distance: search.distance,
          duration: search.duration,
          fare: search.fare,
          estimatedFare: search.estimatedFare,
          rideType: search.rideType,
          scheduledTime: search.scheduledTime,
          searchId: search.searchId,
          status: search.status,
          lastUpdated: search.lastUpdated
        };
      });
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
        driverPhoto: memorySearch.driverPhoto,
        passengerPhoto: memorySearch.passengerPhoto,
        // ✅ Include photoUrl format in status
        driverPhotoUrl: memorySearch.driverPhoto,
        passengerPhotoUrl: memorySearch.passengerPhoto,
        userPhoto: memorySearch.userPhoto,
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
  
  // Get user info for websocket messages
  getUserInfoForWebsocket(search) {
    if (!search) return null;
    
    const photo = search.userType === 'driver' 
      ? search.driverPhoto 
      : search.passengerPhoto;
    
    return {
      userId: search.userId,
      userType: search.userType,
      name: search.userType === 'driver' ? search.driverName : search.passengerName,
      photo: photo,
      // ✅ Include photoUrl for frontend
      photoUrl: photo,
      searchId: search.searchId
    };
  }
  
  // Validate photo URL (basic validation)
  validatePhotoUrl(url) {
    if (!url || url === 'null' || url === 'undefined') return null;
    
    // Check if it's a valid URL pattern
    const urlPattern = /^(https?:\/\/[^\s$.?#].[^\s]*)$/i;
    if (urlPattern.test(url)) {
      return url;
    }
    
    // Check for Firebase Storage URL pattern
    const firebasePattern = /^https:\/\/firebasestorage\.googleapis\.com\/.*/i;
    if (firebasePattern.test(url)) {
      return url;
    }
    
    // Check for data URL (base64) - though we're using URLs primarily
    const dataUrlPattern = /^data:image\/[a-z]+;base64,/i;
    if (dataUrlPattern.test(url)) {
      return url; // Accept base64 if provided
    }
    
    console.warn(`⚠️ Invalid photo URL format: ${url.substring(0, 50)}...`);
    return null;
  }
  
  // Clean old data
  cleanupOldData() {
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    
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
    
    // Clean very old active searches (shouldn't normally happen)
    let cleanedCount = 0;
    for (const [userId, search] of activeSearches.entries()) {
      if (search.lastUpdated && search.lastUpdated < oneHourAgo) {
        activeSearches.delete(userId);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      console.log(`🧹 Cleaned ${cleanedCount} old active searches`);
    }
  }
  
  // Get statistics
  getStats() {
    const activeSearchArray = Array.from(activeSearches.values());
    
    return {
      activeSearches: activeSearches.size,
      searchTimeouts: searchTimeouts.size,
      processedMatches: this.processedMatches.size,
      userMatches: this.userMatches.size,
      memory: {
        drivers: activeSearchArray.filter(s => s.userType === 'driver').length,
        passengers: activeSearchArray.filter(s => s.userType === 'passenger').length,
        withPhotos: activeSearchArray.filter(s => s.userPhoto || s.driverPhoto || s.passengerPhoto).length,
        withPhotoUrlFormat: activeSearchArray.filter(s => 
          s.userType === 'driver' ? s.driverPhotoUrl : s.passengerPhotoUrl
        ).length
      },
      sample: activeSearchArray.length > 0 ? {
        firstDriver: activeSearchArray.find(s => s.userType === 'driver')?.driverName,
        firstDriverPhoto: activeSearchArray.find(s => s.userType === 'driver')?.driverPhoto,
        firstPassenger: activeSearchArray.find(s => s.userType === 'passenger')?.passengerName,
        firstPassengerPhoto: activeSearchArray.find(s => s.userType === 'passenger')?.passengerPhoto
      } : null
    };
  }
  
  // Clear all searches (for testing/reset)
  clearAllSearches() {
    const count = activeSearches.size;
    activeSearches.clear();
    
    // Clear all timeouts
    for (const [userId, timeout] of searchTimeouts.entries()) {
      clearTimeout(timeout.timeoutId);
    }
    searchTimeouts.clear();
    
    this.userMatches.clear();
    this.processedMatches.clear();
    
    console.log(`🧹 Cleared all searches (${count} active searches removed)`);
    return count;
  }
}

module.exports = SearchService;
