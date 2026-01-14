// GlobalLocationService.js - FIXED VERSION
class GlobalLocationService {
  constructor() {
    // Memory storage for ALL users
    this.allUsers = new Map();      // userId -> {userType, location, info, trip, status}
    
    // Active connections
    this.connections = new Map();   // userId -> {ws, userType, info, status}
    
    // Grid-based spatial index
    this.locationGrid = new Map();  // "lat,lng" -> [userIds]
    
    // Match-specific location sharing
    this.matchSessions = new Map(); // matchId -> {driverId, passengerId}
    
    // TRACK SEARCH STATUS - NEW
    this.searchingPassengers = new Set();  // Passengers actively searching
    this.searchingDrivers = new Set();     // Drivers actively searching
    this.matchedPassengers = new Set();    // Passengers who are matched/accepted
    
    console.log('🌍 GlobalLocationService initialized (With Privacy Rules)');
  }
  
  // ==================== USER CONNECTION MANAGEMENT ====================
  
  addConnection(userId, ws, userType, userInfo, searchInfo = null) {
    const status = searchInfo?.isSearching ? 'searching' : 'idle';
    
    this.connections.set(userId, {
      ws,
      userType,
      info: userInfo,
      status,
      searchInfo,
      lastHeartbeat: Date.now(),
      location: null,
      trip: null
    });
    
    // Track search status
    if (userType === 'driver') {
      this.allUsers.set(userId, {
        userType,
        location: null,
        info: userInfo,
        trip: searchInfo?.trip || null,
        status: 'searching',  // Drivers are always visible when searching
        lastUpdate: Date.now()
      });
      
      this.searchingDrivers.add(userId);
      console.log(`🚗 DRIVER ${userId} connected (ALWAYS VISIBLE)`);
      
    } else if (userType === 'passenger') {
      if (status === 'searching') {
        // Passenger is searching - add to visible list
        this.allUsers.set(userId, {
          userType,
          location: null,
          info: userInfo,
          trip: searchInfo?.trip || null,
          status: 'searching',
          lastUpdate: Date.now()
        });
        
        this.searchingPassengers.add(userId);
        console.log(`👤 PASSENGER ${userId} connected (VISIBLE WHILE SEARCHING)`);
      } else {
        // Passenger is not searching (maybe just opening app)
        this.allUsers.set(userId, {
          userType,
          location: null,
          info: userInfo,
          trip: null,
          status: 'idle',
          lastUpdate: Date.now()
        });
        console.log(`👤 PASSENGER ${userId} connected (NOT VISIBLE - idle)`);
      }
    }
    
    // Send initial data about other users
    this.sendInitialData(userId, userType);
  }
  
  removeConnection(userId) {
    const connection = this.connections.get(userId);
    if (connection) {
      console.log(`📡 ${connection.userType.toUpperCase()} ${userId} disconnected`);
      
      // Clean up from tracking
      this.allUsers.delete(userId);
      this.removeFromGrid(userId);
      
      if (connection.userType === 'driver') {
        this.searchingDrivers.delete(userId);
        // Notify all passengers that driver is gone
        this.broadcastDriverRemoved(userId);
      } else {
        this.searchingPassengers.delete(userId);
        this.matchedPassengers.delete(userId);
        // Notify all drivers that passenger is gone
        this.broadcastPassengerRemoved(userId, 'disconnected');
      }
    }
    
    this.connections.delete(userId);
  }
  
  // ==================== LOCATION UPDATES ====================
  
