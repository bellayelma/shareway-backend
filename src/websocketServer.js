const WebSocket = require('ws');
const { Firestore } = require('@google-cloud/firestore');
const admin = require('firebase-admin');

class WebSocketServer {
  constructor(server, firestoreService, matchingService = null, realtimeLocationService = null) {
    if (!admin.apps.length) {
      try {
        admin.initializeApp({
          credential: admin.credential.applicationDefault(),
          projectId: process.env.GOOGLE_CLOUD_PROJECT || 'shareway-6c38b'
        });
      } catch (e) {}
    }
    
    this.firestore = admin.firestore();
    this.firestoreService = firestoreService;
    this.matchingService = matchingService;
    this.realtimeLocationService = realtimeLocationService;
    
    // Initialize memory storages
    this.memoryLocations = new Map();
    this.locationSessions = new Map();
    this.sessionSubscriptions = new Map();
    this.driverSessions = new Map();
    this.locationSubscriptions = new Map();
    this.driverLocations = new Map();
    this.trackingModes = new Map();
    this.activeSessions = new Map();
    this.connectedUsers = new Map();
    this.phoneToUidCache = new Map();
    this.uidToPhoneCache = new Map();
    
    // Create WebSocket server
    this.wss = new WebSocket.Server({ noServer: true, clientTracking: true });
    
    // Handle HTTP upgrade
    if (server) {
      server.on('upgrade', (req, socket, head) => {
        const url = require('url');
        const parsedUrl = url.parse(req.url, true);
        
        if (parsedUrl.pathname !== '/ws') {
          socket.destroy();
          return;
        }
        
        // Allow all origins in development
        if (process.env.NODE_ENV !== 'production') {
          this.wss.handleUpgrade(req, socket, head, (ws) => {
            this.wss.emit('connection', ws, req);
          });
          return;
        }
        
        // Check origin in production
        const origin = req.headers.origin;
        const allowedOrigins = [
          'http://localhost:8082', 'http://127.0.0.1:8082', 'http://localhost:3000',
          'http://127.0.0.1:3000', 'http://localhost:8081', 'http://localhost:8080',
          'http://10.0.2.2:8082', 'http://10.0.2.2:3000',
          null, undefined, 'null'
        ];
        
        if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('null')) {
          this.wss.handleUpgrade(req, socket, head, (ws) => {
            this.wss.emit('connection', ws, req);
          });
        } else {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
        }
      });
    }
    
    // Setup WebSocket handlers
    this.setupWebSocket();
    
    // Setup cleanup intervals
    setInterval(() => this.cleanupStaleConnections(), 300000);
    setInterval(() => this.cleanupOldLocations(), 120000);
    setInterval(() => this.broadcastTrackingStatus(), 30000);
    setInterval(() => this.cleanupExpiredSessions(), 60000);
    
