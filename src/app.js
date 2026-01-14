const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const constants = require('./config/constants');
const { db, admin } = require('./config/firebase');
const FirestoreService = require('./services/firestoreService');
const SearchService = require('./services/searchService');
const MatchingService = require('./services/matchingService');
const ScheduledService = require('./services/scheduledService');
const RideService = require('./services/rideService');
const RealtimeLocationService = require('./services/realtimeLocationService');
const WebSocketServer = require('./websocketServer');
const requestLogger = require('./middlewares/logging');

// 🔥 IMPORT MATCHING CONFIG MANAGER
const { matchingConfigManager } = require('./config/matchingConfig');

// Import controllers
const locationController = require('./controllers/locationController');
const matchController = require('./controllers/matchController');
const searchController = require('./controllers/searchController');
const driverController = require('./controllers/driverController');
const passengerController = require('./controllers/passengerController');
const rideController = require('./controllers/rideController');

const app = express();
const PORT = process.env.PORT || 3000;
const allowedOrigins = [
  'http://localhost:8082', 'http://127.0.0.1:8082', 'http://localhost:3000',
  'http://127.0.0.1:3000', 'http://localhost:8081', 'http://localhost:8080',
  'http://10.0.2.2:8082', 'http://10.0.2.2:3000'
];

app.use(cors({ origin: allowedOrigins, credentials: true, methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '500kb' }));
app.use(express.urlencoded({ extended: true, limit: '500kb' }));
app.use(requestLogger);

const server = http.createServer(app);
let websocketServer = null, firestoreService = null, searchService = null, rideService = null, 
    matchingService = null, scheduledService = null, realtimeLocationService = null;

// 🔥 LOG INITIAL CONFIGURATION
console.log('\n🎯 INITIAL MATCHING CONFIGURATION:');
console.log(`   Active Profile: ${matchingConfigManager.currentProfile}`);
console.log(`   Description: ${matchingConfigManager.activeConfig.SYSTEM_MODE}`);
console.log(`   Force Test Mode: ${matchingConfigManager.activeConfig.FORCE_TEST_MODE ? '✅ ON' : '❌ OFF'}`);
console.log(`   Auto-Stop: ${matchingConfigManager.activeConfig.DRIVER_CONTROL.AUTO_STOP_ENABLED ? '✅ ON' : '❌ OFF'}`);

// ==================== CREATE SERVICES ====================

try {
  firestoreService = new FirestoreService(db, admin);
  firestoreService.startBatchProcessor();
  console.log('✅ FirestoreService initialized');
} catch (error) { console.log('⚠️ FirestoreService error:', error.message); }

try {
  if (SearchService && firestoreService) {
    searchService = new SearchService(firestoreService);
    console.log('✅ SearchService initialized');
  }
} catch (error) { console.log('⚠️ SearchService error:', error.message); }

try {
  if (RideService && firestoreService) {
    rideService = new RideService(firestoreService);
    console.log('✅ RideService initialized');
  }
} catch (error) { console.log('⚠️ RideService error:', error.message); }

// 🔥 CREATE WebSocketServer
try {
  if (WebSocketServer) {
    websocketServer = new WebSocketServer(
      server, 
      firestoreService, 
      null, // matchingService will be linked later
      null  // realtimeLocationService will be linked later
    );
    console.log('🔌 WebSocketServer created');
  }
} catch (error) { 
  console.log('⚠️ WebSocket error:', error.message);
  console.error(error.stack);
}

// 🔥 CREATE MatchingService WITH CONFIGURATION
try {
  if (MatchingService && firestoreService && searchService && websocketServer) {
    matchingService = new MatchingService(
      firestoreService,
      searchService,
      websocketServer,
      null, // notificationService
      admin
    );
    console.log('✅ MatchingService initialized with configuration system');
  } else {
    console.log('⚠️ Missing dependencies for MatchingService');
  }
} catch (error) { 
  console.log('❌ MatchingService error:', error.message);
  console.error(error.stack);
}