  updateUserLocation(userId, locationData, userType, tripInfo = null) {
    try {
      const connection = this.connections.get(userId);
      if (!connection) return false;
      
      // Update connection info
      connection.location = {
        lat: locationData.latitude,
        lng: locationData.longitude,
        accuracy: locationData.accuracy || 0,
        heading: locationData.heading || 0,
        speed: locationData.speed || 0,
        timestamp: Date.now()
      };
      
      if (tripInfo) connection.trip = tripInfo;
      connection.lastHeartbeat = Date.now();
      
      // Round coordinates for grid
      const roundedLat = Math.round(locationData.latitude * 10000) / 10000;
      const roundedLng = Math.round(locationData.longitude * 10000) / 10000;
      const gridKey = `${roundedLat.toFixed(4)},${roundedLng.toFixed(4)}`;
      
      // Update storage based on visibility rules
      if (userType === 'driver') {
        // Drivers are always visible when searching
        this.allUsers.set(userId, {
          userType,
          location: { lat: locationData.latitude, lng: locationData.longitude },
          info: connection.info,
          trip: connection.trip,
          status: 'searching',
          lastUpdate: Date.now()
        });
        
        // Update grid
        this.removeFromGrid(userId);
        this.addToGrid(userId, gridKey, userType);
        
        // Broadcast to ALL searching passengers
        this.broadcastDriverLocation(userId, {
          lat: locationData.latitude,
          lng: locationData.longitude,
          accuracy: locationData.accuracy || 0,
          trip: connection.trip,
          timestamp: Date.now()
        });
        
      } else if (userType === 'passenger') {
        // Check if passenger should be visible
        const shouldBeVisible = this.searchingPassengers.has(userId) && 
                               !this.matchedPassengers.has(userId);
        
        if (shouldBeVisible) {
          // Passenger is searching and not matched - visible to drivers
          this.allUsers.set(userId, {
            userType,
            location: { lat: locationData.latitude, lng: locationData.longitude },
            info: connection.info,
            trip: connection.trip,
            status: 'searching',
            lastUpdate: Date.now()
          });
          
          // Update grid
          this.removeFromGrid(userId);
          this.addToGrid(userId, gridKey, userType);
          
          // Broadcast to ALL searching drivers
          this.broadcastPassengerLocation(userId, {
            lat: locationData.latitude,
            lng: locationData.longitude,
            accuracy: locationData.accuracy || 0,
            trip: connection.trip,
            timestamp: Date.now()
          });
          
        } else {
          // Passenger is matched or idle - NOT visible globally
          // Only update connection data (for match sessions)
          connection.location = {
            lat: locationData.latitude,
            lng: locationData.longitude,
            accuracy: locationData.accuracy || 0,
            timestamp: Date.now()
          };
          
          // Remove from global map if they were previously visible
          if (this.allUsers.has(userId)) {
            this.allUsers.delete(userId);
            this.removeFromGrid(userId);
            this.broadcastPassengerRemoved(userId, 'matched');
          }
          
          console.log(`📍 PASSENGER ${userId} location updated (PRIVATE - matched)`);
        }
      }
      
      return true;
      
    } catch (error) {
      console.error('❌ Error updating location:', error);
      return false;
    }
  }
  
  // ==================== MATCH HANDLING ====================
  
  handleMatchCreated(matchId, driverId, passengerId) {
    console.log(`🤝 Match ${matchId}: Driver ${driverId} + Passenger ${passengerId}`);
    
    // Passenger is no longer visible globally
    this.matchedPassengers.add(passengerId);
    this.searchingPassengers.delete(passengerId);
    
    // Remove passenger from global map
    if (this.allUsers.has(passengerId)) {
      this.allUsers.delete(passengerId);
      this.removeFromGrid(passengerId);
    }
    
    // Notify all drivers that passenger is no longer available
    this.broadcastPassengerRemoved(passengerId, 'matched');
    
    // Start match-specific location sharing
    this.startMatchLocationSharing(matchId, driverId, passengerId);
    
    // Driver remains visible globally (can still pick up more passengers)
    console.log(`📍 Match ${matchId}: Driver ${driverId} stays visible, Passenger ${passengerId} disappears`);
  }
  
  handleDriverTripCompleted(driverId) {
    console.log(`✅ Driver ${driverId} trip completed`);
    
    // Remove driver from global map
    this.allUsers.delete(driverId);
    this.removeFromGrid(driverId);
    this.searchingDrivers.delete(driverId);
    
    // Notify all passengers
    this.broadcastDriverRemoved(driverId);
  }
  
