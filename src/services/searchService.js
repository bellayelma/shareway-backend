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
    this.searchCooldowns = new Map(); // For rate limiting
    this.duplicateDetectionLog = new Map(); // Track duplicate attempts
    
    // Start cleanup interval
    this.startCleanupInterval();
  }
  
  // ========== ADD DRIVER SEARCH WITH DUPLICATE PREVENTION ==========
  
  async addDriverSearch(searchData) {
    try {
      console.log('🚗 SearchService.addDriverSearch called with:');
      console.log('  driverName:', searchData.driverName);
      console.log('  driverPhone:', searchData.driverPhone);
      console.log('  driverPhotoUrl:', searchData.driverPhotoUrl || searchData.driverPhoto);
      console.log('  All keys:', Object.keys(searchData));
      
      // ✅ CRITICAL: CHECK FOR DUPLICATE BEFORE PROCESSING
      const phone = searchData.driverPhone || searchData.userId;
      const existingSearch = this.getActiveSearchByPhone(phone);
      
      if (existingSearch) {
        const timeSinceLastSearch = Date.now() - existingSearch.lastUpdated;
        
        // If last search was less than 10 seconds ago, return existing search
        if (timeSinceLastSearch < 10000) {
          console.log(`⏱️ Skipping duplicate driver search for ${phone} (${Math.round(timeSinceLastSearch/1000)}s ago)`);
          console.log(`🔄 Returning existing search ID: ${existingSearch.searchId}`);
          this.logDuplicateAttempt(phone, 'driver', timeSinceLastSearch);
          return existingSearch;
        }
        
        // If it's been more than 10 seconds but less than 2 minutes, update existing
        if (timeSinceLastSearch < 120000) {
          console.log(`🔄 Updating existing driver search for ${phone} (${Math.round(timeSinceLastSearch/1000)}s old)`);
          
          // Update the existing search
          const updatedSearch = {
            ...existingSearch,
            ...searchData,
            lastUpdated: Date.now(),
            // Preserve the original searchId
            searchId: existingSearch.searchId,
            // Increment update count
            updateCount: (existingSearch.updateCount || 0) + 1
          };
          
          activeSearches.set(phone, updatedSearch);
          
          // Try to update in Firestore, but don't crash if it fails
          await this.updateExistingSearchInFirestore(phone, searchData, 'driver');
          
          return updatedSearch;
        }
        
        // Otherwise, remove the old search and continue
        console.log(`🧹 Removing stale driver search for ${phone} (${Math.round(timeSinceLastSearch/1000)}s old)`);
        this.stopUserSearch(phone, 'stale_replace');
      }
      
      // Check rate limiting
      this.checkRateLimit(phone);
      
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
        searchId: memorySearch.searchId,
        status: 'searching',
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString()
      });
      
      console.log('✅ Driver search saved to Firestore:', {
        documentId: firestoreResult?.documentId,
        driverName: firestoreResult?.driverName,
        driverPhotoUrl: firestoreResult?.driverPhotoUrl,
        searchId: memorySearch.searchId
      });
      return memorySearch;
      
    } catch (error) {
      console.error('❌ Error in addDriverSearch:', error);
      throw error;
    }
  }
  
  // ========== ADD PASSENGER SEARCH WITH DUPLICATE PREVENTION ==========
  
  async addPassengerSearch(searchData) {
    try {
      console.log('👤 SearchService.addPassengerSearch called with:');
      console.log('  passengerName:', searchData.passengerName);
      console.log('  passengerPhone:', searchData.passengerPhone);
      console.log('  passengerPhotoUrl:', searchData.passengerPhotoUrl || searchData.passengerPhoto);
      console.log('  All keys:', Object.keys(searchData));
      
      // ✅ CRITICAL: CHECK FOR DUPLICATE BEFORE PROCESSING
      const phone = searchData.passengerPhone || searchData.userId;
      const existingSearch = this.getActiveSearchByPhone(phone);
      
      if (existingSearch) {
        const timeSinceLastSearch = Date.now() - existingSearch.lastUpdated;
        
        // If last search was less than 10 seconds ago, return existing search
        if (timeSinceLastSearch < 10000) {
          console.log(`⏱️ Skipping duplicate passenger search for ${phone} (${Math.round(timeSinceLastSearch/1000)}s ago)`);
          console.log(`🔄 Returning existing search ID: ${existingSearch.searchId}`);
          this.logDuplicateAttempt(phone, 'passenger', timeSinceLastSearch);
          return existingSearch;
        }
        
        // If it's been more than 10 seconds but less than 2 minutes, update existing
        if (timeSinceLastSearch < 120000) {
          console.log(`🔄 Updating existing passenger search for ${phone} (${Math.round(timeSinceLastSearch/1000)}s old)`);
          
          // Update the existing search
          const updatedSearch = {
            ...existingSearch,
            ...searchData,
            lastUpdated: Date.now(),
            // Preserve the original searchId
            searchId: existingSearch.searchId,
            // Increment update count
            updateCount: (existingSearch.updateCount || 0) + 1
          };
          
          activeSearches.set(phone, updatedSearch);
          
          // Try to update in Firestore, but don't crash if it fails
          await this.updateExistingSearchInFirestore(phone, searchData, 'passenger');
          
          return updatedSearch;
        }
        
        // Otherwise, remove the old search and continue
        console.log(`🧹 Removing stale passenger search for ${phone} (${Math.round(timeSinceLastSearch/1000)}s old)`);
        this.stopUserSearch(phone, 'stale_replace');
      }
      
      // Check rate limiting
      this.checkRateLimit(phone);
      
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
        searchId: memorySearch.searchId,
        status: 'searching',
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        updateCount: 0
      });
      
      console.log('✅ Passenger search saved to Firestore:', {
        documentId: firestoreResult?.documentId,
        passengerName: firestoreResult?.passengerName,
        passengerPhotoUrl: firestoreResult?.passengerPhotoUrl || 'No photo saved',
        searchId: memorySearch.searchId
      });
      return memorySearch;
      
    } catch (error) {
      console.error('❌ Error in addPassengerSearch:', error);
      throw error;
    }
  }
  
  // ========== DUPLICATE PREVENTION HELPER METHODS ==========
  
  // Check for active search by phone number
  getActiveSearchByPhone(phone) {
    // Check in activeSearches map
    for (const [userId, search] of activeSearches.entries()) {
      if ((search.userType === 'passenger' && search.passengerPhone === phone) ||
          (search.userType === 'driver' && search.driverPhone === phone) ||
          userId === phone) {
        return search;
      }
    }
    return null;
  }
  
  // Update existing search in Firestore - SAFE VERSION
  async updateExistingSearchInFirestore(phone, updatedData, userType) {
    try {
      // Firestore updates for existing searches are optional
      // If the method doesn't exist, we just skip it
      if (typeof this.firestoreService.updateSearch === 'function') {
        // Only update if significant changes
        const significantChanges = ['pickupLocation', 'destinationLocation', 'routePoints', 
                                   'passengerCount', 'capacity', 'estimatedFare'];
        const needsFirestoreUpdate = significantChanges.some(field => 
          updatedData[field] && JSON.stringify(updatedData[field]) !== JSON.stringify({})
        );
        
        if (needsFirestoreUpdate) {
          await this.firestoreService.updateSearch(phone, {
            ...updatedData,
            lastUpdated: new Date().toISOString(),
            updateCount: (updatedData.updateCount || 0) + 1
          });
          console.log(`📝 Updated Firestore search for ${phone} (${userType})`);
        }
      } else {
        // Method doesn't exist, just log and continue
        console.log(`ℹ️ Firestore update not available for ${phone} (${userType}) - continuing with memory update`);
      }
    } catch (error) {
      // Don't throw error, just log it and continue
      console.log(`⚠️ Could not update Firestore for ${phone}: ${error.message}`);
    }
  }
  
  // Rate limiting check
  checkRateLimit(userId) {
    const now = Date.now();
    const lastSearch = this.searchCooldowns.get(userId);
    
    if (lastSearch) {
      const timeSinceLastSearch = now - lastSearch.timestamp;
      const minInterval = lastSearch.count > 3 ? 30000 : 10000; // Increase interval if spamming
      
      if (timeSinceLastSearch < minInterval) {
        const waitTime = Math.ceil((minInterval - timeSinceLastSearch) / 1000);
        throw new Error(`Please wait ${waitTime} seconds before searching again`);
      }
      
      // Update count
      lastSearch.count += 1;
      lastSearch.timestamp = now;
      
      // Reset count after 1 minute
      if (now - lastSearch.firstSearch > 60000) {
        lastSearch.count = 1;
        lastSearch.firstSearch = now;
      }
    } else {
      // First search
      this.searchCooldowns.set(userId, {
        timestamp: now,
        count: 1,
        firstSearch: now
      });
    }
  }
  
  // Log duplicate attempts
  logDuplicateAttempt(phone, userType, timeSinceLastSearch) {
    const key = `${phone}_${userType}`;
    const count = this.duplicateDetectionLog.get(key) || 0;
    this.duplicateDetectionLog.set(key, count + 1);
    
    // Log warning if many duplicates detected
    if (count >= 5) {
      console.warn(`🚨 HIGH DUPLICATE RATE: ${phone} (${userType}) has ${count+1} duplicate attempts`);
    }
  }
  
  // ========== STORE SEARCH IN MEMORY (UPDATED WITH DUPLICATION CHECK) ==========
  
  storeSearchInMemory(searchData) {
    const { userId, userType, rideType = 'immediate' } = searchData;
    
    if (!userId) throw new Error('userId is required');
    
    // Check if already exists
    const existingSearch = activeSearches.get(userId);
    const now = Date.now();
    
    // If exists and recent, update it instead of creating new
    if (existingSearch && existingSearch.rideType === rideType) {
      const timeDiff = now - existingSearch.lastUpdated;
      
      // Update existing if less than 30 seconds old
      if (timeDiff < 30000) {
        console.log(`🔄 Updating existing memory search for ${userId} (${Math.round(timeDiff/1000)}s old)`);
        
        const updatedSearch = {
          ...existingSearch,
          ...searchData,
          lastUpdated: now,
          // Keep original searchId
          searchId: existingSearch.searchId,
          // Preserve original creation time
          createdAt: existingSearch.createdAt,
          // Increment update count
          updateCount: (existingSearch.updateCount || 0) + 1
        };
        
        activeSearches.set(userId, updatedSearch);
        return updatedSearch;
      }
    }
    
    // ✅ Extract photos - supporting both formats
    const { passengerPhoto, passengerPhotoUrl, driverPhoto, driverPhotoUrl } = searchData;
    
    // Generate unique search ID
    const timestamp = Date.now();
    const randomSuffix = Math.floor(Math.random() * 1000);
    const searchId = searchData.searchId || `search_${timestamp}_${randomSuffix}`;
    
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
      
      // Phone numbers for duplicate detection
      driverPhone: searchData.driverPhone,
      passengerPhone: searchData.passengerPhone,
      
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
      searchId: searchId,
      status: 'searching',
      lastUpdated: now,
      createdAt: searchData.createdAt || new Date().toISOString(),
      updateCount: 0
    };
    
    activeSearches.set(userId, enhancedSearchData);
    
    // Set timeout for immediate searches
    if (rideType === 'immediate') {
      this.setImmediateSearchTimeout(userId, enhancedSearchData.searchId);
    }
    
    console.log(`🎯 ${rideType.toUpperCase()} search stored: ${enhancedSearchData.driverName || enhancedSearchData.passengerName}`);
    console.log(`📸 Photo: ${enhancedSearchData.userPhoto || 'No photo'}`);
    console.log(`🔑 Search ID: ${enhancedSearchData.searchId}`);
    
    return enhancedSearchData;
  }
  
  // ========== EXISTING METHODS ==========
  
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
      'system': 'Search stopped by system',
      'stale_replace': 'Replaced stale search with new one'
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
          lastUpdated: search.lastUpdated,
          updateCount: search.updateCount || 0
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
        searchId: memorySearch.searchId,
        lastUpdated: memorySearch.lastUpdated,
        updateCount: memorySearch.updateCount || 0
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
  
  // ========== CLEANUP AND MAINTENANCE METHODS ==========
  
  // Start cleanup interval
  startCleanupInterval() {
    // Run cleanup every 30 seconds
    setInterval(() => {
      this.cleanupOldData();
      this.cleanupCooldowns();
      this.logDuplicateStats();
    }, 30000);
    
    console.log('✅ Started SearchService cleanup interval (30s)');
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
        this.clearSearchTimeout(userId);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      console.log(`🧹 Cleaned ${cleanedCount} old active searches`);
    }
  }
  
  // Clean up cooldown data
  cleanupCooldowns() {
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    
    for (const [userId, data] of this.searchCooldowns.entries()) {
      if (data.timestamp < oneHourAgo) {
        this.searchCooldowns.delete(userId);
      }
    }
    
    // Clean duplicate detection log
    for (const [key, count] of this.duplicateDetectionLog.entries()) {
      if (count > 100) {
        // Reset if too high
        this.duplicateDetectionLog.set(key, 0);
      }
    }
  }
  
  // Log duplicate statistics
  logDuplicateStats() {
    const totalDuplicates = Array.from(this.duplicateDetectionLog.values())
      .reduce((sum, count) => sum + count, 0);
    
    if (totalDuplicates > 0) {
      const highDuplicateUsers = Array.from(this.duplicateDetectionLog.entries())
        .filter(([key, count]) => count > 5)
        .map(([key, count]) => `${key}: ${count} duplicates`);
      
      if (highDuplicateUsers.length > 0) {
        console.log(`⚠️ Duplicate Detection Stats:`);
        console.log(`   Total duplicate attempts prevented: ${totalDuplicates}`);
        console.log(`   High duplicate users: ${highDuplicateUsers.join(', ')}`);
      }
    }
  }
  
  // Count searches by phone (for duplicate detection)
  countSearchesByPhone(phone) {
    let count = 0;
    for (const search of activeSearches.values()) {
      if ((search.userType === 'passenger' && search.passengerPhone === phone) ||
          (search.userType === 'driver' && search.driverPhone === phone)) {
        count++;
      }
    }
    return count;
  }
  
  // Get statistics
  getStats() {
    const activeSearchArray = Array.from(activeSearches.values());
    const duplicateCount = Array.from(this.duplicateDetectionLog.values())
      .reduce((sum, count) => sum + count, 0);
    
    return {
      activeSearches: activeSearches.size,
      searchTimeouts: searchTimeouts.size,
      processedMatches: this.processedMatches.size,
      userMatches: this.userMatches.size,
      duplicatePreventions: duplicateCount,
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
    this.searchCooldowns.clear();
    this.duplicateDetectionLog.clear();
    
    console.log(`🧹 Cleared all searches (${count} active searches removed)`);
    return count;
  }
  
  // Force remove a specific search (for debugging)
  forceRemoveSearch(userId) {
    if (activeSearches.has(userId)) {
      const search = activeSearches.get(userId);
      activeSearches.delete(userId);
      this.clearSearchTimeout(userId);
      console.log(`🧹 Force removed search for ${userId} (${search.searchId})`);
      return true;
    }
    return false;
  }
}

module.exports = SearchService;