try {
  if (RealtimeLocationService && firestoreService && websocketServer) {
    realtimeLocationService = new RealtimeLocationService(
      firestoreService, 
      matchingService, // 🔥 PASS MatchingService
      websocketServer,
      admin
    );
    console.log('✅ RealtimeLocationService initialized');
  }
} catch (error) { 
  console.log('⚠️ RealtimeLocationService error:', error.message);
  console.error(error.stack);
}

// 🔥 ScheduledService initialization
try {
  if (ScheduledService && firestoreService && websocketServer) {
    scheduledService = new ScheduledService(firestoreService, websocketServer, admin);
    console.log('✅ ScheduledService initialized');
  }
} catch (error) { 
  console.log('⚠️ ScheduledService error:', error.message);
  console.error(error.stack);
}

// ==================== CONNECT SERVICES ====================

try {
  // Link services together
  if (websocketServer) {
    // Link MatchingService to WebSocketServer
    if (matchingService) {
      websocketServer.matchingService = matchingService;
      console.log('🔗 Connected WebSocketServer → MatchingService');
    }
    
    // Link RealtimeLocationService
    if (realtimeLocationService) {
      websocketServer.realtimeLocationService = realtimeLocationService;
      console.log('🔗 Connected WebSocketServer → RealtimeLocationService');
    }
  }
  
  console.log('✅ Service linking completed');
} catch (error) {
  console.log('❌ Error connecting services:', error.message);
  console.error(error.stack);
}

// Create services object
const services = { 
  db, 
  admin, 
  constants, 
  firestoreService, 
  websocketServer, 
  searchService, 
  rideService, 
  matchingService, 
  scheduledService, 
  realtimeLocationService,
  matchingConfigManager
};

// Initialize controllers
try {
  if (locationController && typeof locationController.init === 'function') {
    locationController.init(services);
    console.log('✅ LocationController initialized');
  }
} catch (error) { console.log('⚠️ LocationController error:', error.message); }

try {
  if (matchController && typeof matchController.init === 'function') {
    matchController.init(services);
    console.log('✅ MatchController initialized');
  }
} catch (error) { console.log('⚠️ MatchController error:', error.message); }

try {
  if (searchController && typeof searchController.init === 'function') {
    searchController.init(services);
    console.log('✅ SearchController initialized');
  }
} catch (error) { console.log('⚠️ SearchController error:', error.message); }

try {
  if (driverController && typeof driverController.init === 'function') {
    driverController.init(services);
    console.log('✅ DriverController initialized');
  }
} catch (error) { console.log('⚠️ DriverController error:', error.message); }

try {
  if (passengerController && typeof passengerController.init === 'function') {
    passengerController.init(services);
    console.log('✅ PassengerController initialized');
  }
} catch (error) { console.log('⚠️ PassengerController error:', error.message); }

try {
  if (rideController && typeof rideController.init === 'function') {
    rideController.init(services);
    console.log('✅ RideController initialized');
  }
} catch (error) { console.log('⚠️ RideController error:', error.message); }

// ==================== WEB SOCKET SEARCH INITIALIZATION ====================

