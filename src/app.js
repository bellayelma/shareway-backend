const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// Configurations
const constants = require('./config/constants');
const { db, admin } = require('./config/firebase');

// Services
const FirestoreService = require('./services/firestoreService');
const SearchService = require('./services/searchService');
const MatchingService = require('./services/matchingService');
const ScheduledService = require('./services/scheduledService');
const RideService = require('./services/rideService');
const WebSocketServer = require('./websocketServer');
const NotificationService = require('./services/notificationService');

// Middlewares
const requestLogger = require('./middlewares/logging');

// Controllers
const matchController = require('./controllers/matchController');
const searchController = require('./controllers/searchController');
const driverController = require('./controllers/driverController');
const passengerController = require('./controllers/passengerController');
const rideController = require('./controllers/rideController');

// Initialize app
const app = express();

// CORS
app.use(cors({
  origin: true,
  credentials: true
}));

// Body parsing with limits
app.use(express.json({ limit: '500kb' }));
app.use(express.urlencoded({ extended: true, limit: '500kb' }));

// Optimized logging middleware
app.use(requestLogger);

// Initialize services
const firestoreService = new FirestoreService(db, admin);
firestoreService.startBatchProcessor();

// WebSocket server (will be set after server starts)
let websocketServer = null;
let notificationService = null;

// Services that need WebSocket
let searchService, rideService, matchingService, scheduledService;

// Services container
const services = {
  db,
  admin,
  constants,
  firestoreService
};

// Initialize controllers with services (partial for now)
matchController.init(services);

// Register routes
app.use('/api/match', matchController.router);

// Health endpoint
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: "ShareWay Symmetrical Matching Server is running",
    timestamp: new Date().toISOString(),
    version: "6.0.0",
    features: {
      modular: true,
      cached: true,
      batchedWrites: true,
      testMode: constants.TEST_MODE,
      firestoreOperationsReduced: true,
      websocketEnabled: true,
      notificationService: notificationService ? true : false
    },
    stats: firestoreService.getStats(),
    websocket: {
      connections: websocketServer ? websocketServer.getConnectedCount() : 0,
      notificationService: notificationService ? 'Active' : 'Inactive'
    }
  });
});