    console.log('🔌 WebSocketServer initialized');
    console.log('✅ MatchingService available:', !!matchingService);
  }

  // ==================== UTILITY METHODS ====================
  
  getServerTimestamp() {
    return admin.firestore.FieldValue.serverTimestamp();
  }

  isPhoneNumber(str) {
    if (!str) return false;
    str = str.toString().trim();
    
    // Skip Firebase UIDs
    if (str.length === 28 && /^[A-Za-z0-9_-]{28}$/.test(str)) return false;
    if (str.includes('passenger_') || str.includes('driver_') || str.includes('test_') || (str.includes('_') && str.length > 20)) return false;
    
    // Phone number patterns
    const patterns = [
      /^\+251[1-9]\d{8}$/,    // +251XXXXXXXXX
      /^251[1-9]\d{8}$/,      // 251XXXXXXXXX
      /^09[1-9]\d{7}$/,       // 09XXXXXXXX
      /^9[1-9]\d{7}$/,        // 9XXXXXXXX
      /^\d{10,15}$/           // 10-15 digits
    ];
    
    return patterns.some(pattern => pattern.test(str));
  }

  formatPhoneNumber(phone) {
    if (!phone) return null;
    phone = phone.toString().trim();
    let digits = phone.replace(/\D/g, '');
    
    if (digits.length === 0) return phone;
    if (digits.startsWith('251') && digits.length === 12) return `+${digits}`;
    if (digits.startsWith('09') && digits.length === 10) return `+251${digits.substring(1)}`;
    if (digits.startsWith('9') && digits.length === 9) return `+251${digits}`;
    
    return phone.startsWith('+') ? phone : `+${phone}`;
  }

  // ==================== NEW: PASSENGER LOCATION BROADCASTING ====================
  
  async broadcastSearchingPassengersToDriver(driverId) {
    try {
      console.log(`🔍 Broadcasting searching passengers to driver: ${driverId}`);
      
      // Check if driver is connected
      if (!this.connectedUsers.has(driverId)) {
        console.log(`⚠️ Driver ${driverId} not connected`);
        return;
      }
      
      // Get active passenger searches from Firestore
      const passengerSearches = await this.firestore.collection('active_searches_passenger')
        .where('status', 'in', ['searching', 'matched', 'proposed'])
        .limit(10)
        .get();
      
      if (passengerSearches.empty) {
        console.log(`📭 No searching passengers found for driver ${driverId}`);
        return;
      }
      
      const searchingPassengers = [];
      
      for (const doc of passengerSearches.docs) {
        const passengerData = doc.data();
        const passengerId = doc.id;
        
        // Get passenger details
        const passengerDetails = await this.getActualUserDetails(passengerId, 'passenger');
        
        // Only include if passenger has location
        if (passengerData.currentLocation || passengerData.pickupLocation) {
          searchingPassengers.push({
            userId: passengerId,
            name: passengerDetails.name || 'Passenger',
            phone: passengerDetails.phone || passengerId,
            rating: passengerDetails.rating || 4.0,
            location: passengerData.currentLocation || passengerData.pickupLocation,
            pickupName: passengerData.pickupName || 'Pickup Location',
            destinationName: passengerData.destinationName || 'Destination',
            estimatedFare: passengerData.estimatedFare || 0,
            passengerCount: passengerData.passengerCount || 1,
            searchId: passengerData.searchId,
            timestamp: Date.now()
          });
        }
      }
      
      if (searchingPassengers.length > 0) {
        // Send to driver
        await this.sendToUser(driverId, {
          type: 'SEARCHING_PASSENGERS_UPDATE',
          data: {
            passengers: searchingPassengers,
            count: searchingPassengers.length,
            timestamp: Date.now(),
            message: `${searchingPassengers.length} passengers searching nearby`
          }
        });
        
        console.log(`📤 Sent ${searchingPassengers.length} searching passengers to driver ${driverId}`);
      }
      
    } catch (error) {
      console.error('❌ Error broadcasting searching passengers:', error);
    }
  }
  
  async handlePassengerSearchUpdate(passengerId, passengerData) {
    try {
      console.log(`🔍 Passenger search update: ${passengerId}`);
      
      // Get all connected drivers
      const connectedDrivers = [];
      
      for (const [userId, userInfo] of this.connectedUsers.entries()) {
        if (userInfo.role === 'driver' && userInfo.ws.readyState === WebSocket.OPEN) {
          connectedDrivers.push(userId);
        }
      }
      
      if (connectedDrivers.length === 0) {
        return;
      }
      
      // Get passenger details
      const passengerDetails = await this.getActualUserDetails(passengerId, 'passenger');
      
      // Prepare passenger update message
      const passengerUpdate = {
        userId: passengerId,
        name: passengerDetails.name || 'Passenger',
        phone: passengerDetails.phone || passengerId,
        rating: passengerDetails.rating || 4.0,
        location: passengerData.currentLocation || passengerData.pickupLocation,
        pickupName: passengerData.pickupName || 'Pickup Location',
        destinationName: passengerData.destinationName || 'Destination',
        estimatedFare: passengerData.estimatedFare || 0,
        passengerCount: passengerData.passengerCount || 1,
        searchId: passengerData.searchId,
        timestamp: Date.now(),
        action: passengerData.status === 'searching' ? 'started_searching' : 'updated_location'
      };
      
      // Send to all connected drivers
      for (const driverId of connectedDrivers) {
        await this.sendToUser(driverId, {
          type: 'PASSENGER_SEARCH_UPDATE',
          data: passengerUpdate
        });
      }
      
      console.log(`📤 Broadcasted passenger ${passengerId} update to ${connectedDrivers.length} drivers`);
      
    } catch (error) {
      console.error('❌ Error handling passenger search update:', error);
    }
  }
  
  async broadcastPassengerLocationToDrivers(passengerId, locationData) {
    try {
      // Get all connected drivers
      const connectedDrivers = [];
      
      for (const [userId, userInfo] of this.connectedUsers.entries()) {
        if (userInfo.role === 'driver' && userInfo.ws.readyState === WebSocket.OPEN) {
          connectedDrivers.push(userId);
        }
      }
      
      if (connectedDrivers.length === 0) {
        return;
      }
      
      // Get passenger details
      const passengerDetails = await this.getActualUserDetails(passengerId, 'passenger');
      
      // Prepare location update message
      const locationUpdate = {
        userId: passengerId,
        name: passengerDetails.name || 'Passenger',
        location: {
          lat: locationData.latitude,
          lng: locationData.longitude
        },
        accuracy: locationData.accuracy || 0,
        timestamp: Date.now(),
        isSearching: true
      };
      
      // Send to all connected drivers
      for (const driverId of connectedDrivers) {
        await this.sendToUser(driverId, {
          type: 'PASSENGER_LOCATION_UPDATE',
          data: locationUpdate
        });
      }
      
    } catch (error) {
      console.error('❌ Error broadcasting passenger location:', error);
    }
  }

  async updatePassengerSearchLocation(passengerId, locationData) {
    try {
      const formattedPassengerId = this.formatPhoneNumber(passengerId);
      
      await this.firestore.collection('active_searches_passenger')
        .doc(formattedPassengerId)
        .update({
          currentLocation: {
            lat: locationData.latitude,
            lng: locationData.longitude
          },
          locationUpdatedAt: Date.now(),
          lastUpdated: Date.now()
        });
      
      console.log(`📍 Updated passenger search location: ${passengerId}`);
      
    } catch (error) {
      console.error('Error updating passenger search location:', error);
    }
  }

  // ==================== ACTUAL DATA FETCHING METHODS ====================
  
  async getActualUserDetails(userId, userType) {
    try {
      const formattedUserId = this.formatPhoneNumber(userId);
      let userData = {};
      
      // Check cache first
      if (userType === 'driver' && this.connectedUsers.has(userId)) {
        const cached = this.connectedUsers.get(userId);
        if (cached.userDetails) return cached.userDetails;
      }
      
      // Try to get from users collection first
      const usersRef = this.firestore.collection('users');
      const userQuery = await usersRef.where('phone', '==', formattedUserId).limit(1).get();
      
      if (!userQuery.empty) {
        const userDoc = userQuery.docs[0];
        const data = userDoc.data();
        userData = {
          id: userDoc.id,
          name: data.name || data.fullName || data.displayName || (userType === 'driver' ? 'Driver' : 'Passenger'),
          phone: data.phone || formattedUserId,
          email: data.email || '',
          photoUrl: data.photoURL || data.profileImage || data.photoUrl || '',
          rating: data.rating || data.averageRating || (userType === 'driver' ? 4.5 : 4.0)
        };
        
        // For drivers, get additional info
        if (userType === 'driver') {
          const driverDoc = await this.firestore.collection('drivers').doc(userDoc.id).get();
          if (driverDoc.exists) {
            const driverData = driverDoc.data();
            userData.vehicleInfo = driverData.vehicleInfo || {};
            userData.driverRating = driverData.driverRating || data.rating || 4.5;
            userData.totalRides = driverData.totalRides || 0;
            userData.driverName = driverData.driverName || data.name || 'Driver';
          }
        }
        
        // For passengers, get additional info
        if (userType === 'passenger') {
          userData.passengerName = data.name || 'Passenger';
        }
      } else {
        // If not found in users, check drivers/passengers directly
        if (userType === 'driver') {
          const driverDoc = await this.firestore.collection('drivers').doc(userId).get();
          if (driverDoc.exists) {
            const data = driverDoc.data();
            userData = {
              id: driverDoc.id,
              name: data.driverName || data.name || 'Driver',
              phone: data.phone || formattedUserId,
              photoUrl: data.driverPhotoUrl || data.photoUrl || '',
              rating: data.driverRating || 4.5,
              vehicleInfo: data.vehicleInfo || {},
              totalRides: data.totalRides || 0
            };
          }
        }
      }
      
      // Cache for future use
      if (this.connectedUsers.has(userId)) {
        this.connectedUsers.get(userId).userDetails = userData;
      }
      
      return userData;
    } catch (error) {
      console.error('Error fetching user details:', error);
      return {
        id: userId,
        name: userType === 'driver' ? 'Driver' : 'Passenger',
        phone: this.formatPhoneNumber(userId) || userId,
        photoUrl: '',
        rating: userType === 'driver' ? 4.5 : 4.0,
        vehicleInfo: userType === 'driver' ? { model: 'Car', plate: 'Unknown' } : null
      };
    }
  }

  async getActualPassengerLocationFromDriver(driverId, passengerField) {
    try {
      const formattedDriverId = this.formatPhoneNumber(driverId);
      
      // Get driver's active search document
      const driverDoc = await this.firestore.collection('active_searches_driver')
        .doc(formattedDriverId).get();
      
      if (!driverDoc.exists) {
        return this.getDefaultLocation();
      }
      
      const driverData = driverDoc.data();
      const passengerData = driverData[passengerField];
      
      if (!passengerData) {
        return this.getDefaultLocation();
      }
      
      // Return ACTUAL passenger location data
      return {
        pickupLocation: passengerData.pickupLocation || passengerData.pickup?.location,
        pickupName: passengerData.pickupName || passengerData.pickup?.address || "Pickup",
        destinationLocation: passengerData.destinationLocation || passengerData.dropoff?.location,
        destinationName: passengerData.destinationName || passengerData.dropoff?.address || "Destination"
      };
    } catch (error) {
      console.error('Error fetching passenger location:', error);
      return this.getDefaultLocation();
    }
  }

  getDefaultLocation() {
    return {
      pickupLocation: { lat: 8.550023, lng: 39.266712 },
      pickupName: "Adama, Ethiopia",
      destinationLocation: { lat: 9.589549, lng: 41.866169 },
      destinationName: "Dire Dawa, Ethiopia"
    };
  }

  // ==================== SEARCH SCREEN REINITIALIZATION ====================
  
  async checkAndReinitializeSearchOnReconnect(userId, role) {
    try {
      console.log(`🔄 Checking active search for ${userId} (${role}) on reconnect...`);
      
      const collectionName = role === 'driver' 
        ? 'active_searches_driver' 
        : 'active_searches_passenger';
      
      const searchDoc = await this.firestore.collection(collectionName)
        .doc(userId)
        .get();
      
      if (!searchDoc.exists) {
        console.log(`📭 No active search found for ${userId}`);
        return;
      }
      
      const searchData = searchDoc.data();
      const status = searchData.status;
      
      // Only reinitialize if search is still active
      if (!['searching', 'matched', 'proposed', 'accepted'].includes(status)) {
        console.log(`📭 Search not active for ${userId}, status: ${status}`);
        return;
      }
      
      console.log(`🔄 Re-initializing search screen for ${userId} (${status})`);
      
      // Prepare search screen data
      const searchScreenData = {
        searchId: searchData.searchId,
        pickupName: searchData.pickupName || searchData.pickup?.address || "Pickup Location",
        destinationName: searchData.destinationName || searchData.dropoff?.address || "Destination",
        distance: searchData.distance || searchData.estimatedDistance || 0,
        fare: searchData.fare || searchData.estimatedFare || 0,
        duration: searchData.duration || searchData.estimatedDuration || 0,
        pickupLatLng: searchData.pickupLocation || searchData.currentLocation,
        destinationLatLng: searchData.destinationLocation,
        routePoints: searchData.routePoints || [],
        passengerCapacity: searchData.capacity || 4,
        driverId: role === 'driver' ? userId : searchData.driverId,
        driverName: searchData.driverName,
        driverPhone: searchData.driverPhone,
        vehicleInfo: searchData.vehicleInfo || {},
        estimatedDuration: searchData.estimatedDuration || 0,
        estimatedDistance: searchData.estimatedDistance || 0,
        estimatedFare: searchData.estimatedFare || 0
      };
      
      // Send SEARCH_STARTED to reinitialize the search screen
      const reinitMessage = {
        type: 'SEARCH_STARTED',
        data: {
          userId: userId,
          userType: role,
          searchId: searchData.searchId,
          searchData: searchData,
          timestamp: Date.now(),
          status: status,
          message: `Search reconnected - ${role === 'driver' ? 'looking for passengers' : 'looking for drivers'}...`,
          screen: 'search',
          shouldInitializeSearchScreen: true,
          location: searchData.currentLocation || searchData.pickupLocation,
          destination: searchData.destinationLocation,
          capacity: searchData.capacity || 4,
          routePoints: searchData.routePoints || [],
          searchScreenData: searchScreenData
        }
      };
      
      await this.sendToUser(userId, reinitMessage);
      console.log(`✅ Search screen reinitialized for ${userId}`);
      
      // Also send match info if user is in a match
      if (searchData.matchId) {
        await this.sendMatchStatusOnReconnect(userId, searchData.matchId);
      }
      
    } catch (error) {
      console.error('❌ Error re-initializing search on reconnect:', error);
    }
  }
  
  async sendMatchStatusOnReconnect(userId, matchId) {
    try {
      const matchDoc = await this.firestore.collection('active_matches')
        .doc(matchId)
        .get();
      
      if (!matchDoc.exists) return;
      
      const matchData = matchDoc.data();
      await this.sendToUser(userId, {
        type: 'MATCH_STATUS_UPDATE',
        data: {
          matchId: matchId,
          status: matchData.status,
          matchData: matchData,
          timestamp: Date.now(),
          shouldOpenMatchScreen: matchData.status === 'proposed' || matchData.status === 'accepted'
        }
      });
      
      console.log(`✅ Match status sent on reconnect for ${userId}, match: ${matchId}`);
    } catch (error) {
      console.error('❌ Error sending match status on reconnect:', error);
    }
  }

  async sendSearchStartedToUser(userId, message) {
    try {
      console.log(`📤 WebSocketServer: Forwarding ${message.type} to ${userId}`);
      
      // Fetch actual user data
      const userType = message.data?.userType || 'driver';
      const userDetails = await this.getActualUserDetails(userId, userType);
      
      // Enhance message with actual user data
      const enhancedMessage = {
        ...message,
        data: {
          ...message.data,
          userDetails: userDetails,
          timestamp: Date.now(),
          server: 'localhost:3000'
        }
      };
      
      const sent = await this.sendToUser(userId, enhancedMessage);
      
      if (sent) {
        console.log(`✅ ${message.type} sent to ${userId} with actual user data`);
      } else {
        console.log(`⚠️ User ${userId} not connected, message queued for later`);
      }
      
      return sent;
    } catch (error) {
      console.error('❌ Error forwarding SEARCH_STARTED:', error);
      return false;
    }
  }

  // ==================== WEB SOCKET MESSAGE HANDLING ====================
  
  async setupWebSocket() {
    this.wss.on('connection', async (ws, req) => {
      try {
        const url = require('url');
        const parsedUrl = url.parse(req.url, true);
        let originalUserId = parsedUrl.query.userId ? decodeURIComponent(parsedUrl.query.userId.trim()) : '';
        originalUserId = originalUserId.replace(/%2B/g, '+');
        const platform = parsedUrl.query.platform || 'flutter_web';
        const role = parsedUrl.query.role || 'unknown';
        
        if (!originalUserId) {
          ws.close(1008, 'User ID required');
          return;
        }
        
        // Format user ID
        let formattedUserId = originalUserId;
        let isPhone = false;
        
        if (this.isPhoneNumber(originalUserId)) {
          formattedUserId = this.formatPhoneNumber(originalUserId);
          isPhone = true;
        }
        
        const connectionKey = formattedUserId;
        
        // Close existing connection if same user connects again
        if (this.connectedUsers.has(connectionKey)) {
          const existing = this.connectedUsers.get(connectionKey);
          try {
            existing.ws.close(1000, 'New connection');
          } catch (e) {}
          this.connectedUsers.delete(connectionKey);
        }
        
        // Fetch actual user details
        let userDetails = {};
        try {
          userDetails = await this.getActualUserDetails(formattedUserId, role);
        } catch (e) {
          console.log('Using default user details for connection');
        }
        
        // Store connection info with user details
        this.connectedUsers.set(connectionKey, {
          ws,
          platform,
          connectedAt: new Date().toISOString(),
          lastActivity: Date.now(),
          role,
          isPhone,
          originalId: originalUserId,
          formattedId: formattedUserId,
          userDetails: userDetails,
          subscriptions: new Set()
        });
        
        // Send connection confirmation with ACTUAL user data
        try {
          ws.send(JSON.stringify({
            type: 'CONNECTED',
            data: {
              userId: formattedUserId,
              userProfile: userDetails,
              timestamp: Date.now(),
              message: `Connected as ${userDetails.name || role}`,
              platform,
              role,
              server: 'localhost:3000',
              path: '/ws',
              memoryOnlyLocation: true,
              realtimeLocationService: !!this.realtimeLocationService,
              bidirectionalSharing: true,
              hybridMode: true
            }
          }));
        } catch (e) {}
        
        // Cache phone-to-UID mapping
        if (isPhone) {
          try {
            const firebaseUid = await this.lookupFirebaseUidByPhone(formattedUserId);
            if (firebaseUid) {
              this.phoneToUidCache.set(formattedUserId, firebaseUid);
              this.uidToPhoneCache.set(firebaseUid, formattedUserId);
              // Store as alias connection
              this.connectedUsers.set(firebaseUid, {
                ws,
                platform,
                connectedAt: new Date().toISOString(),
                lastActivity: Date.now(),
                role,
                isPhone: false,
                originalId: firebaseUid,
                formattedId: formattedUserId,
                userDetails: userDetails,
                isAlias: true,
                subscriptions: new Set()
              });
            }
          } catch (e) {}
        }
        
        // ==================== NEW: SEND SEARCHING PASSENGERS TO DRIVER ====================
        if (role === 'driver') {
          console.log(`🚗 Driver connected: ${formattedUserId}`);
          
          // Send initial searching passengers after short delay
          setTimeout(async () => {
            await this.broadcastSearchingPassengersToDriver(formattedUserId);
          }, 2000);
          
          // Set up periodic updates
          const passengerUpdateInterval = setInterval(async () => {
            if (ws.readyState === WebSocket.OPEN) {
              await this.broadcastSearchingPassengersToDriver(formattedUserId);
            } else {
              clearInterval(passengerUpdateInterval);
            }
          }, 30000); // Every 30 seconds
        }
        
        // Check for active search and reinitialize search screen
        await this.checkAndReinitializeSearchOnReconnect(formattedUserId, role);
        
        // Handle incoming messages
        ws.on('message', async (data) => {
          try {
            const message = JSON.parse(data.toString());
            const userInfo = this.connectedUsers.get(connectionKey);
            if (userInfo) userInfo.lastActivity = Date.now();
            
            // 🔥 CHECK IF MATCHING SERVICE WANTS TO HANDLE THIS MESSAGE
            if (this.matchingService && 
                this.matchingService.globalLocationService &&
                await this.checkForGlobalLocationMessage(formattedUserId, message)) {
              // GlobalLocationService handled it
              return;
            }
            
            // 🔥 ORIGINAL HANDLERS (fallback)
            const handlers = {
              'PING': () => ws.send(JSON.stringify({
                type: 'PONG',
                timestamp: Date.now(),
                userId: formattedUserId
              })),
              
              'driver_connect': () => this.handleDriverConnect(formattedUserId, message),
              'driver_location': () => this.handleDriverLocation(formattedUserId, message),
              'subscribe_passenger': () => this.handleSubscribePassenger(formattedUserId, message),
              'unsubscribe_passenger': () => this.handleUnsubscribePassenger(formattedUserId, message),
              
              'SEARCH_STARTED': () => this.handleSearchStartedFromApp(formattedUserId, message),
              'GET_ACTIVE_SEARCH': () => this.handleGetActiveSearch(formattedUserId, message),
              
              // ==================== NEW: PASSENGER LOCATION HANDLERS ====================
              'LOCATION_UPDATE': () => this.handleLocationUpdate(formattedUserId, message.data || message),
              'GET_SEARCHING_PASSENGERS': () => this.broadcastSearchingPassengersToDriver(formattedUserId),
              
              // Location tracking
              'TRACKING_COMMAND': () => this.handleTrackingCommand(formattedUserId, message),
              'TRACKING_STATUS_REQUEST': () => this.handleTrackingStatusRequest(formattedUserId, message),
              'LOCATION_TRACKING_REQUEST': () => this.handleLocationTrackingRequest(formattedUserId, message),
              'ETA_CALCULATION_REQUEST': () => this.handleETACalculationRequest(formattedUserId, message),
              
              // Trip management
              'TRIP_STARTED': () => this.handleTripStarted(formattedUserId, message),
              'TRIP_COMPLETED': () => this.handleTripCompleted(formattedUserId, message),
              
              // Search management
              'DRIVER_STOP_SEARCH': () => this.handleDriverStopSearch(formattedUserId, message.data || message),
              'DRIVER_EXTEND_SEARCH_TIME': () => this.handleDriverExtendSearchTime(formattedUserId, message.data || message),
              'DRIVER_ENDED_SEARCH': () => this.handleDriverEndedSearch(formattedUserId, message.data || message),
              'SUBSCRIBE_PASSENGER_TRACKING': () => this.handleSubscribePassengerTracking(formattedUserId, message.data || message),
              'PASSENGER_STOP_SEARCH': () => this.handlePassengerStopSearch(formattedUserId, message.data || message),
              
              // Match management
              'ACCEPT_MATCH': () => this.handleAcceptMatch(formattedUserId, message.data || message),
              'DECLINE_MATCH': () => this.handleDeclineMatch(formattedUserId, message.data || message),
              'CANCEL_MATCH': () => this.handleCancelMatch(formattedUserId, message.data || message),
              'CANCEL_ACCEPTED_MATCH': () => this.handleCancelAcceptedMatch(formattedUserId, message.data || message),
              'MATCH_DECISION': () => this.handleLegacyMatchDecision(formattedUserId, message.data || message),
              'GET_MATCH_STATUS': () => this.handleGetMatchStatus(formattedUserId, message.data || message),
              
              // Notifications
              'MATCH_FOUND_NOTIFICATION': () => this.handleMatchFoundNotification(formattedUserId, message.data || message),
              
              // Location updates
              'PASSENGER_LOCATION': () => this.handlePassengerLocation(formattedUserId, message.data || message),
              'PARTNER_LOCATION': () => this.handlePartnerLocation(formattedUserId, message.data || message),
              
              // Legacy handlers (keep for compatibility)
              'SEARCH_STARTED': () => this.handleLegacySearchStarted(formattedUserId, message),
              'SEARCH_STATUS_UPDATE': () => this.handleSearchStatusUpdate(formattedUserId, message),
              'MATCH_ACCEPTED': () => this.handleMatchAccepted(formattedUserId, message),
              'MATCH_REJECTED': () => this.handleMatchRejected(formattedUserId, message),
              'MATCH_TIMEOUT': () => this.handleMatchTimeout(formattedUserId, message)
            };
            
            if (handlers[message.type]) {
              await handlers[message.type]();
            } else {
              // Acknowledge unknown message types
              try {
                ws.send(JSON.stringify({
                  type: 'MESSAGE_RECEIVED',
                  data: {
                    originalType: message.type,
                    timestamp: Date.now(),
                    message: 'Message received'
                  }
                }));
              } catch (e) {}
            }
            
          } catch (error) {
            console.error('❌ Error processing WebSocket message:', error);
            try {
              ws.send(JSON.stringify({
                type: 'ERROR',
                data: {
                  message: 'Failed to process message',
                  error: error.message,
                  timestamp: Date.now()
                }
              }));
            } catch (e) {}
          }
        });
        
        // Handle connection close
        ws.on('close', (code, reason) => {
          this.cleanupUserSubscriptions(formattedUserId);
          this.connectedUsers.delete(connectionKey);
          
          // Cleanup alias connections
          for (const [key, userInfo] of this.connectedUsers.entries()) {
            if (userInfo.formattedId === formattedUserId ||
                userInfo.originalId === originalUserId ||
                (userInfo.isAlias && userInfo.ws === ws)) {
              this.connectedUsers.delete(key);
            }
          }
        });
        
        ws.on('error', (error) => {
          this.cleanupUserSubscriptions(formattedUserId);
          this.connectedUsers.delete(connectionKey);
        });
        
        // Keep connection alive with pings
        const pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.ping();
            } catch (e) {
              clearInterval(pingInterval);
            }
          } else {
            clearInterval(pingInterval);
          }
        }, 30000);
        
        ws.on('pong', () => {
          const userInfo = this.connectedUsers.get(connectionKey);
          if (userInfo) userInfo.lastActivity = Date.now();
        });
        
      } catch (error) {
        try {
          ws.close(1011, 'Internal error');
        } catch (e) {}
      }
    });
    
    this.wss.on('error', (error) => console.error('WebSocket error:', error));
  }

  // ==================== NEW: LOCATION UPDATE HANDLER ====================

  async handleLocationUpdate(userId, data) {
    try {
      const { latitude, longitude, userType = 'passenger', isSearching = true } = data;
      
      console.log(`📍 ${userType.toUpperCase()} location update: ${userId} at ${latitude}, ${longitude}`);
      
      // Store in memory
      const locationData = {
        userId,
        location: { lat: latitude, lng: longitude },
        accuracy: data.accuracy || 0,
        heading: data.heading || 0,
        speed: data.speed || 0,
        timestamp: data.timestamp || Date.now(),
        userType,
        serverReceivedAt: Date.now(),
        isSearching
      };
      
      this.memoryLocations.set(userId, locationData);
      
      // ==================== NEW: BROADCAST PASSENGER LOCATION TO DRIVERS ====================
      if (userType === 'passenger' && isSearching) {
        await this.broadcastPassengerLocationToDrivers(userId, data);
      }
      
      // If passenger is searching, update their search document
      if (userType === 'passenger' && isSearching) {
        await this.updatePassengerSearchLocation(userId, {
          latitude,
          longitude,
          accuracy: data.accuracy || 0,
          timestamp: Date.now()
        });
      }
      
      // Send acknowledgment
      this.sendToUser(userId, {
        type: 'LOCATION_UPDATE_ACK',
        data: {
          userId,
          latitude,
          longitude,
          timestamp: Date.now(),
          broadcastedToDrivers: userType === 'passenger' && isSearching,
          message: 'Location processed and broadcasted'
        }
      });
      
    } catch (error) {
      console.error('Error in location update:', error);
      this.sendToUser(userId, {
        type: 'ERROR',
        data: {
          message: 'Failed to process location update',
          error: error.message,
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  async checkForGlobalLocationMessage(userId, message) {
    try {
      const globalLocationService = this.matchingService?.globalLocationService;
      if (!globalLocationService) return false;
      
      const userInfo = this.connectedUsers.get(userId);
      if (!userInfo) return false;
      
      // Messages that GlobalLocationService handles
      const globalMessageTypes = [
        'LOCATION_UPDATE',
        'GET_NEARBY_USERS',
        'GET_ALL_USERS',
        'HEARTBEAT'
      ];
      
      if (!globalMessageTypes.includes(message.type)) return false;
      
      // Get the WebSocket connection
      const connection = globalLocationService.connections.get(userId);
      if (!connection) {
        // User not in GlobalLocationService yet, add them
        globalLocationService.addConnection(
          userId,
          userInfo.ws,
          userInfo.role,
          userInfo.userDetails
        );
      }
      
      // Let GlobalLocationService handle the message
      await globalLocationService.handleMessage(userInfo.ws, message);
      return true;
      
    } catch (error) {
      console.error('Error in global location message check:', error);
      return false;
    }
  }

  async handleSearchStartedFromApp(userId, data) {
    try {
      console.log(`📱 App sent SEARCH_STARTED for ${userId}`);
      // Fetch actual user data
      const userDetails = await this.getActualUserDetails(userId, data.userType || 'driver');
      
      this.sendToUser(userId, {
        type: 'SEARCH_STARTED_ACK',
        data: {
          userId,
          userDetails: userDetails,
          timestamp: Date.now(),
          message: 'Search acknowledged with your profile data'
        }
      });
    } catch (error) {
      console.error('Error handling app search started:', error);
    }
  }

  async handleGetActiveSearch(userId, data) {
    try {
      const userInfo = this.connectedUsers.get(userId);
      if (!userInfo) return;
      
      const userType = userInfo.role;
      await this.checkAndReinitializeSearchOnReconnect(userId, userType);
      
      this.sendToUser(userId, {
        type: 'GET_ACTIVE_SEARCH_ACK',
        data: {
          userId,
          userType,
          timestamp: Date.now(),
          message: 'Active search check completed'
        }
      });
    } catch (error) {
      console.error('Error handling GET_ACTIVE_SEARCH:', error);
    }
  }

  // ==================== LOCATION MANAGEMENT ====================

  async handleDriverLocation(userId, data) {
    try {
      const {
        driverId,
        latitude,
        longitude,
        accuracy = 0,
        heading = 0,
        speed = 0,
        timestamp = Date.now(),
        trackingMode = 'normal',
        searchId
      } = data;
      
      const actualDriverId = driverId || userId;
      
      // Store in memory
      const locationData = {
        driverId: actualDriverId,
        location: { lat: latitude, lng: longitude },
        accuracy,
        heading,
        speed,
        trackingMode,
        searchId,
        timestamp,
        serverReceivedAt: Date.now()
      };
      
      this.memoryLocations.set(actualDriverId, locationData);
      this.trackingModes.set(actualDriverId, trackingMode);
      this.driverLocations.set(actualDriverId, {
        ...locationData,
        lastUpdate: Date.now(),
        status: 'tracking'
      });
      
      // Forward to realtime service if available
      if (this.realtimeLocationService) {
        try {
          await this.realtimeLocationService.updateLocation(
            actualDriverId,
            {
              latitude,
              longitude,
              accuracy,
              heading,
              speed,
              timestamp,
              userType: 'driver'
            },
            'driver'
          );
        } catch (e) {}
      }
      
      // Broadcast to subscribers
      const activeSessions = this.getSessionsByDriverId(actualDriverId);
      let totalBroadcasted = 0;
      
      for (const session of activeSessions) {
        totalBroadcasted += await this.broadcastLocationToSession(session.sessionId, locationData);
        await this.forwardLocationToPartner(actualDriverId, locationData, session.sessionId);
      }
      
      // Legacy subscription support
      const legacySubscriptions = this.locationSubscriptions.get(actualDriverId);
      if (legacySubscriptions && legacySubscriptions.size > 0) {
        const broadcastMessage = {
          type: 'DRIVER_LOCATION_UPDATE',
          data: {
            driverId: actualDriverId,
            latitude,
            longitude,
            accuracy,
            heading,
            speed,
            trackingMode,
            timestamp,
            searchId,
            server: 'localhost:3000'
          }
        };
        
        for (const passengerId of legacySubscriptions) {
          await this.sendToUser(passengerId, broadcastMessage);
        }
      }
      
      // Send acknowledgment
      this.sendToUser(userId, {
        type: 'DRIVER_LOCATION_ACK',
        data: {
          driverId: actualDriverId,
          latitude,
          longitude,
          timestamp: Date.now(),
          trackingMode,
          broadcastTo: totalBroadcasted + (legacySubscriptions?.size || 0),
          memoryStored: true,
          activeSessions: activeSessions.length,
          message: 'Location stored and broadcasted',
          forwardedToRealtimeService: !!this.realtimeLocationService
        }
      });
      
    } catch (error) {
      console.error('Error processing driver location:', error);
      this.sendToUser(userId, {
        type: 'ERROR',
        data: {
          message: 'Failed to process driver location',
          error: error.message,
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  async handleSubscribePassenger(userId, data) {
    try {
      const { driverId, passengerId, timestamp = Date.now(), searchId } = data;
      const actualDriverId = driverId || userId;
      const actualPassengerId = passengerId || userId;
      
      let sessionId = searchId;
      let existingSession = false;
      
      // Create or reuse session
      if (sessionId && this.locationSessions.has(sessionId)) {
        existingSession = true;
      } else {
        sessionId = this.createLocationSession(actualDriverId, actualPassengerId, searchId);
      }
      
      // Add to subscriptions
      if (!this.sessionSubscriptions.has(sessionId)) {
        this.sessionSubscriptions.set(sessionId, new Set());
      }
      this.sessionSubscriptions.get(sessionId).add(actualPassengerId);
      
      // Send current driver location if available
      const driverLocation = this.memoryLocations.get(actualDriverId);
      if (driverLocation) {
        this.sendToUser(actualPassengerId, {
          type: 'DRIVER_LOCATION_UPDATE',
          data: {
            driverId: actualDriverId,
            sessionId,
            latitude: driverLocation.location.lat,
            longitude: driverLocation.location.lng,
            accuracy: driverLocation.accuracy,
            heading: driverLocation.heading,
            speed: driverLocation.speed,
            trackingMode: driverLocation.trackingMode,
            timestamp: driverLocation.timestamp,
            searchId: driverLocation.searchId,
            memoryStored: true,
            server: 'localhost:3000'
          }
        });
      }
      
      // Legacy subscription support
      if (!this.locationSubscriptions.has(actualDriverId)) {
        this.locationSubscriptions.set(actualDriverId, new Set());
      }
      this.locationSubscriptions.get(actualDriverId).add(actualPassengerId);
      
      // Send acknowledgment
      this.sendToUser(userId, {
        type: 'SUBSCRIBE_ACK',
        data: {
          driverId: actualDriverId,
          passengerId: actualPassengerId,
          sessionId,
          timestamp: Date.now(),
          memoryOnly: true,
          existingSession,
          message: 'Subscribed to driver location',
          subscriberCount: this.sessionSubscriptions.get(sessionId).size
        }
      });
      
    } catch (error) {
      console.error('Error subscribing:', error);
      this.sendToUser(userId, {
        type: 'ERROR',
        data: {
          message: 'Failed to subscribe',
          error: error.message,
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  // ==================== SEARCH MANAGEMENT ====================

  async handleDriverStopSearch(userId, data) {
    try {
      console.log('🛑 DRIVER_STOP_SEARCH received:', { userId, data });
      
      const { driverId, searchId, reason = 'driver_stopped_manually' } = data;
      const actualDriverId = driverId || userId;
      
      // Notify MatchingService
      if (this.matchingService) {
        console.log('🚨 Notifying MatchingService...');
        
        // Add to blacklist if method exists
        if (this.matchingService.addToBlacklist) {
          this.matchingService.addToBlacklist(actualDriverId);
        }
        
        // Stop driver search
        await this.matchingService.stopDriverSearch(searchId, actualDriverId, reason);
      }
      
      // Update Firestore
      const driverPhone = await this.lookupPhoneByFirebaseUid(actualDriverId) || actualDriverId;
      
      // Update driver_searches
      const searchDocRef = this.firestore.collection('driver_searches').doc(searchId);
      await searchDocRef.set({
        searchId,
        driverId: actualDriverId,
        driverPhone: driverPhone,
        status: 'cancelled',
        endedAt: this.getServerTimestamp(),
        endReason: reason,
        cancelledBy: 'driver',
        createdAt: this.getServerTimestamp(),
        updatedAt: this.getServerTimestamp()
      }, { merge: true });
      
      // Clear active_searches_driver
      const activeDriverRef = this.firestore.collection('active_searches_driver').doc(driverPhone);
      const activeDriverDoc = await activeDriverRef.get();
      
      if (activeDriverDoc.exists) {
        const driverData = activeDriverDoc.data();
        const capacity = driverData.capacity || 4;
        
        const updateData = {
          status: 'cancelled',
          cancelledAt: this.getServerTimestamp(),
          endReason: reason,
          cancelledBy: 'driver',
          lastUpdated: Date.now()
        };
        
        // Clear all passenger fields
        for (let i = 1; i <= capacity; i++) {
          updateData[`passenger${i}`] = null;
        }
        updateData.passenger = null;
        
        await activeDriverRef.update(updateData);
      }
      
      // Notify passengers
      this.notifyPassengersDriverStopped(actualDriverId, searchId, reason);
      
      // Cleanup WebSocket sessions
      this.cleanupSearchSessions(searchId, actualDriverId);
      
      // Send acknowledgment
      this.sendToUser(userId, {
        type: 'DRIVER_STOP_SEARCH_ACK',
        data: {
          success: true,
          driverId: actualDriverId,
          searchId,
          reason,
          timestamp: Date.now(),
          matchingStopped: true,
          passengersNotified: true
        }
      });
      
      console.log(`✅ COMPLETE stop for ${actualDriverId}, search: ${searchId}`);
      
    } catch (error) {
      console.error('❌ Error in handleDriverStopSearch:', error);
      this.sendToUser(userId, {
        type: 'ERROR',
        data: {
          message: 'Failed to stop search',
          error: error.message,
          searchId: data.searchId
        }
      });
    }
  }

  async handleDriverExtendSearchTime(userId, data) {
    try {
      console.log('⏰ DRIVER_EXTEND_SEARCH_TIME received:', { userId, data });
      
      const { driverId, searchId, additionalSeconds, totalSearchTime, expiresAt } = data;
      const actualDriverId = driverId || userId;
      
      // Convert expiresAt to Date
      const expiresAtDate = expiresAt ? new Date(expiresAt) : new Date(Date.now() + (totalSearchTime * 1000));
      
      // Update driver_searches
      const searchDocRef = this.firestore.collection('driver_searches').doc(searchId);
      const searchDoc = await searchDocRef.get();
      
      let firestoreResult = { updated: false, created: false };
      
      if (searchDoc.exists) {
        await searchDocRef.update({
          searchExpiresAt: expiresAtDate,
          totalSearchTime: totalSearchTime || 600,
          extendedAt: this.getServerTimestamp(),
          extendedDuration: additionalSeconds,
          updatedAt: this.getServerTimestamp(),
          status: 'searching'
        });
        firestoreResult.updated = true;
      } else {
        let driverPhone = actualDriverId;
        try {
          const driverDoc = await this.firestore.collection('drivers').doc(actualDriverId).get();
          if (driverDoc.exists && driverDoc.data().phone) {
            driverPhone = this.formatPhoneNumber(driverDoc.data().phone) || actualDriverId;
          }
        } catch (e) {}
        
        await searchDocRef.set({
          searchId,
          driverId: actualDriverId,
          driverPhone: driverPhone,
          status: 'searching',
          searchExpiresAt: expiresAtDate,
          totalSearchTime: totalSearchTime || 600,
          extendedAt: this.getServerTimestamp(),
          extendedDuration: additionalSeconds,
          createdAt: this.getServerTimestamp(),
          updatedAt: this.getServerTimestamp(),
          estimatedDistance: data.estimatedDistance || 0,
          estimatedFare: data.estimatedFare || 0,
          estimatedDuration: data.estimatedDuration || 0,
          pickupLocation: data.pickupLocation || null,
          destinationLocation: data.destinationLocation || null,
          vehicleInfo: data.vehicleInfo || {}
        });
        firestoreResult.created = true;
      }
      
      // Update active_searches_driver
      const driverPhone = await this.lookupPhoneByFirebaseUid(actualDriverId) || actualDriverId;
      const activeDriverRef = this.firestore.collection('active_searches_driver').doc(driverPhone);
      const activeDriverDoc = await activeDriverRef.get();
      
      if (activeDriverDoc.exists) {
        await activeDriverRef.update({
          searchExpiresAt: expiresAtDate,
          searchExtended: true,
          extendedDuration: additionalSeconds,
          lastUpdated: Date.now()
        });
      }
      
      // Notify MatchingService
      if (this.matchingService?.extendDriverSearchTime) {
        try {
          await this.matchingService.extendDriverSearchTime(
            searchId,
            actualDriverId,
            additionalSeconds,
            expiresAt || expiresAtDate.getTime()
          );
        } catch (matchingError) {}
      }
      
      // Notify passengers
      const activeSessions = this.getSessionsByDriverId(actualDriverId);
      let passengersNotified = 0;
      
      for (const session of activeSessions) {
        if (session.searchId === searchId) {
          const subscribers = this.sessionSubscriptions.get(session.sessionId);
          if (subscribers) {
            for (const passengerId of subscribers) {
              if (passengerId !== actualDriverId) {
                this.sendToUser(passengerId, {
                  type: 'DRIVER_EXTENDED_SEARCH_TIME',
                  data: {
                    driverId: actualDriverId,
                    searchId,
                    additionalSeconds,
                    totalSearchTime,
                    expiresAt: expiresAt || expiresAtDate.getTime(),
                    timestamp: Date.now(),
                    message: 'Driver extended search time'
                  }
                });
                passengersNotified++;
              }
            }
          }
        }
      }
      
      // Send acknowledgment
      this.sendToUser(userId, {
        type: 'DRIVER_EXTEND_SEARCH_TIME_ACK',
        data: {
          success: true,
          driverId: actualDriverId,
          searchId,
          additionalSeconds,
          totalSearchTime,
          expiresAt: expiresAt || expiresAtDate.getTime(),
          timestamp: Date.now(),
          passengersNotified,
          firestoreUpdated: firestoreResult.updated,
          firestoreCreated: firestoreResult.created
        }
      });
      
    } catch (error) {
      console.error('❌ Error handling driver extend search time:', error);
      this.sendToUser(userId, {
        type: 'ERROR',
        data: {
          message: 'Failed to extend search time',
          error: error.message,
          searchId: data.searchId
        }
      });
    }
  }

  async handlePassengerStopSearch(userId, data) {
    try {
      console.log('🛑 PASSENGER_STOP_SEARCH received:', { userId, data });
      
      const { passengerId, searchId, reason = 'passenger_stopped_manually' } = data;
      const actualPassengerId = passengerId || userId;
      
      if (!this.matchingService) {
        this.sendToUser(userId, {
          type: 'ERROR',
          data: {
            message: 'Matching service unavailable',
            timestamp: new Date().toISOString()
          }
        });
        return;
      }
      
      // Stop passenger search
      const result = await this.matchingService.stopPassengerSearch(actualPassengerId, reason);
      
      // Update Firestore
      const passengerRef = this.firestore.collection('passenger_searches').doc(searchId);
      await passengerRef.set({
        searchId,
        passengerId: actualPassengerId,
        status: 'cancelled',
        endedAt: this.getServerTimestamp(),
        endReason: reason,
        cancelledBy: 'passenger',
        updatedAt: this.getServerTimestamp()
      }, { merge: true });
      
      // Cleanup WebSocket sessions
      this.cleanupPassengerSessions(actualPassengerId, searchId);
      
      // Send acknowledgment
      this.sendToUser(userId, {
        type: 'PASSENGER_STOP_SEARCH_ACK',
        data: {
          success: true,
          passengerId: actualPassengerId,
          searchId,
          reason,
          timestamp: Date.now(),
          message: 'Passenger search stopped successfully'
        }
      });
      
    } catch (error) {
      console.error('❌ Error in handlePassengerStopSearch:', error);
      this.sendToUser(userId, {
        type: 'ERROR',
        data: {
          message: 'Failed to stop passenger search',
          error: error.message,
          searchId: data.searchId
        }
      });
    }
  }

  // ==================== MATCH MANAGEMENT ====================

  async handleAcceptMatch(userId, data) {
    try {
      if (!this.matchingService) {
        this.sendToUser(userId, {
          type: 'ERROR',
          data: {
            message: 'Matching service unavailable',
            timestamp: new Date().toISOString()
          }
        });
        return;
      }
      
      const { matchId, passengerId, driverId, passengerField } = data;
      
      if (!matchId || !passengerId || !driverId || !passengerField) {
        this.sendToUser(userId, {
          type: 'ERROR',
          data: {
            message: 'Missing required fields',
            timestamp: new Date().toISOString()
          }
        });
        return;
      }
      
      const userType = userId === driverId ? 'driver' : 'passenger';
      const result = await this.matchingService.acceptIndividualMatch(matchId, userId, userType);
      
      if (result.success) {
        await this.startLocationSharingSession(matchId, driverId, passengerId, passengerField);
      }
      
      // Fetch ACTUAL user data for both users
      const [acceptorDetails, otherUserDetails] = await Promise.all([
        this.getActualUserDetails(userId, userType),
        this.getActualUserDetails(
          userType === 'driver' ? passengerId : driverId,
          userType === 'driver' ? 'passenger' : 'driver'
        )
      ]);
      
      // Send response to accepting user with ACTUAL data
      this.sendToUser(userId, {
        type: 'MATCH_ACCEPTED_RESPONSE',
        data: {
          success: true,
          matchId,
          status: 'accepted',
          acceptedBy: userType,
          acceptorDetails: acceptorDetails,
          otherUserDetails: otherUserDetails,
          timestamp: new Date().toISOString(),
          server: 'localhost:3000',
          ...result
        }
      });
      
      // Notify the other user with ACTUAL data
      const otherUserId = userId === driverId ? passengerId : driverId;
      this.sendToUser(otherUserId, {
        type: 'MATCH_ACCEPTED_NOTIFICATION',
        data: {
          matchId,
          acceptedBy: userType,
          acceptedByUserId: userId,
          acceptedByDetails: acceptorDetails,
          yourDetails: otherUserDetails,
          timestamp: new Date().toISOString(),
          message: `${acceptorDetails.name || userType} accepted match`,
          server: 'localhost:3000'
        }
      });
      
    } catch (error) {
      this.sendToUser(userId, {
        type: 'ERROR',
        data: {
          message: 'Failed to accept match',
          error: error.message,
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  async handleDeclineMatch(userId, data) {
    try {
      if (!this.matchingService) {
        this.sendToUser(userId, {
          type: 'ERROR',
          data: {
            message: 'Matching service unavailable',
            timestamp: new Date().toISOString()
          }
        });
        return;
      }
      
      const { matchId, passengerId, driverId, passengerField, reason } = data;
      
      if (!matchId || !passengerId || !driverId || !passengerField) {
        this.sendToUser(userId, {
          type: 'ERROR',
          data: {
            message: 'Missing required fields',
            timestamp: new Date().toISOString()
          }
        });
        return;
      }
      
      const userType = userId === driverId ? 'driver' : 'passenger';
      const result = await this.matchingService.declineIndividualMatch(
        matchId,
        userId,
        userType,
        reason || 'declined'
      );
      
      this.sendToUser(userId, {
        type: 'MATCH_DECLINED_RESPONSE',
        data: {
          success: true,
          matchId,
          status: 'declined',
          declinedBy: userType,
          reason,
          timestamp: new Date().toISOString(),
          server: 'localhost:3000',
          ...result
        }
      });
      
      const otherUserId = userId === driverId ? passengerId : driverId;
      this.sendToUser(otherUserId, {
        type: 'MATCH_DECLINED_NOTIFICATION',
        data: {
          matchId,
          declinedBy: userType,
          declinedByUserId: userId,
          reason: reason || 'No reason',
          timestamp: new Date().toISOString(),
          message: `${userType === 'driver' ? 'Driver' : 'Passenger'} declined match`,
          server: 'localhost:3000'
        }
      });
      
    } catch (error) {
      this.sendToUser(userId, {
        type: 'ERROR',
        data: {
          message: 'Failed to decline match',
          error: error.message,
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  async handleCancelMatch(userId, data) {
    try {
      console.log('🔍 handleCancelMatch called with:', { userId, data });
      
      if (!this.matchingService) {
        this.sendToUser(userId, {
          type: 'ERROR',
          data: {
            message: 'Matching service unavailable',
            timestamp: new Date().toISOString()
          }
        });
        return;
      }
      
      if (!data) {
        console.error('❌ CANCEL_MATCH: data is undefined');
        this.sendToUser(userId, {
          type: 'ERROR',
          data: {
            message: 'No data provided',
            timestamp: new Date().toISOString()
          }
        });
        return;
      }
      
      const { matchId, driverId, passengerId, passengerField, reason } = data;
      
      if (!matchId || !driverId || !passengerId || !passengerField) {
        console.error('❌ Missing required fields:', { matchId, driverId, passengerId, passengerField });
        this.sendToUser(userId, {
          type: 'ERROR',
          data: {
            message: 'Missing required fields',
            timestamp: new Date().toISOString()
          }
        });
        return;
      }
      
      if (userId !== driverId && userId !== passengerId) {
        this.sendToUser(userId, {
          type: 'ERROR',
          data: {
            message: 'Not authorized',
            timestamp: new Date().toISOString()
          }
        });
        return;
      }
      
      const userType = userId === driverId ? 'driver' : 'passenger';
      const result = await this.matchingService.cancelAcceptedMatch(
        matchId,
        userId,
        userType,
        reason || 'cancelled_by_user'
      );
      
      this.sendToUser(userId, {
        type: 'CANCEL_MATCH_RESPONSE',
        data: {
          success: true,
          matchId,
          status: 'cancelled',
          cancelledBy: userType,
          reason: reason || 'cancelled_by_user',
          timestamp: new Date().toISOString(),
          server: 'localhost:3000',
          ...result
        }
      });
      
      const otherUserId = userId === driverId ? passengerId : driverId;
      this.sendToUser(otherUserId, {
        type: 'MATCH_CANCELLED_NOTIFICATION',
        data: {
          matchId,
          cancelledBy: userType,
          cancelledByUserId: userId,
          reason: reason || 'No reason',
          timestamp: new Date().toISOString(),
          message: `${userType === 'driver' ? 'Driver' : 'Passenger'} cancelled the match`,
          server: 'localhost:3000'
        }
      });
      
      // Cleanup location sharing
      const session = this.getSessionByMatchId(matchId);
      if (session) {
        session.active = false;
        const subscribers = this.sessionSubscriptions.get(session.sessionId);
        if (subscribers) {
          for (const subscriberId of subscribers) {
            if (subscriberId === driverId || subscriberId === passengerId) {
              this.sendToUser(subscriberId, {
                type: 'LOCATION_SHARING_STOPPED',
                data: {
                  matchId,
                  reason: 'match_cancelled',
                  timestamp: new Date().toISOString()
                }
              });
            }
          }
          this.sessionSubscriptions.delete(session.sessionId);
        }
        this.locationSessions.delete(session.sessionId);
      }
      
    } catch (error) {
      console.error('❌ Error handling cancel match:', error);
      this.sendToUser(userId, {
        type: 'ERROR',
        data: {
          message: 'Failed to cancel match',
          error: error.message,
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  async handleCancelAcceptedMatch(userId, data) {
    return await this.handleCancelMatch(userId, data);
  }

  async handleMatchFoundNotification(userId, data) {
    try {
      console.log('🔔 MATCH_FOUND_NOTIFICATION received:', { userId, data });
      
      const { matchId, driverId, passengerId, passengerField } = data;
      
      // Get match details
      const matchDoc = await this.firestore.collection('active_matches').doc(matchId).get();
      if (!matchDoc.exists) {
        console.error('❌ Match not found:', matchId);
        return;
      }
      
      const match = matchDoc.data();
      
      // Fetch ACTUAL user data and location in parallel
      const [actualDriverDetails, actualPassengerDetails, actualPassengerLocation] = await Promise.all([
        this.getActualUserDetails(driverId, 'driver'),
        this.getActualUserDetails(passengerId, 'passenger'),
        this.getActualPassengerLocationFromDriver(driverId, passengerField)
      ]);
      
      // Get actual fare
      const actualFare = match.estimatedFare || 
                         await this.getPassengerEstimatedFare(passengerId) || 0;
      
      // Prepare notification with ACTUAL data
      const notificationData = {
        type: 'MATCH_FOUND',
        data: {
          matchId,
          driverId,
          passengerId,
          passengerField,
          
          // ACTUAL Driver Data:
          driver: {
            id: driverId,
            name: actualDriverDetails.name || match.driverName || 'Driver',
            phone: actualDriverDetails.phone || match.driverPhone || driverId,
            rating: actualDriverDetails.rating || match.driverRating || 4.5,
            vehicleInfo: actualDriverDetails.vehicleInfo || match.vehicleInfo || { model: 'Car', plate: 'Unknown' },
            photoUrl: actualDriverDetails.photoUrl || match.driverPhotoUrl || '',
            totalRides: actualDriverDetails.totalRides || 0
          },
          
          // ACTUAL Passenger Data:
          passenger: {
            id: passengerId,
            name: actualPassengerDetails.name || match.passengerName || 'Passenger',
            phone: actualPassengerDetails.phone || match.passengerPhone || passengerId,
            rating: actualPassengerDetails.rating || match.passengerRating || 4.0,
            photoUrl: actualPassengerDetails.photoUrl || match.passengerPhotoUrl || ''
          },
          
          // ACTUAL Route Data:
          route: {
            pickupLocation: actualPassengerLocation.pickupLocation || match.pickupLocation,
            pickupName: actualPassengerLocation.pickupName || match.pickupName,
            destinationLocation: actualPassengerLocation.destinationLocation || match.destinationLocation,
            destinationName: actualPassengerLocation.destinationName || match.destinationName
          },
          
          passengerCount: match.passengerCount || 1,
          estimatedFare: actualFare,
          status: 'proposed',
          expiresAt: match.expiresAt,
          timestamp: Date.now(),
          requiresAction: true,
          autoNavigate: true,
          screenToOpen: 'match_screen'
        }
      };
      
      // Send to both users
      const driverSent = await this.sendToUser(driverId, notificationData);
      const passengerSent = await this.sendToUser(passengerId, notificationData);
      
      console.log(`📤 Match notifications sent with ACTUAL data - Driver: ${driverSent}, Passenger: ${passengerSent}`);
      
    } catch (error) {
      console.error('❌ Error handling match found notification:', error);
    }
  }

  async getPassengerEstimatedFare(passengerId) {
    try {
      const formattedPassengerId = this.formatPhoneNumber(passengerId);
      const passengerDoc = await this.firestore.collection('active_searches_passenger')
        .doc(formattedPassengerId).get();
      
      if (passengerDoc.exists) {
        return passengerDoc.data().estimatedFare;
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  // ==================== LOCATION SESSION MANAGEMENT ====================

  createLocationSession(driverId, passengerId, searchId) {
    const sessionId = searchId || `loc_${driverId}_${passengerId}_${Date.now()}`;
    const session = {
      sessionId,
      driverId,
      passengerId,
      searchId,
      startedAt: Date.now(),
      expiresAt: Date.now() + (24 * 60 * 60 * 1000),
      active: true,
      memoryOnly: true
    };
    
    this.locationSessions.set(sessionId, session);
    
    if (!this.driverSessions.has(driverId)) {
      this.driverSessions.set(driverId, new Set());
    }
    this.driverSessions.get(driverId).add(sessionId);
    
    if (!this.sessionSubscriptions.has(sessionId)) {
      this.sessionSubscriptions.set(sessionId, new Set());
    }
    
    return sessionId;
  }

  getSessionsByDriverId(driverId) {
    const sessions = [];
    for (const [sessionId, session] of this.locationSessions.entries()) {
      if (session.driverId === driverId && session.active) {
        sessions.push({ sessionId, ...session });
      }
    }
    return sessions;
  }

  getSessionByMatchId(matchId) {
    for (const [sessionId, session] of this.locationSessions.entries()) {
      if (session.searchId === matchId && session.active) {
        return { sessionId, ...session };
      }
    }
    return null;
  }

  async startLocationSharingSession(matchId, driverId, passengerId, passengerField) {
    try {
      const sessionId = this.createLocationSession(driverId, passengerId, matchId);
      this.setupBidirectionalLocationSharing(sessionId, driverId, passengerId);
      
      // Notify both users
      this.sendToUser(driverId, {
        type: 'LOCATION_SHARING_ENABLED',
        data: {
          sessionId,
          matchId,
          partnerId: passengerId,
          partnerType: 'passenger',
          bidirectional: true
        }
      });
      
      this.sendToUser(passengerId, {
        type: 'LOCATION_SHARING_ENABLED',
        data: {
          sessionId,
          matchId,
          partnerId: driverId,
          partnerType: 'driver',
          bidirectional: true
        }
      });
      
      return sessionId;
    } catch (error) {
      console.error('Error starting location sharing:', error);
      return null;
    }
  }

  setupBidirectionalLocationSharing(sessionId, driverId, passengerId) {
    try {
      if (!this.sessionSubscriptions.has(sessionId)) {
        this.sessionSubscriptions.set(sessionId, new Set());
      }
      const subscribers = this.sessionSubscriptions.get(sessionId);
      subscribers.add(passengerId);
      subscribers.add(driverId);
      return true;
    } catch (error) {
      console.error('Error setting up sharing:', error);
      return false;
    }
  }

  async forwardLocationToPartner(senderId, locationData, sessionId) {
    try {
      const session = this.locationSessions.get(sessionId);
      if (!session || !session.active) return false;
      
      const receiverId = senderId === session.driverId ? session.passengerId : session.driverId;
      const message = {
        type: 'PARTNER_LOCATION_UPDATE',
        data: {
          fromUserId: senderId,
          location: locationData.location,
          accuracy: locationData.accuracy,
          speed: locationData.speed,
          heading: locationData.heading,
          timestamp: locationData.timestamp,
          sessionId,
          matchId: session.searchId,
          serverTimestamp: Date.now(),
          via: 'websocket_memory'
        }
      };
      
      return await this.sendToUser(receiverId, message);
    } catch (error) {
      console.error('Error forwarding location:', error);
      return false;
    }
  }

  async broadcastLocationToSession(sessionId, locationData) {
    const session = this.locationSessions.get(sessionId);
    if (!session || !session.active) return 0;
    
    const subscribers = this.sessionSubscriptions.get(sessionId) || new Set();
    const broadcastMessage = {
      type: 'DRIVER_LOCATION_UPDATE',
      data: {
        driverId: locationData.driverId,
        sessionId,
        latitude: locationData.location.lat,
        longitude: locationData.location.lng,
        accuracy: locationData.accuracy,
        heading: locationData.heading,
        speed: locationData.speed,
        trackingMode: locationData.trackingMode,
        timestamp: locationData.timestamp,
        searchId: locationData.searchId,
        memoryStored: true,
        server: 'localhost:3000'
      }
    };
    
    let successCount = 0;
    for (const subscriberId of subscribers) {
      if (await this.sendToUser(subscriberId, broadcastMessage)) successCount++;
    }
    return successCount;
  }

  // ==================== SEND TO USER ====================

  async sendToUser(userIdentifier, message) {
    try {
      if (!userIdentifier) return false;
      
      // Try multiple possible identifiers
      const possibleKeys = [userIdentifier];
      
      // Handle phone number variations
      if (this.isPhoneNumber(userIdentifier)) {
        const formattedPhone = this.formatPhoneNumber(userIdentifier);
        if (formattedPhone) possibleKeys.push(formattedPhone);
        
        // Lookup Firebase UID
        const uid = await this.lookupFirebaseUidByPhone(formattedPhone);
        if (uid) possibleKeys.push(uid);
      }
      
      // Try all possible keys
      for (const key of possibleKeys) {
        const userInfo = this.connectedUsers.get(key);
        if (userInfo && userInfo.ws && userInfo.ws.readyState === WebSocket.OPEN) {
          try {
            userInfo.ws.send(JSON.stringify(message));
            userInfo.lastActivity = Date.now();
            
            // Log important messages
            if (['SEARCH_STARTED', 'MATCH_FOUND', 'MATCH_ACCEPTED', 'SEARCHING_PASSENGERS_UPDATE', 'PASSENGER_LOCATION_UPDATE'].includes(message.type)) {
              console.log(`📤 Sent ${message.type} to ${key}`);
            }
            
            return true;
          } catch (sendError) {
            console.error(`❌ Error sending to ${key}:`, sendError.message);
            this.connectedUsers.delete(key);
          }
        }
      }
      
      return false;
    } catch (error) {
      console.error('❌ Error in sendToUser:', error);
      return false;
    }
  }

  // ==================== USER LOOKUP ====================

  async lookupFirebaseUidByPhone(phone) {
    try {
      const formattedPhone = this.formatPhoneNumber(phone);
      
      // Check cache first
      if (this.phoneToUidCache.has(formattedPhone)) {
        return this.phoneToUidCache.get(formattedPhone);
      }
      
      // Search in users collection
      const usersRef = this.firestore.collection('users');
      const userQuery = await usersRef.where('phone', '==', formattedPhone).limit(1).get();
      
      if (!userQuery.empty) {
        const uid = userQuery.docs[0].id;
        this.phoneToUidCache.set(formattedPhone, uid);
        this.uidToPhoneCache.set(uid, formattedPhone);
        return uid;
      }
      
      // Search in drivers collection
      const driversRef = this.firestore.collection('drivers');
      const driverQuery = await driversRef.where('phone', '==', formattedPhone).limit(1).get();
      
      if (!driverQuery.empty) {
        const uid = driverQuery.docs[0].id;
        this.phoneToUidCache.set(formattedPhone, uid);
        this.uidToPhoneCache.set(uid, formattedPhone);
        return uid;
      }
      
      return null;
    } catch (error) {
      console.error('Error looking up Firebase UID:', error);
      return null;
    }
  }

  async lookupPhoneByFirebaseUid(uid) {
    try {
      // Check cache first
      if (this.uidToPhoneCache.has(uid)) {
        return this.uidToPhoneCache.get(uid);
      }
      
      // Search in users collection
      const userDoc = await this.firestore.collection('users').doc(uid).get();
      if (userDoc.exists && userDoc.data().phone) {
        const phone = this.formatPhoneNumber(userDoc.data().phone);
        this.uidToPhoneCache.set(uid, phone);
        this.phoneToUidCache.set(phone, uid);
        return phone;
      }
      
      // Search in drivers collection
      const driverDoc = await this.firestore.collection('drivers').doc(uid).get();
      if (driverDoc.exists && driverDoc.data().phone) {
        const phone = this.formatPhoneNumber(driverDoc.data().phone);
        this.uidToPhoneCache.set(uid, phone);
        this.phoneToUidCache.set(phone, uid);
        return phone;
      }
      
      return null;
    } catch (error) {
      console.error('Error looking up phone:', error);
      return null;
    }
  }

  // ==================== HELPER METHODS ====================

  notifyPassengersDriverStopped(driverId, searchId, reason) {
    const activeSessions = this.getSessionsByDriverId(driverId);
    let notified = 0;
    
    for (const session of activeSessions) {
      if (session.searchId === searchId) {
        const passengers = this.sessionSubscriptions.get(session.sessionId);
        if (passengers) {
          for (const passengerId of passengers) {
            if (passengerId !== driverId) {
              this.sendToUser(passengerId, {
                type: 'DRIVER_ENDED_SEARCH',
                data: {
                  driverId,
                  searchId,
                  reason,
                  timestamp: Date.now(),
                  message: 'Driver has stopped searching'
                }
              });
              notified++;
            }
          }
        }
      }
    }
    
    console.log(`📤 Notified ${notified} passengers about stopped search`);
  }

  cleanupSearchSessions(searchId, driverId) {
    for (const [sessionId, session] of this.locationSessions.entries()) {
      if (session.searchId === searchId && session.driverId === driverId) {
        session.active = false;
        this.sessionSubscriptions.delete(sessionId);
        this.locationSessions.delete(sessionId);
      }
    }
    
    if (this.driverSessions.has(driverId)) {
      const sessions = this.driverSessions.get(driverId);
      for (const sessionId of sessions) {
        if (this.locationSessions.has(sessionId) &&
          this.locationSessions.get(sessionId).searchId === searchId) {
          sessions.delete(sessionId);
        }
      }
    }
  }

  cleanupPassengerSessions(passengerId, searchId) {
    for (const [sessionId, session] of this.locationSessions.entries()) {
      if (session.passengerId === passengerId && session.searchId === searchId) {
        session.active = false;
        this.sessionSubscriptions.delete(sessionId);
        this.locationSessions.delete(sessionId);
      }
    }
    
    // Remove from any driver's subscriptions
    for (const [driverId, subscriptions] of this.locationSubscriptions.entries()) {
      subscriptions.delete(passengerId);
      if (subscriptions.size === 0) {
        this.locationSubscriptions.delete(driverId);
      }
    }
  }

  cleanupUserSubscriptions(userId) {
    // Cleanup location sessions
    for (const [sessionId, session] of this.locationSessions.entries()) {
      if (session.driverId === userId || session.passengerId === userId) {
        session.active = false;
      }
    }
    
    // Cleanup session subscriptions
    for (const [sessionId, subscribers] of this.sessionSubscriptions.entries()) {
      subscribers.delete(userId);
      if (subscribers.size === 0) {
        this.sessionSubscriptions.delete(sessionId);
      }
    }
    
    // Cleanup driver sessions
    this.driverSessions.delete(userId);
    this.memoryLocations.delete(userId);
    
    // Cleanup location subscriptions
    for (const [driverId, subscriptions] of this.locationSubscriptions.entries()) {
      subscriptions.delete(userId);
      if (subscriptions.size === 0) this.locationSubscriptions.delete(driverId);
    }
    
    this.locationSubscriptions.delete(userId);
    this.driverLocations.delete(userId);
    this.trackingModes.delete(userId);
  }

  // ==================== CLEANUP METHODS ====================

  cleanupStaleConnections() {
    const now = Date.now();
    const maxInactiveTime = 300000; // 5 minutes
    
    for (const [userId, userInfo] of this.connectedUsers.entries()) {
      if (now - userInfo.lastActivity > maxInactiveTime) {
        try {
          if (userInfo.ws.readyState === WebSocket.OPEN) {
            userInfo.ws.close(1000, 'Connection timeout');
          }
        } catch (e) {}
        this.cleanupUserSubscriptions(userId);
        this.connectedUsers.delete(userId);
      }
    }
  }

  cleanupOldLocations() {
    const now = Date.now();
    const maxAge = 600000; // 10 minutes
    
    for (const [driverId, location] of this.memoryLocations.entries()) {
      if (now - location.serverReceivedAt > maxAge) {
        this.memoryLocations.delete(driverId);
      }
    }
    
    for (const [driverId, location] of this.driverLocations.entries()) {
      if (now - location.lastUpdate > maxAge) {
        this.driverLocations.delete(driverId);
      }
    }
  }

  cleanupExpiredSessions() {
    const now = Date.now();
    
    for (const [sessionId, session] of this.locationSessions.entries()) {
      if (now > session.expiresAt || !session.active) {
        this.locationSessions.delete(sessionId);
        this.sessionSubscriptions.delete(sessionId);
        
        if (this.driverSessions.has(session.driverId)) {
          this.driverSessions.get(session.driverId).delete(sessionId);
          if (this.driverSessions.get(session.driverId).size === 0) {
            this.driverSessions.delete(session.driverId);
          }
        }
      }
    }
  }

  // ==================== OTHER HANDLERS (LEGACY/COMPATIBILITY) ====================

  async handleDriverConnect(userId, data) {
    try {
      const { driverId, searchId, action = 'start_tracking' } = data;
      const actualDriverId = driverId || userId;
      this.trackingModes.set(actualDriverId, 'normal');
      
      // Fetch driver details
      const driverDetails = await this.getActualUserDetails(actualDriverId, 'driver');
      
      this.sendToUser(userId, {
        type: 'DRIVER_CONNECT_ACK',
        data: {
          driverId: actualDriverId,
          driverDetails: driverDetails,
          searchId,
          timestamp: Date.now(),
          message: 'Driver tracking started',
          action,
          status: 'connected',
          memoryOnly: true
        }
      });
    } catch (error) {
      this.sendToUser(userId, {
        type: 'ERROR',
        data: {
          message: 'Failed to start tracking',
          error: error.message,
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  async handleTrackingCommand(userId, data) {
    try {
      const { command, reason = 'websocket_command', targetUserId, sessionId } = data;
      
      if (!targetUserId || targetUserId === userId) {
        await this.processTrackingCommand(userId, command, reason, sessionId);
      } else {
        await this.forwardTrackingCommand(userId, targetUserId, command, reason, sessionId);
      }
      
      this.sendToUser(userId, {
        type: 'TRACKING_COMMAND_ACK',
        data: {
          command,
          reason,
          timestamp: Date.now(),
          message: `Command ${command} processed`,
          forwarded: !!targetUserId && targetUserId !== userId,
          memoryOnly: true
        }
      });
    } catch (error) {
      this.sendToUser(userId, {
        type: 'ERROR',
        data: {
          message: 'Failed command',
          error: error.message,
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  async processTrackingCommand(userId, command, reason, sessionId) {
    const actions = {
      'enable_fast_tracking': () => this.switchToFastMode(userId, reason, sessionId),
      'switch_to_fast_mode': () => this.switchToFastMode(userId, reason, sessionId),
      'enable_normal_tracking': () => this.switchToNormalMode(userId, reason, sessionId),
      'switch_to_normal_mode': () => this.switchToNormalMode(userId, reason, sessionId),
      'stop_tracking': () => this.stopTracking(userId, reason, sessionId),
      'resume_tracking': () => this.resumeTracking(userId, reason, sessionId),
      'pause_tracking': () => this.pauseTracking(userId, reason, sessionId),
      'force_location_update': () => this.forceLocationUpdate(userId)
    };
    
    if (actions[command]) await actions[command]();
  }

  async switchToFastMode(userId, reason, sessionId) {
    this.trackingModes.set(userId, 'fast');
    await this.notifyTrackingModeChange(userId, 'fast', reason);
  }

  async switchToNormalMode(userId, reason, sessionId) {
    this.trackingModes.set(userId, 'normal');
    await this.notifyTrackingModeChange(userId, 'normal', reason);
  }

  async stopTracking(userId, reason, sessionId) {
    this.trackingModes.set(userId, 'stopped');
    await this.notifyTrackingModeChange(userId, 'stopped', reason);
  }

  async pauseTracking(userId, reason, sessionId) {
    this.trackingModes.set(userId, 'paused');
    await this.notifyTrackingModeChange(userId, 'paused', reason);
  }

  async resumeTracking(userId, reason, sessionId) {
    const previousMode = this.trackingModes.get(userId) || 'normal';
    const newMode = previousMode === 'stopped' || previousMode === 'paused' ? 'normal' : previousMode;
    this.trackingModes.set(userId, newMode);
    await this.notifyTrackingModeChange(userId, newMode, reason);
  }

  async forceLocationUpdate(userId) {
    const driverLocation = this.memoryLocations.get(userId);
    if (driverLocation) {
      const activeSessions = this.getSessionsByDriverId(userId);
      for (const session of activeSessions) {
        await this.broadcastLocationToSession(session.sessionId, driverLocation);
        await this.forwardLocationToPartner(userId, driverLocation, session.sessionId);
      }
      
      this.sendToUser(userId, {
        type: 'FORCE_LOCATION_UPDATE_ACK',
        data: {
          timestamp: Date.now(),
          message: 'Location update forced',
          broadcastTo: this.getSubscriberCount(userId),
          memoryOnly: true
        }
      });
    } else {
      this.sendToUser(userId, {
        type: 'ERROR',
        data: {
          message: 'No location data',
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  async notifyTrackingModeChange(userId, mode, reason) {
    this.sendToUser(userId, {
      type: 'TRACKING_MODE_CHANGED',
      data: {
        userId,
        mode,
        reason,
        timestamp: Date.now(),
        updateInterval: mode === 'fast' ? 10 : 30,
        server: 'localhost:3000',
        memoryOnly: true
      }
    });
    
    const activeSessions = this.getSessionsByDriverId(userId);
    for (const session of activeSessions) {
      const subscribers = this.sessionSubscriptions.get(session.sessionId);
      if (subscribers) {
        for (const passengerId of subscribers) {
          this.sendToUser(passengerId, {
            type: 'DRIVER_TRACKING_MODE_CHANGED',
            data: {
              driverId: userId,
              mode,
              reason,
              timestamp: Date.now(),
              updateInterval: mode === 'fast' ? 10 : 30,
              server: 'localhost:3000',
              memoryOnly: true
            }
          });
        }
      }
    }
  }

  async forwardTrackingCommand(fromUserId, targetUserId, command, reason, sessionId) {
    this.sendToUser(targetUserId, {
      type: 'TRACKING_COMMAND',
      data: {
        command,
        reason,
        targetUserId,
        sessionId,
        fromUserId,
        forwarded: true,
        timestamp: Date.now(),
        memoryOnly: true
      }
    });
  }

  getSubscriberCount(driverId) {
    let total = 0;
    for (const [sessionId, session] of this.locationSessions.entries()) {
      if (session.driverId === driverId && session.active) {
        const subscribers = this.sessionSubscriptions.get(sessionId);
        total += (subscribers?.size || 0);
      }
    }
    return total;
  }

  async handleLocationTrackingRequest(userId, data) {
    try {
      const { searchId, isPassenger = false, route = [], estimatedDuration = 30.0, driverId } = data;
      
      this.activeSessions.set(searchId, {
        searchId,
        userId,
        driverId: driverId || userId,
        isPassenger,
        route,
        estimatedDuration,
        startTime: Date.now(),
        status: 'active',
        trackingMode: isPassenger ? 'fast' : 'normal'
      });
      
      this.sendToUser(userId, {
        type: 'LOCATION_TRACKING_STARTED',
        data: {
          searchId,
          userId,
          isPassenger,
          timestamp: Date.now(),
          message: 'Tracking started',
          trackingMode: isPassenger ? 'fast' : 'normal',
          server: 'localhost:3000',
          memoryOnly: true
        }
      });
    } catch (error) {
      this.sendToUser(userId, {
        type: 'ERROR',
        data: {
          message: 'Failed to start tracking',
          error: error.message,
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  async handleETACalculationRequest(userId, data) {
    try {
      const { sessionId, searchId, reason = 'eta_calculation_request' } = data;
      
      await this.switchToFastMode(userId, reason, sessionId || searchId);
      
      setTimeout(() => {
        if (this.trackingModes.get(userId) === 'fast') {
          this.switchToNormalMode(userId, 'eta_calculation_complete', sessionId || searchId);
        }
      }, 120000);
      
      this.sendToUser(userId, {
        type: 'ETA_CALCULATION_ACK',
        data: {
          sessionId: sessionId || searchId,
          reason,
          timestamp: Date.now(),
          message: 'ETA calculation started',
          fastModeDuration: 120,
          server: 'localhost:3000',
          memoryOnly: true
        }
      });
    } catch (error) {
      this.sendToUser(userId, {
        type: 'ERROR',
        data: {
          message: 'Failed ETA calculation',
          error: error.message,
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  async handleTrackingStatusRequest(userId, data) {
    try {
      const { requestId } = data;
      const status = await this.getTrackingStatus(userId);
      
      this.sendToUser(userId, {
        type: 'TRACKING_STATUS_RESPONSE',
        data: {
          requestId,
          timestamp: Date.now(),
          status,
          userId,
          server: 'localhost:3000',
          memoryOnly: true
        }
      });
    } catch (error) {
      this.sendToUser(userId, {
        type: 'ERROR',
        data: {
          message: 'Failed status request',
          error: error.message,
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  async getTrackingStatus(userId) {
    const driverLocation = this.memoryLocations.get(userId);
    const trackingMode = this.trackingModes.get(userId);
    
    const memorySessions = [];
    let memorySubscribers = [];
    
    for (const [sessionId, session] of this.locationSessions.entries()) {
      if (session.driverId === userId && session.active) {
        const subscribers = this.sessionSubscriptions.get(sessionId);
        memorySessions.push({
          sessionId,
          passengerId: session.passengerId,
          active: session.active,
          startedAt: session.startedAt,
          subscriberCount: subscribers?.size || 0,
          isBidirectional: subscribers?.has(userId) && subscribers?.has(session.passengerId)
        });
        
        if (subscribers) {
          memorySubscribers = [...memorySubscribers, ...Array.from(subscribers)];
        }
      }
    }
    
    return {
      isTracking: !!driverLocation,
      trackingMode: trackingMode || 'normal',
      location: driverLocation?.location || null,
      lastUpdate: driverLocation?.serverReceivedAt || null,
      memoryOnly: true,
      memorySessions,
      subscribers: memorySubscribers,
      subscriberCount: memorySubscribers.length,
      connected: this.connectedUsers.has(userId),
      server: 'localhost:3000',
      hybridMode: true,
      realtimeServiceAvailable: !!this.realtimeLocationService
    };
  }

  async handleTripStarted(userId, data) {
    try {
      const { searchId, matchId, isPassenger = false } = data;
      const sessionId = searchId || matchId;
      
      if (this.activeSessions.has(sessionId)) {
        const session = this.activeSessions.get(sessionId);
        session.tripStarted = true;
        session.tripStartTime = Date.now();
        if (isPassenger) {
          await this.switchToFastMode(userId, 'trip_started_passenger', sessionId);
        } else {
          await this.switchToNormalMode(userId, 'trip_started_driver', sessionId);
        }
      }
      
      if (matchId) {
        const matchDoc = await this.firestore.collection('active_matches').doc(matchId).get();
        if (matchDoc.exists) {
          const match = matchDoc.data();
          const otherUserId = userId === match.driverId ? match.passengerId : match.driverId;
          this.sendToUser(otherUserId, {
            type: 'TRIP_STARTED_NOTIFICATION',
            data: {
              matchId,
              startedBy: userId,
              timestamp: Date.now(),
              message: 'Trip started',
              memoryOnly: true
            }
          });
        }
      }
    } catch (error) {
      console.error('Error handling trip start:', error);
    }
  }

  async handleTripCompleted(userId, data) {
    try {
      const { searchId, matchId, reason = 'trip_completed' } = data;
      await this.stopTracking(userId, reason, searchId || matchId);
      
      const sessionId = searchId || matchId;
      
      for (const [sessId, session] of this.locationSessions.entries()) {
        if ((session.driverId === userId || session.passengerId === userId) && session.active) {
          session.active = false;
        }
      }
      
      if (this.activeSessions.has(sessionId)) this.activeSessions.delete(sessionId);
      this.cleanupUserSubscriptions(userId);
      
      if (matchId) {
        const matchDoc = await this.firestore.collection('active_matches').doc(matchId).get();
        if (matchDoc.exists) {
          const match = matchDoc.data();
          const otherUserId = userId === match.driverId ? match.passengerId : match.driverId;
          this.sendToUser(otherUserId, {
            type: 'TRIP_COMPLETED_NOTIFICATION',
            data: {
              matchId,
              completedBy: userId,
              reason,
              timestamp: Date.now(),
              message: 'Trip completed',
              memoryOnly: true
            }
          });
        }
      }
    } catch (error) {
      console.error('Error handling trip complete:', error);
    }
  }

  async handleDriverEndedSearch(userId, data) {
    try {
      const { driverId, searchId, reason = 'driver_stopped_search', passengerId } = data;
      const actualDriverId = driverId || userId;
      
      if (passengerId) {
        this.sendToUser(passengerId, {
          type: 'DRIVER_ENDED_SEARCH_NOTIFICATION',
          data: {
            driverId: actualDriverId,
            searchId,
            reason,
            timestamp: Date.now(),
            message: 'Driver has ended the search'
          }
        });
      } else {
        const activeSessions = this.getSessionsByDriverId(actualDriverId);
        for (const session of activeSessions) {
          if (session.searchId === searchId) {
            const subscribers = this.sessionSubscriptions.get(session.sessionId);
            if (subscribers) {
              for (const subscriberId of subscribers) {
                if (subscriberId !== actualDriverId) {
                  this.sendToUser(subscriberId, {
                    type: 'DRIVER_ENDED_SEARCH_NOTIFICATION',
                    data: {
                      driverId: actualDriverId,
                      searchId,
                      reason,
                      timestamp: Date.now(),
                      message: 'Driver has ended the search'
                    }
                  });
                }
              }
            }
          }
        }
      }
      
      this.sendToUser(userId, {
        type: 'DRIVER_ENDED_SEARCH_ACK',
        data: {
          success: true,
          driverId: actualDriverId,
          searchId,
          reason,
          timestamp: Date.now(),
          notificationSent: true
        }
      });
    } catch (error) {
      console.error('Error handling driver ended search:', error);
      this.sendToUser(userId, {
        type: 'ERROR',
        data: {
          message: 'Failed to send ended search notification',
          error: error.message
        }
      });
    }
  }

  async handleSubscribePassengerTracking(userId, data) {
    try {
      const { driverId, passengerId, searchId } = data;
      const actualDriverId = driverId || userId;
      const actualPassengerId = passengerId || userId;
      
      let sessionId = searchId;
      let existingSession = false;
      
      if (sessionId && this.locationSessions.has(sessionId)) {
        existingSession = true;
      } else {
        sessionId = this.createLocationSession(actualDriverId, actualPassengerId, searchId);
      }
      
      if (!this.sessionSubscriptions.has(sessionId)) {
        this.sessionSubscriptions.set(sessionId, new Set());
      }
      this.sessionSubscriptions.get(sessionId).add(actualPassengerId);
      
      this.sendToUser(userId, {
        type: 'SUBSCRIBE_PASSENGER_TRACKING_ACK',
        data: {
          driverId: actualDriverId,
          passengerId: actualPassengerId,
          sessionId,
          timestamp: Date.now(),
          message: 'Subscribed to passenger tracking',
          sessionType: 'driver_subscription'
        }
      });
    } catch (error) {
      console.error('Error handling subscribe passenger tracking:', error);
      this.sendToUser(userId, {
        type: 'ERROR',
        data: {
          message: 'Failed to subscribe to passenger tracking',
          error: error.message
        }
      });
    }
  }

  async handlePassengerLocation(userId, data) {
    try {
      const { latitude, longitude, matchId, sessionId } = data;
      
      const locationData = {
        userId,
        location: { lat: latitude, lng: longitude },
        accuracy: data.accuracy || 0,
        heading: data.heading || 0,
        speed: data.speed || 0,
        timestamp: data.timestamp || Date.now(),
        userType: 'passenger',
        serverReceivedAt: Date.now()
      };
      
      this.memoryLocations.set(userId, locationData);
      
      let targetSessionId = sessionId;
      if (matchId && !targetSessionId) {
        const session = this.getSessionByMatchId(matchId);
        if (session) targetSessionId = session.sessionId;
      }
      
      if (targetSessionId) {
        await this.forwardLocationToPartner(userId, locationData, targetSessionId);
      }
      
      this.sendToUser(userId, {
        type: 'PASSENGER_LOCATION_ACK',
        data: {
          userId,
          latitude,
          longitude,
          timestamp: Date.now(),
          forwarded: !!targetSessionId,
          message: 'Passenger location processed'
        }
      });
    } catch (error) {
      console.error('Error handling passenger location:', error);
      this.sendToUser(userId, {
        type: 'ERROR',
        data: {
          message: 'Failed passenger location',
          error: error.message,
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  async handlePartnerLocation(userId, data) {
    try {
      const { latitude, longitude, sessionId } = data;
      
      const locationData = {
        userId,
        location: { lat: latitude, lng: longitude },
        accuracy: data.accuracy || 0,
        heading: data.heading || 0,
        speed: data.speed || 0,
        timestamp: data.timestamp || Date.now(),
        serverReceivedAt: Date.now()
      };
      
      this.memoryLocations.set(userId, locationData);
      
    } catch (error) {
      console.error('Error handling partner location:', error);
    }
  }

  async handleLegacyMatchDecision(userId, data) {
    try {
      const { matchId, decision, reason } = data;
      const matchDoc = await this.firestore.collection('active_matches').doc(matchId).get();
      if (matchDoc.exists) {
        const match = matchDoc.data();
        if (decision === 'ACCEPTED') {
          await this.handleAcceptMatch(userId, {
            matchId,
            passengerId: match.passengerId,
            driverId: match.driverId,
            passengerField: match.passengerField
          });
        } else if (decision === 'REJECTED') {
          await this.handleDeclineMatch(userId, {
            matchId,
            passengerId: match.passengerId,
            driverId: match.driverId,
            passengerField: match.passengerField,
            reason
          });
        }
      }
    } catch (error) {
      console.error('Error in legacy match decision:', error);
    }
  }

  async handleGetMatchStatus(userId, data) {
    try {
      const { matchId } = data;
      if (!matchId) {
        this.sendToUser(userId, {
          type: 'ERROR',
          data: {
            message: 'matchId required',
            timestamp: new Date().toISOString()
          }
        });
        return;
      }
      
      const matchDoc = await this.firestore.collection('active_matches').doc(matchId).get();
      if (!matchDoc.exists) {
        this.sendToUser(userId, {
          type: 'ERROR',
          data: {
            message: 'Match not found',
            timestamp: new Date().toISOString()
          }
        });
        return;
      }
      
      const match = matchDoc.data();
      if (userId !== match.driverId && userId !== match.passengerId) {
        this.sendToUser(userId, {
          type: 'ERROR',
          data: {
            message: 'Not authorized',
            timestamp: new Date().toISOString()
          }
        });
        return;
      }
      
      // Fetch actual user details
      const [driverDetails, passengerDetails] = await Promise.all([
        this.getActualUserDetails(match.driverId, 'driver'),
        this.getActualUserDetails(match.passengerId, 'passenger')
      ]);
      
      this.sendToUser(userId, {
        type: 'MATCH_STATUS_RESPONSE',
        data: {
          matchId,
          status: match.status,
          driverId: match.driverId,
          passengerId: match.passengerId,
          passengerField: match.passengerField,
          driverDetails: driverDetails,
          passengerDetails: passengerDetails,
          createdAt: match.createdAt,
          expiresAt: match.expiresAt,
          timestamp: new Date().toISOString(),
          server: 'localhost:3000'
        }
      });
    } catch (error) {
      console.error('Error getting match status:', error);
      this.sendToUser(userId, {
        type: 'ERROR',
        data: {
          message: 'Failed to get match status',
          error: error.message,
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  async handleLegacySearchStarted(userId, data) {
    try {
      const searchData = data.data || data;
      const searchId = searchData.searchId;
      const isPassenger = searchData.userType === 'passenger';
      
      if (searchId) {
        this.activeSessions.set(searchId, {
          searchId,
          userId,
          userType: isPassenger ? 'passenger' : 'driver',
          startTime: Date.now(),
          isPending: true,
          status: 'searching'
        });
      }
    } catch (error) {
      console.error('Error in legacy search started:', error);
    }
  }

  async handleSearchStatusUpdate(userId, data) {
    try {
      const searchData = data.data || data;
      const searchId = searchData.searchId;
      const status = searchData.status;
      
      if (searchId && this.activeSessions.has(searchId)) {
        const session = this.activeSessions.get(searchId);
        session.searchStatus = status;
        if (status === 'active' && session.isPending) session.isPending = false;
      }
    } catch (error) {
      console.error('Error in search status update:', error);
    }
  }

  async handleMatchAccepted(userId, data) {
    try {
      const matchData = data.data || data;
      const matchId = matchData.matchId;
      const searchId = matchData.searchId;
      
      if (searchId && this.activeSessions.has(searchId)) {
        const session = this.activeSessions.get(searchId);
        session.isPending = false;
        session.matchId = matchId;
        session.status = 'matched';
      }
    } catch (error) {
      console.error('Error in match accepted:', error);
    }
  }

  async handleMatchRejected(userId, data) {
    try {
      const matchData = data.data || data;
      const searchId = matchData.searchId;
      
      if (searchId && this.activeSessions.has(searchId)) {
        this.activeSessions.delete(searchId);
      }
    } catch (error) {
      console.error('Error in match rejected:', error);
    }
  }

  async handleMatchTimeout(userId, data) {
    try {
      const matchData = data.data || data;
      const searchId = matchData.searchId;
      
      if (searchId && this.activeSessions.has(searchId)) {
        this.activeSessions.delete(searchId);
      }
    } catch (error) {
      console.error('Error in match timeout:', error);
    }
  }

  async handleUnsubscribePassenger(userId, data) {
    try {
      const { driverId, passengerId, sessionId } = data;
      const actualDriverId = driverId || userId;
      const actualPassengerId = passengerId || userId;
      
      if (sessionId && this.sessionSubscriptions.has(sessionId)) {
        this.sessionSubscriptions.get(sessionId).delete(actualPassengerId);
        if (this.sessionSubscriptions.get(sessionId).size === 0) {
          this.sessionSubscriptions.delete(sessionId);
          if (this.locationSessions.has(sessionId)) {
            const session = this.locationSessions.get(sessionId);
            session.active = false;
          }
        }
      }
      
      const legacySubscriptions = this.locationSubscriptions.get(actualDriverId);
      if (legacySubscriptions) {
        legacySubscriptions.delete(actualPassengerId);
        if (legacySubscriptions.size === 0) {
          this.locationSubscriptions.delete(actualDriverId);
        }
      }
      
      this.sendToUser(userId, {
        type: 'UNSUBSCRIBE_ACK',
        data: {
          driverId: actualDriverId,
          passengerId: actualPassengerId,
          sessionId,
          timestamp: Date.now(),
          memoryOnly: true,
          message: 'Unsubscribed from tracking'
        }
      });
    } catch (error) {
      console.error('Error unsubscribing:', error);
      this.sendToUser(userId, {
        type: 'ERROR',
        data: {
          message: 'Failed to unsubscribe',
          error: error.message,
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  // ==================== MATCHING SERVICE INTEGRATION ====================

  setupMatchingServiceIntegration(matchingService) {
    this.matchingService = matchingService;
    
    // Pass WebSocket server reference to matching service
    if (matchingService && !matchingService.websocketServer) {
      matchingService.websocketServer = this;
      console.log('🔗 WebSocketServer linked to MatchingService');
    }
  }

  // ==================== BROADCAST AND STATS ====================

  async broadcastTrackingStatus() {
    try {
      const stats = this.getStats();
      const status = {
        timestamp: Date.now(),
        connectedUsers: this.connectedUsers.size,
        stats: stats,
        server: 'localhost:3000',
        memoryOnly: true
      };
      
      for (const [userId, userInfo] of this.connectedUsers.entries()) {
        if (userInfo.ws.readyState === WebSocket.OPEN && userInfo.role === 'driver') {
          this.sendToUser(userId, {
            type: 'TRACKING_STATUS_BROADCAST',
            data: status
          });
        }
      }
    } catch (error) {
      console.error('Error broadcasting status:', error);
    }
  }

  getStats() {
    const connectedUsers = this.getConnectedUsers();
    let activeMemorySessions = 0;
    let memorySubscribers = 0;
    let activeMemoryDrivers = new Set();
    
    for (const [sessionId, session] of this.locationSessions.entries()) {
      if (session.active) {
        activeMemorySessions++;
        activeMemoryDrivers.add(session.driverId);
        const subscribers = this.sessionSubscriptions.get(sessionId);
        memorySubscribers += (subscribers?.size || 0);
      }
    }
    
    return {
      connected: connectedUsers.length,
      drivers: connectedUsers.filter(u => u.role === 'driver').length,
      passengers: connectedUsers.filter(u => u.role === 'passenger').length,
      
      memoryOnlyLocationTracking: {
        activeSessions: activeMemorySessions,
        activeDrivers: activeMemoryDrivers.size,
        memoryLocations: this.memoryLocations.size,
        subscribers: memorySubscribers,
        driverSessions: this.driverSessions.size,
        bidirectionalSessions: Array.from(this.locationSessions.entries())
          .filter(([_, session]) => session.active)
          .map(([id, session]) => ({
            sessionId: id,
            driverId: session.driverId,
            passengerId: session.passengerId,
            subscribers: this.sessionSubscriptions.get(id)?.size || 0
          }))
      },
      
      legacyTracking: {
        driverLocations: this.driverLocations.size,
        activeSubscriptions: Array.from(this.locationSubscriptions.entries())
          .reduce((total, [_, set]) => total + set.size, 0),
        activeSessions: this.activeSessions.size
      },
      
      services: {
        matchingService: !!this.matchingService,
        realtimeLocationService: !!this.realtimeLocationService,
        firestoreService: !!this.firestoreService
      },
      
      feature: 'HYBRID_LOCATION_TRACKING_ENABLED',
      connections: connectedUsers.map(u => ({
        id: u.userId.substring(0, 15) + '...',
        role: u.role,
        phone: u.isPhone
      })),
      server: 'localhost:3000',
      path: '/ws'
    };
  }

  getConnectedUsers() {
    const connected = [];
    const seenWs = new Set();
    
    for (const [userId, userInfo] of this.connectedUsers.entries()) {
      if (userInfo.ws.readyState === WebSocket.OPEN && !seenWs.has(userInfo.ws)) {
        seenWs.add(userInfo.ws);
        connected.push({
          userId,
          role: userInfo.role,
          connectedAt: userInfo.connectedAt,
          formattedId: userInfo.formattedId,
          isPhone: userInfo.isPhone,
          lastActivity: userInfo.lastActivity
        });
      }
    }
    
    return connected;
  }

  // ==================== CLOSE METHOD ====================

  close() {
    this.wss.close();
    console.log('🔌 WebSocketServer closed');
  }
}

module.exports = WebSocketServer;