// 🔥 Enhanced search notification function
async function sendSearchStartedNotification(userId, userType, searchData, additionalData = {}) {
  try {
    console.log(`📤 Sending SEARCH_STARTED to ${userType}: ${userId}`);
    
    let notificationSent = false;
    
    // Method 1: Use MatchingService
    if (matchingService && typeof matchingService.sendSearchScreenInitialization === 'function') {
      try {
        await matchingService.sendSearchScreenInitialization(userId, userType, searchData);
        notificationSent = true;
        console.log(`✅ SEARCH_STARTED sent via MatchingService`);
      } catch (error) {
        console.log(`⚠️ MatchingService.sendSearchScreenInitialization failed:`, error.message);
      }
    }
    
    // Method 2: Use WebSocketServer directly
    if (!notificationSent && websocketServer) {
      const message = {
        type: 'SEARCH_STARTED',
        data: {
          userId,
          userType,
          searchId: searchData.searchId || `search_${userId}_${Date.now()}`,
          searchData,
          timestamp: Date.now(),
          status: 'searching',
          message: `Search started - looking for ${userType === 'driver' ? 'passengers' : 'drivers'}...`,
          screen: 'search',
          shouldInitializeSearchScreen: true,
          location: searchData.currentLocation || searchData.location,
          destination: searchData.destinationLocation,
          capacity: searchData.capacity || searchData.numberOfPassengers || 1,
          ...additionalData
        }
      };
      
      // Try sendSearchStartedToUser
      if (typeof websocketServer.sendSearchStartedToUser === 'function') {
        try {
          notificationSent = await websocketServer.sendSearchStartedToUser(userId, message);
          console.log(`✅ SEARCH_STARTED sent via sendSearchStartedToUser`);
        } catch (error) {
          console.log(`⚠️ sendSearchStartedToUser failed:`, error.message);
        }
      }
      
      // Fallback to sendToUser
      if (!notificationSent && typeof websocketServer.sendToUser === 'function') {
        try {
          notificationSent = await websocketServer.sendToUser(userId, message);
          console.log(`✅ SEARCH_STARTED sent via sendToUser`);
        } catch (error) {
          console.log(`⚠️ sendToUser failed:`, error.message);
        }
      }
    }
    
    if (!notificationSent) {
      console.log(`⚠️ Could not send SEARCH_STARTED to ${userId}`);
    }
    
    return notificationSent;
    
  } catch (error) {
    console.error(`❌ Error sending SEARCH_STARTED to ${userId}:`, error);
    return false;
  }
}

// ==================== ROUTES ====================

// Health endpoints
app.get('/api/health', (req, res) => {
  let websocketConnections = 0;
  if (websocketServer) {
    if (typeof websocketServer.getConnectedUsers === 'function') {
      const connected = websocketServer.getConnectedUsers();
      websocketConnections = connected.length;
    } else if (websocketServer.connections) {
      websocketConnections = Object.keys(websocketServer.connections || {}).length;
    }
  }
  
  const serviceConnections = {
    websocketServer: !!websocketServer,
    matchingService: !!matchingService,
    websocketToMatching: !!websocketServer?.matchingService,
    matchingToWebsocket: !!matchingService?.websocketServer,
    websocketToLocation: !!websocketServer?.realtimeLocationService,
    locationToWebsocket: !!realtimeLocationService?.websocketServer,
    matchingConfig: !!matchingService?.config
  };
  
  // Get current configuration
  const currentConfig = matchingService ? matchingService.getCurrentConfig?.() : null;
  
  res.json({
    status: 'OK', 
    message: "ShareWay Backend with Configuration System", 
    timestamp: new Date().toISOString(),
    features: { 
      websocketEnabled: !!websocketServer, 
      searchInitialization: !!matchingService?.sendSearchScreenInitialization,
      realtimeLocationSharing: !!realtimeLocationService,
      configurationSystem: !!matchingService?.config,
      scheduledService: !!scheduledService
    },
    stats: firestoreService ? firestoreService.getStats() : {},
    websocket: { 
      initialized: !!websocketServer, 
      connections: websocketConnections,
      serviceConnections: serviceConnections
    },
    matchingConfiguration: currentConfig || {
      profile: matchingConfigManager?.currentProfile || 'N/A',
      forceTestMode: matchingConfigManager?.activeConfig?.FORCE_TEST_MODE || false
    }
  });
});