  handlePassengerCancelledSearch(passengerId) {
    console.log(`❌ Passenger ${passengerId} cancelled search`);
    
    // Remove from searching set
    this.searchingPassengers.delete(passengerId);
    
    // Remove from global map
    if (this.allUsers.has(passengerId)) {
      this.allUsers.delete(passengerId);
      this.removeFromGrid(passengerId);
    }
    
    // Notify all drivers
    this.broadcastPassengerRemoved(passengerId, 'cancelled');
  }
  
  // ==================== TARGETED BROADCASTING ====================
  
  broadcastDriverLocation(driverId, locationData) {
    // Send driver location to ALL searching passengers
    this.searchingPassengers.forEach(passengerId => {
      if (passengerId !== driverId) {
        this.sendToUser(passengerId, {
          type: 'DRIVER_LOCATION_UPDATE',
          driverId: driverId,
          location: {
            lat: locationData.lat,
            lng: locationData.lng,
            accuracy: locationData.accuracy || 0
          },
          trip: locationData.trip,
          timestamp: locationData.timestamp,
          distance: this.calculateDistance(
            locationData.lat, locationData.lng,
            this.connections.get(passengerId)?.location?.lat || 0,
            this.connections.get(passengerId)?.location?.lng || 0
          )
        });
      }
    });
  }
  
  broadcastPassengerLocation(passengerId, locationData) {
    // Send passenger location to ALL searching drivers
    this.searchingDrivers.forEach(driverId => {
      if (driverId !== passengerId) {
        this.sendToUser(driverId, {
          type: 'PASSENGER_LOCATION_UPDATE',
          passengerId: passengerId,
          location: {
            lat: locationData.lat,
            lng: locationData.lng,
            accuracy: locationData.accuracy || 0
          },
          trip: locationData.trip,
          timestamp: locationData.timestamp,
          distance: this.calculateDistance(
            locationData.lat, locationData.lng,
            this.connections.get(driverId)?.location?.lat || 0,
            this.connections.get(driverId)?.location?.lng || 0
          )
        });
      }
    });
  }
  
  broadcastPassengerRemoved(passengerId, reason) {
    // Notify ALL drivers that passenger is no longer available
    this.searchingDrivers.forEach(driverId => {
      this.sendToUser(driverId, {
        type: 'PASSENGER_REMOVED',
        passengerId: passengerId,
        reason: reason,
        timestamp: Date.now(),
        message: `Passenger ${reason === 'matched' ? 'found a driver' : 'cancelled search'}`
      });
    });
  }
  
  broadcastDriverRemoved(driverId) {
    // Notify ALL passengers that driver is no longer available
    this.searchingPassengers.forEach(passengerId => {
      this.sendToUser(passengerId, {
        type: 'DRIVER_REMOVED',
        driverId: driverId,
        timestamp: Date.now(),
        message: 'Driver is no longer available'
      });
    });
  }
  
  // ==================== QUERY METHODS (FILTERED) ====================
  
  getNearbyUsers(lat, lng, radiusKm = 5, requestingUserType = null) {
    const nearby = [];
    const gridCells = this.getNearbyGridCells(lat, lng, radiusKm);
    
    gridCells.forEach(gridKey => {
      const usersInCell = this.locationGrid.get(gridKey) || [];
      usersInCell.forEach(({ userId, userType }) => {
        // Filter based on visibility rules
        if (requestingUserType === 'driver') {
          // Drivers only see SEARCHING passengers
          if (userType !== 'passenger') return;
          if (!this.searchingPassengers.has(userId)) return;
          if (this.matchedPassengers.has(userId)) return;
        } else if (requestingUserType === 'passenger') {
          // Passengers only see SEARCHING drivers
          if (userType !== 'driver') return;
          if (!this.searchingDrivers.has(userId)) return;
        }
        
        const userData = this.allUsers.get(userId);
        if (userData && userData.location) {
          const distance = this.calculateDistance(lat, lng, userData.location.lat, userData.location.lng);
          if (distance <= radiusKm) {
            nearby.push({
              userId,
              userType,
              location: userData.location,
              distance,
              info: userData.info,
              trip: userData.trip,
              status: userData.status,
              lastUpdate: userData.lastUpdate
            });
          }
        }
      });
    });
    
    return nearby.sort((a, b) => a.distance - b.distance);
  }
  