// Debug endpoint
app.get('/api/debug/status', async (req, res) => {
  try {
    const firestoreStats = firestoreService.getStats();
    const cache = require('./utils/cache');
    
    const debugInfo = {
      server: {
        timestamp: new Date().toISOString(),
        testMode: constants.TEST_MODE,
        websocketConnections: websocketServer ? websocketServer.getConnectedCount() : 0,
        notificationService: notificationService ? notificationService.getStats() : 'Not initialized'
      },
      firestore: firestoreStats,
      cache: cache.stats(),
      matchingService: matchingService ? matchingService.getStats() : 'Not initialized'
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

// Debug endpoints for notifications
app.post('/api/debug/send-notification', (req, res) => {
  try {
    const { userId, message, type, data } = req.body;
    
    if (!userId || !message) {
      return res.status(400).json({
        success: false,
        error: 'userId and message are required'
      });
    }
    
    if (!notificationService) {
      return res.status(500).json({
        success: false,
        error: 'Notification service not initialized'
      });
    }
    
    const notification = {
      userId,
      message,
      type: type || 'info',
      data: data || {},
      timestamp: new Date().toISOString()
    };
    
    const sent = notificationService.sendNotification(notification);
    
    res.json({
      success: sent,
      message: sent ? 'Notification sent' : 'User not connected',
      notification
    });
    
  } catch (error) {
    console.error('❌ Error sending notification:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/debug/notifications', (req, res) => {
  try {
    if (!notificationService) {
      return res.status(500).json({
        success: false,
        error: 'Notification service not initialized'
      });
    }
    
    res.json({
      success: true,
      stats: notificationService.getStats(),
      connectedUsers: notificationService.getConnectedUsers()
    });
    
  } catch (error) {
    console.error('❌ Error getting notifications:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Add a TEST endpoint to force matching
app.post('/api/debug/force-match', async (req, res) => {
  try {
    if (!matchingService) {
      return res.status(500).json({
        success: false,
        error: 'Matching service not initialized'
      });
    }
    
    // Run matching cycle immediately
    await matchingService.performMatchingCycle();
    
    res.json({
      success: true,
      message: 'Forced matching cycle completed',
      stats: matchingService.getStats()
    });
    
  } catch (error) {
    console.error('❌ Error in force-match:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Start server
const PORT = process.env.PORT || 3000;

if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', async () => {
    console.log(`
🚀 ShareWay MODULAR SERVER Started!
📍 Port: ${PORT}
🧪 TEST MODE: ${constants.TEST_MODE ? 'ACTIVE' : 'INACTIVE'}
💾 CACHING: ENABLED
📦 BATCH WRITES: ENABLED
🔌 WebSocket: READY

🎯 OPTIMIZATIONS:
- 70-90% reduction in Firestore operations
- In-memory caching layer
- Batched write operations
- Modular code structure
- Optimized logging
- Real-time notifications
    `);
  });

  // Setup WebSocket
  websocketServer = new WebSocketServer(server);
  console.log('✅ WebSocket server initialized');
  
  // Initialize NotificationService
  notificationService = new NotificationService(firestoreService, websocketServer);
  console.log('✅ NotificationService initialized');
  
  // Initialize other services with WebSocket and NotificationService
  searchService = new SearchService(firestoreService, websocketServer);
  console.log('✅ SearchService initialized');
  
  rideService = new RideService(firestoreService, websocketServer);
  console.log('✅ RideService initialized');
  
  // Pass NotificationService to MatchingService
  matchingService = new MatchingService(
    firestoreService, 
    searchService, 
    websocketServer, 
    notificationService, // Add NotificationService here
    admin
  );
  console.log('✅ MatchingService initialized');
  
  scheduledService = new ScheduledService(firestoreService, websocketServer, admin);
  console.log('✅ ScheduledService initialized');
  
  // Update services container with all services
  services.websocketServer = websocketServer;
  services.searchService = searchService;
  services.rideService = rideService;
  services.matchingService = matchingService;
  services.scheduledService = scheduledService;
  services.notificationService = notificationService;
  
  console.log('\n🔧 Initializing all controllers with complete services...');
  
  // Re-initialize all controllers with complete services
  matchController.init(services);
  searchController.init(services);
  driverController.init(services);
  passengerController.init(services);
  rideController.init(services);
  
  console.log('✅ All controllers initialized');
  
  // Register all routes
  app.use('/api/search', searchController.router);
  app.use('/api/driver', driverController.router);
  app.use('/api/passenger', passengerController.router);
  app.use('/api/ride', rideController.router);
  
  console.log('\n🚀 Starting all services...');
  
  // Start services
  matchingService.start();
  console.log('✅ MatchingService started');
  
  scheduledService.start();
  console.log('✅ ScheduledService started');
  
  notificationService.startCleanupInterval();
  console.log('✅ NotificationService cleanup started');
  
  // Run immediate matching cycle
  setTimeout(() => {
    console.log('\n🔍 Running initial matching cycle...');
    matchingService.performMatchingCycle();
  }, 2000);
  
  server.on('error', (error) => {
    console.error('❌ Server error:', error);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server gracefully...');
    
    if (websocketServer) {
      websocketServer.broadcast({
        type: 'SERVER_SHUTDOWN',
        message: 'Server is shutting down for maintenance',
        timestamp: new Date().toISOString()
      });
    }
    
    // Stop all services
    if (matchingService) matchingService.stop();
    if (scheduledService) scheduledService.stop();
    if (notificationService) notificationService.stopCleanupInterval();
    
    server.close(() => {
      console.log('✅ Server closed gracefully');
      process.exit(0);
    });
  });
}

module.exports = { 
  app, 
  services,
  websocketServer,
  notificationService 
};