// 🔥 Configuration management endpoints
app.get('/api/config/matching', (req, res) => {
  try {
    const currentConfig = matchingConfigManager.getActiveConfig();
    res.json({
      success: true,
      profile: matchingConfigManager.currentProfile,
      config: {
        systemMode: currentConfig.SYSTEM_MODE,
        forceTestMode: currentConfig.FORCE_TEST_MODE,
        scoringWeights: currentConfig.SCORING_WEIGHTS,
        routeThresholds: currentConfig.ROUTE_THRESHOLDS,
        proximitySettings: currentConfig.PROXIMITY,
        autoStopEnabled: currentConfig.DRIVER_CONTROL.AUTO_STOP_ENABLED
      },
      availableProfiles: Object.keys(require('./config/matchingConfig').MATCHING_PROFILES)
    });
  } catch (error) {
    console.error('❌ Error getting matching config:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/config/matching/switch-profile', (req, res) => {
  try {
    const { profileName } = req.body;
    
    if (!profileName) {
      return res.status(400).json({ success: false, error: 'profileName is required' });
    }
    
    const success = matchingConfigManager.switchProfile(profileName);
    
    if (success) {
      // Update MatchingService configuration
      if (matchingService) {
        matchingService.FORCE_TEST_MODE = matchingConfigManager.activeConfig.FORCE_TEST_MODE;
        matchingService.config = matchingConfigManager;
      }
      
      res.json({
        success: true,
        message: `Switched to ${profileName} profile`,
        profile: matchingConfigManager.currentProfile,
        forceTestMode: matchingConfigManager.activeConfig.FORCE_TEST_MODE
      });
    } else {
      res.status(400).json({ 
        success: false, 
        error: `Profile ${profileName} not found`,
        availableProfiles: Object.keys(require('./config/matchingConfig').MATCHING_PROFILES)
      });
    }
  } catch (error) {
    console.error('❌ Error switching matching profile:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/config/matching/update', (req, res) => {
  try {
    const { updates } = req.body;
    
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ success: false, error: 'updates object is required' });
    }
    
    // Apply updates to configuration
    Object.keys(updates).forEach(key => {
      if (key in matchingConfigManager.activeConfig) {
        matchingConfigManager.activeConfig[key] = updates[key];
      } else if (key.includes('.')) {
        // Handle nested properties
        const keys = key.split('.');
        let current = matchingConfigManager.activeConfig;
        
        for (let i = 0; i < keys.length - 1; i++) {
          if (current[keys[i]] === undefined) {
            current[keys[i]] = {};
          }
          current = current[keys[i]];
        }
        
        const lastKey = keys[keys.length - 1];
        current[lastKey] = updates[key];
      }
    });
    
    // Update MatchingService
    if (matchingService) {
      matchingService.FORCE_TEST_MODE = matchingConfigManager.activeConfig.FORCE_TEST_MODE;
    }
    
    res.json({
      success: true,
      message: 'Configuration updated',
      updatedFields: Object.keys(updates),
      currentConfig: {
        profile: matchingConfigManager.currentProfile,
        forceTestMode: matchingConfigManager.activeConfig.FORCE_TEST_MODE
      }
    });
  } catch (error) {
    console.error('❌ Error updating matching config:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🔥 Unified match search endpoint
app.post('/api/match/search', async (req, res) => {
  try {
    const { userId, userType, rideType, scheduledTime, ...searchData } = req.body;
    console.log('🔍 Match search request received:');
    console.log(`   User: ${userId} (${userType})`);
    console.log(`   Ride Type: ${rideType}`);
    
    if (!userId || !userType) {
      return res.status(400).json({ success: false, error: 'Missing userId or userType' });
    }
    
    // Check if it's a scheduled ride
    const isScheduled = rideType === 'scheduled' && scheduledTime;
    const scheduledDateTime = scheduledTime ? new Date(scheduledTime) : null;
    const now = new Date();
    
    if (isScheduled && scheduledDateTime && scheduledDateTime > now) {
      // SCHEDULED RIDE - Store in scheduled_searches
      console.log(`📅 SCHEDULED search detected for ${userType}: ${userId}`);
      console.log(`   Scheduled for: ${scheduledDateTime.toLocaleString()}`);
      
      if (!scheduledService) {
        return res.status(500).json({ 
          success: false, 
          error: 'Scheduled service not available' 
        });
      }
      
      const scheduledSearchData = {
        userId,
        userType,
        phoneNumber: searchData.driverPhone || searchData.passengerPhone || userId,
        scheduledTime: scheduledDateTime.toISOString(),
        name: searchData.driverName || searchData.passengerName || 'User',
        photoUrl: searchData.driverPhotoUrl || searchData.passengerPhotoUrl || '',
        pickupLocation: searchData.pickupLocation || searchData.currentLocation,
        pickupName: searchData.pickupName,
        destinationLocation: searchData.destinationLocation,
        destinationName: searchData.destinationName,
        capacity: searchData.capacity || 4,
        passengerCount: searchData.passengerCount || searchData.numberOfPassengers || 1,
        ...(userType === 'driver' && {
          driverRating: searchData.driverRating,
          vehicleInfo: searchData.vehicleInfo,
          price: searchData.price
        })
      };
      
      const result = await scheduledService.createScheduledSearch(scheduledSearchData);
      
      if (result.success) {
        return res.json({
          success: true,
          type: 'scheduled',
          searchId: result.searchId,
          scheduledTime: result.scheduledTime,
          nextCheckTime: result.nextCheckTime,
          message: 'Search scheduled successfully',
          userType,
          userId
        });
      } else {
        return res.status(500).json(result);
      }
    } else {
      // IMMEDIATE RIDE
      console.log(`🎯 IMMEDIATE search stored: ${searchData.driverName || searchData.passengerName || 'Unknown ' + userType}`);
      
      if (userType === 'driver') {
        await searchService.addDriverSearch({
          userId,
          driverId: userId,
          driverPhone: searchData.driverPhone || userId,
          driverName: searchData.driverName || 'Unknown Driver',
          driverPhotoUrl: searchData.driverPhotoUrl || searchData.driverPhoto || '',
          ...searchData
        });
      } else {
        await searchService.addPassengerSearch({
          userId,
          passengerId: userId,
          passengerPhone: searchData.passengerPhone || userId,
          passengerName: searchData.passengerName || 'Unknown Passenger',
          passengerPhotoUrl: searchData.passengerPhotoUrl || searchData.passengerPhoto || '',
          ...searchData
        });
      }
      
      // Send search started notification
      const phoneNumber = searchData.driverPhone || searchData.passengerPhone || userId;
      await sendSearchStartedNotification(phoneNumber, userType, searchData);
      
      return res.json({
        success: true,
        message: 'Immediate search started successfully',
        type: 'immediate',
        userId,
        userType,
        services: {
          matchingService: !!matchingService,
          websocketServer: !!websocketServer
        }
      });
    }
  } catch (error) {
    console.error('❌ Error in match search:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 🔥 Scheduled search endpoint
app.post('/api/schedule/search', async (req, res) => {
  try {
    const searchData = req.body;
    
    if (!searchData.phoneNumber || !searchData.scheduledTime) {
      return res.status(400).json({ 
        success: false, 
        error: 'phoneNumber and scheduledTime are required' 
      });
    }
    
    const scheduledTime = new Date(searchData.scheduledTime);
    const now = new Date();
    const timeDiff = (scheduledTime - now) / (1000 * 60 * 60);
    
    if (timeDiff > 1 && scheduledService) {
      const result = await scheduledService.createScheduledSearch(searchData);
      
      if (result.success) {
        return res.json({
          success: true,
          type: 'scheduled',
          searchId: result.searchId,
          scheduledTime: result.scheduledTime,
          nextCheckTime: result.nextCheckTime,
          message: 'Search scheduled successfully'
        });
      } else {
        return res.status(500).json(result);
      }
    } else {
      return res.json({
        success: true,
        type: 'immediate',
        message: 'Forwarded to immediate search'
      });
    }
  } catch (error) {
    console.error('❌ Error scheduling search:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🔥 Endpoint to check scheduled searches
app.get('/api/schedule/status/:phoneNumber', async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    
    if (!scheduledService) {
      return res.status(503).json({ 
        success: false, 
        error: 'Scheduled service not available' 
      });
    }
    
    const result = await scheduledService.getScheduledSearchStatus(phoneNumber);
    res.json(result);
  } catch (error) {
    console.error('❌ Error getting schedule status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Use controller routers if available
if (matchController && matchController.router) {
  app.use('/api/match', matchController.router);
}

if (searchController && searchController.router) {
  app.use('/api/search', searchController.router);
}

if (driverController && driverController.router) {
  app.use('/api/driver', driverController.router);
}

if (passengerController && passengerController.router) {
  app.use('/api/passenger', passengerController.router);
}

if (rideController && rideController.router) {
  app.use('/api/ride', rideController.router);
}

// ==================== SEARCH ENDPOINTS ====================

// Driver start search
app.post('/api/driver/start-search', async (req, res) => {
  try {
    const searchData = req.body;
    console.log('🚗 Driver starting search:', { 
      driverId: searchData.driverId,
      hasMatchingService: !!matchingService,
      matchingConfig: matchingConfigManager?.currentProfile || 'N/A'
    });
    
    if (!searchData.driverId) return res.status(400).json({ success: false, error: 'driverId is required' });
    
    const searchDocData = {
      userId: searchData.driverId, 
      driverId: searchData.driverId, 
      driverName: searchData.driverName || 'Unknown Driver',
      driverPhone: searchData.driverPhone || '', 
      driverPhoto: searchData.driverPhotoUrl || searchData.driverPhoto || '',
      pickupName: searchData.pickupName, 
      destinationName: searchData.destinationName, 
      capacity: searchData.capacity || 4,
      driverRating: searchData.driverRating || 0, 
      routePoints: searchData.routePoints || [], 
      vehicleInfo: searchData.vehicleInfo || {},
      location: searchData.location || null, 
      price: searchData.price || 0, 
      departureTime: searchData.departureTime || new Date().toISOString(),
      status: 'searching', 
      createdAt: new Date().toISOString(),
      searchId: `search_${searchData.driverId}_${Date.now()}`,
      currentLocation: searchData.location || { lat: 8.550023, lng: 39.266712 },
      destinationLocation: searchData.destinationLocation || { lat: 9.589549, lng: 41.866169 }
    };
    
    if (searchService) {
      await searchService.addDriverSearch(searchDocData);
      console.log(`✅ Driver search stored in Firestore: ${searchDocData.searchId}`);
    }
    
    const userId = searchData.driverPhone || searchData.driverId;
    const notificationSent = await sendSearchStartedNotification(userId, 'driver', searchDocData);
    
    res.json({
      success: true, 
      message: 'Driver search started successfully', 
      driverId: searchData.driverId,
      driverName: searchData.driverName, 
      driverPhone: searchData.driverPhone || '', 
      searchId: searchDocData.searchId,
      websocketNotification: notificationSent ? 'sent' : 'not_sent',
      services: {
        matchingService: !!matchingService,
        websocketServer: !!websocketServer,
        matchingProfile: matchingConfigManager?.currentProfile || 'N/A',
        forceTestMode: matchingConfigManager?.activeConfig?.FORCE_TEST_MODE || false,
        scheduledService: !!scheduledService
      }
    });
  } catch (error) {
    console.error('❌ Error starting search:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Passenger request ride
app.post('/api/passenger/request-ride', async (req, res) => {
  try {
    const rideRequest = req.body;
    console.log('👤 Passenger requesting ride:', { 
      passengerId: rideRequest.passengerId,
      matchingConfig: matchingConfigManager?.currentProfile || 'N/A'
    });
    
    if (!rideRequest.passengerId) return res.status(400).json({ success: false, error: 'passengerId is required' });
    
    const searchDocData = {
      userId: rideRequest.passengerId, 
      passengerId: rideRequest.passengerId, 
      passengerName: rideRequest.passengerName || 'Unknown Passenger',
      passengerPhone: rideRequest.passengerPhone || '', 
      passengerPhoto: rideRequest.passengerPhotoUrl || rideRequest.passengerPhoto || '',
      pickup: rideRequest.pickup || {}, 
      dropoff: rideRequest.dropoff || {}, 
      numberOfPassengers: rideRequest.numberOfPassengers || 1,
      ridePreferences: rideRequest.ridePreferences || {}, 
      rideType: rideRequest.rideType || 'immediate',
      scheduledTime: rideRequest.scheduledTime || null, 
      specialRequests: rideRequest.specialRequests || '',
      status: 'searching', 
      createdAt: new Date().toISOString(),
      searchId: `passenger_search_${rideRequest.passengerId}_${Date.now()}`,
      currentLocation: rideRequest.currentLocation || rideRequest.pickup?.location || { lat: 8.550023, lng: 39.266712 },
      destinationLocation: rideRequest.dropoff?.location || { lat: 9.589549, lng: 41.866169 }
    };
    
    if (searchService) {
      await searchService.addPassengerSearch(searchDocData);
      console.log(`✅ Passenger search stored in Firestore: ${searchDocData.searchId}`);
    }
    
    const userId = rideRequest.passengerPhone || rideRequest.passengerId;
    const notificationSent = await sendSearchStartedNotification(userId, 'passenger', searchDocData);
    
    res.json({
      success: true, 
      rideId: searchDocData.searchId, 
      passengerId: rideRequest.passengerId,
      passengerName: rideRequest.passengerName, 
      passengerPhone: rideRequest.passengerPhone || '',
      passengerPhoto: rideRequest.passengerPhotoUrl || rideRequest.passengerPhoto || '', 
      status: 'searching',
      searchId: searchDocData.searchId,
      websocketNotification: notificationSent ? 'sent' : 'not_sent',
      services: {
        matchingService: !!matchingService,
        websocketServer: !!websocketServer,
        matchingProfile: matchingConfigManager?.currentProfile || 'N/A',
        forceTestMode: matchingConfigManager?.activeConfig?.FORCE_TEST_MODE || false,
        scheduledService: !!scheduledService
      }
    });
  } catch (error) {
    console.error('❌ Error requesting ride:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== DEBUG ENDPOINTS ====================

app.get('/api/debug/status', async (req, res) => {
  try {
    const firestoreStats = firestoreService ? firestoreService.getStats() : {};
    let websocketConnections = 0;
    
    if (websocketServer) {
      if (typeof websocketServer.getConnectedUsers === 'function') {
        const connected = websocketServer.getConnectedUsers();
        websocketConnections = connected.length;
      }
    }
    
    const serviceConnections = {
      websocketServer: !!websocketServer,
      matchingService: !!matchingService,
      websocketToMatching: !!websocketServer?.matchingService,
      matchingToWebsocket: !!matchingService?.websocketServer,
      websocketToLocation: !!websocketServer?.realtimeLocationService,
      locationToWebsocket: !!realtimeLocationService?.websocketServer,
      configurationSystem: !!matchingService?.config,
      scheduledService: !!scheduledService
    };
    
    const matchingStats = matchingService ? matchingService.getStats?.() : {};
    const currentConfig = matchingService ? matchingService.getCurrentConfig?.() : null;
    
    res.json({
      server: { 
        timestamp: new Date().toISOString(),
        serviceConnections: serviceConnections
      },
      firestore: firestoreStats,
      matching: matchingStats,
      services: {
        realtimeLocationService: !!realtimeLocationService, 
        matchingService: !!matchingService,
        searchService: !!searchService,
        websocketServer: !!websocketServer,
        scheduledService: !!scheduledService
      },
      configuration: {
        activeProfile: matchingConfigManager?.currentProfile || 'N/A',
        forceTestMode: matchingConfigManager?.activeConfig?.FORCE_TEST_MODE || false,
        currentConfig: currentConfig
      },
      searchInitialization: {
        available: !!matchingService?.sendSearchScreenInitialization,
        matchingServiceHasWebSocket: !!matchingService?.websocketServer,
        webSocketServerHasMatchingService: !!websocketServer?.matchingService
      }
    });
  } catch (error) {
    console.error('❌ Error in debug endpoint:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== ERROR HANDLING ====================

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Route not found', path: req.path, method: req.method });
});

app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  res.status(500).json({ success: false, error: 'Internal server error', message: err.message });
});

// ==================== START SERVER ====================

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', async () => {
    console.log('\n🚀🚀🚀 SHAREWAY BACKEND WITH CONFIGURATION SYSTEM 🚀🚀🚀');
    console.log(`📍 Backend: http://localhost:${PORT}`);
    console.log(`🔌 WebSocket: ws://localhost:${PORT}`);
    console.log(`🌐 Flutter Web: http://localhost:8082`);
    console.log('✅ CORS Enabled for localhost origins');
    console.log('✅ WebSocket server ready');
    console.log('✅ Real-time location sharing ready');
    console.log('✅ Scheduled service ready');
    
    console.log('\n🎯 ACTIVE MATCHING CONFIGURATION:');
    console.log(`   Profile: ${matchingConfigManager.currentProfile}`);
    console.log(`   Description: ${matchingConfigManager.activeConfig.SYSTEM_MODE}`);
    console.log(`   Force Test Mode: ${matchingConfigManager.activeConfig.FORCE_TEST_MODE ? '✅ ON' : '❌ OFF'}`);
    console.log(`   Auto-Stop: ${matchingConfigManager.activeConfig.DRIVER_CONTROL.AUTO_STOP_ENABLED ? '✅ ON' : '❌ OFF'}`);
    console.log(`   Real-time Matching: ${matchingConfigManager.activeConfig.DYNAMIC_MATCHING.ENABLED ? '✅ ON' : '❌ OFF'}`);
    console.log(`   Batch Matching: ${matchingConfigManager.activeConfig.ALGORITHM.USE_BATCH_MATCHING ? '✅ ON' : '❌ OFF'}`);
    
    // Start services
    console.log('\n🔧 Starting services...');
    
    // Start MatchingService
    if (matchingService && typeof matchingService.start === 'function') {
      try {
        await matchingService.start();
        console.log('✅ MatchingService started with configuration');
      } catch (error) {
        console.error('❌ Error starting MatchingService:', error);
      }
    }
    
    // Start ScheduledService
    if (scheduledService && typeof scheduledService.start === 'function') {
      try {
        await scheduledService.start();
        console.log('✅ ScheduledService started');
      } catch (error) {
        console.error('❌ Error starting ScheduledService:', error);
      }
    }
    
    // Start RealtimeLocationService
    if (realtimeLocationService && typeof realtimeLocationService.start === 'function') {
      try {
        await realtimeLocationService.start();
        console.log('✅ RealtimeLocationService started');
      } catch (error) {
        console.error('❌ Error starting RealtimeLocationService:', error);
      }
    }
    
    console.log('\n🔗 Service Connections Status:');
    console.log('   - WebSocket Server: ', !!websocketServer);
    console.log('   - Matching Service: ', !!matchingService);
    console.log('   - Scheduled Service: ', !!scheduledService);
    console.log('   - Matching → WebSocket: ', !!matchingService?.websocketServer);
    console.log('   - WebSocket → Matching: ', !!websocketServer?.matchingService);
    console.log('   - Configuration System: ', !!matchingService?.config);
    console.log('   - Active Profile: ', matchingConfigManager.currentProfile);
    
    if (matchingService?.sendSearchScreenInitialization) {
      console.log('✅ Search screen initialization ENABLED via MatchingService');
    }
    
    console.log('\n📱 Ready for requests!');
    console.log('   Unified Search: POST /api/match/search');
    console.log('   Drivers: POST /api/driver/start-search');
    console.log('   Passengers: POST /api/passenger/request-ride');
    console.log('   Scheduled: POST /api/schedule/search');
    console.log('   Schedule Status: GET /api/schedule/status/:phoneNumber');
    console.log('   Configuration: GET /api/config/matching');
    console.log('   Switch Profile: POST /api/config/matching/switch-profile');
  });

  server.on('error', (error) => {
    console.error('❌ Server error:', error);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server gracefully...');
    
    [matchingService, scheduledService, realtimeLocationService].forEach(service => {
      try {
        if (service && typeof service.stop === 'function') service.stop();
      } catch (error) { console.log('⚠️ Error stopping service:', error.message); }
    });
    
    server.close(() => {
      console.log('✅ Server closed gracefully');
      process.exit(0);
    });
  });
}

module.exports = { 
  app, 
  server, 
  services, 
  websocketServer, 
  locationController, 
  matchController,
  searchController, 
  driverController, 
  passengerController, 
  rideController, 
  realtimeLocationService,
  matchingConfigManager
};