  getAllUsers(requestingUserType = null) {
    const users = [];
    
    this.allUsers.forEach((userData, userId) => {
      // Apply visibility filters
      if (requestingUserType === 'driver') {
        if (userData.userType !== 'passenger') return;
        if (!this.searchingPassengers.has(userId)) return;
        if (this.matchedPassengers.has(userId)) return;
      } else if (requestingUserType === 'passenger') {
        if (userData.userType !== 'driver') return;
        if (!this.searchingDrivers.has(userId)) return;
      }
      
      users.push({
        userId,
        userType: userData.userType,
        location: userData.location,
        lastUpdate: userData.lastUpdate,
        trip: userData.trip,
        info: userData.info,
        status: userData.status
      });
    });
    
    return users;
  }
  
  sendInitialData(userId, userType) {
    const oppositeType = userType === 'driver' ? 'passenger' : 'driver';
    const allUsers = this.getAllUsers(userType); // Pass requesting user type for filtering
    
    this.sendToUser(userId, {
      type: 'INITIAL_USERS_DATA',
      userType: oppositeType,
      users: allUsers.map(user => ({
        userId: user.userId,
        location: user.location,
        trip: user.trip,
        info: user.info,
        status: user.status,
        lastUpdate: user.lastUpdate
      })),
      timestamp: Date.now(),
      message: `Loaded ${allUsers.length} ${oppositeType}s`
    });
  }
  
  // ==================== EXISTING METHODS (keep as is) ====================
  
  addToGrid(userId, gridKey, userType) {
    if (!this.locationGrid.has(gridKey)) {
      this.locationGrid.set(gridKey, []);
    }
    
    const usersInCell = this.locationGrid.get(gridKey);
    if (!usersInCell.some(u => u.userId === userId)) {
      usersInCell.push({ userId, userType });
    }
  }
  
  removeFromGrid(userId) {
    for (const [gridKey, users] of this.locationGrid.entries()) {
      const index = users.findIndex(u => u.userId === userId);
      if (index > -1) {
        users.splice(index, 1);
        if (users.length === 0) this.locationGrid.delete(gridKey);
      }
    }
  }
  
  getNearbyGridCells(lat, lng, radiusKm = 5) {
    const cells = [];
    const gridPrecision = 0.0001;
    const radiusInDegrees = radiusKm / 111;
    
    const centerLat = Math.round(lat / gridPrecision) * gridPrecision;
    const centerLng = Math.round(lng / gridPrecision) * gridPrecision;
    const steps = Math.ceil(radiusInDegrees / gridPrecision);
    
    for (let latStep = -steps; latStep <= steps; latStep++) {
      for (let lngStep = -steps; lngStep <= steps; lngStep++) {
        const cellLat = centerLat + (latStep * gridPrecision);
        const cellLng = centerLng + (lngStep * gridPrecision);
        const gridKey = `${cellLat.toFixed(4)},${cellLng.toFixed(4)}`;
        cells.push(gridKey);
      }
    }
    
    return cells;
  }
  
  startMatchLocationSharing(matchId, driverId, passengerId) {
    // ... (keep existing match sharing logic)
  }
  
  updateMatchLocation(matchId, userId, locationData) {
    // ... (keep existing match sharing logic)
  }
  
  sendToUser(userId, message) {
    // ... (keep existing)
  }
  
  calculateDistance(lat1, lon1, lat2, lon2) {
    // ... (keep existing)
  }
  
  toRad(degrees) {
    return degrees * (Math.PI / 180);
  }
  
  cleanupStaleConnections(maxAge = 30000) {
    // ... (keep existing)
  }
  
  getStats() {
    return {
      totalConnections: this.connections.size,
      totalVisibleUsers: this.allUsers.size,
      searchingDrivers: this.searchingDrivers.size,
      searchingPassengers: this.searchingPassengers.size,
      matchedPassengers: this.matchedPassengers.size,
      activeMatchSessions: this.matchSessions.size,
      gridCells: this.locationGrid.size
    };
  }
}

module.exports = GlobalLocationService;
