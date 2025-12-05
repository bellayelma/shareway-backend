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

// Middlewares
const requestLogger = require('./middlewares/logging');

// Controller imports
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

// Services that need WebSocket
let searchService, rideService, matchingService, scheduledService;

// Services container (will be populated later)
const services = {
  db,
  admin,
  constants,
  firestoreService
};

// Register routes
app.use('/api/match', matchController.router);
app.use('/api/search', searchController.router);
app.use('/api/driver', driverController.router);
app.use('/api/passenger', passengerController.router);
app.use('/api/ride', rideController.router);

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
      firestoreOperationsReduced: true
    },
    stats: firestoreService.getStats()
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
        websocketConnections: websocketServer ? websocketServer.getConnectedCount() : 0
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
    `);
  });

  // Setup WebSocket
  websocketServer = new WebSocketServer(server);
  console.log('✅ WebSocket server initialized');
  
  // DEBUG: Check if TEST_MODE is enabled
  console.log(`🧪 TEST_MODE from constants: ${constants.TEST_MODE}`);
  console.log(`🧪 TEST_MODE from env: ${process.env.TEST_MODE}`);
  
  // Initialize other services with WebSocket
  searchService = new SearchService(firestoreService, websocketServer);
  console.log('✅ SearchService initialized');
  
  rideService = new RideService(firestoreService, websocketServer);
  console.log('✅ RideService initialized');
  
  // FIXED: Pass admin to MatchingService (even if it doesn't use it)
  matchingService = new MatchingService(firestoreService, searchService, websocketServer, admin);
  console.log('✅ MatchingService initialized');
  
  scheduledService = new ScheduledService(firestoreService, websocketServer, admin);
  console.log('✅ ScheduledService initialized');
  
  // Update services container with COMPLETE services
  services.websocketServer = websocketServer;
  services.searchService = searchService;
  services.rideService = rideService;
  services.matchingService = matchingService;
  services.scheduledService = scheduledService;
  
  // NOW initialize ALL controllers with COMPLETE services
  console.log('\n🔧 Initializing controllers with all services...');
  matchController.init(services);
  searchController.init(services);
  driverController.init(services);
  passengerController.init(services);
  rideController.init(services);
  console.log('✅ All controllers initialized');
  
  // Debug: Check what controllers received
  console.log('\n🔍 Services availability check:');
  console.log('- firestoreService:', firestoreService ? '✅' : '❌');
  console.log('- searchService:', searchService ? '✅' : '❌');
  console.log('- matchingService:', matchingService ? '✅' : '❌');
  console.log('- websocketServer:', websocketServer ? '✅' : '❌');
  console.log('- rideService:', rideService ? '✅' : '❌');
  
  // Start services
  console.log('\n🚀 Starting services...');
  matchingService.start();
  console.log('✅ MatchingService started');
  
  scheduledService.start();
  console.log('✅ ScheduledService started');
  
  // Run immediate matching cycle
  setTimeout(() => {
    console.log('\n🔍 Running immediate matching cycle...');
    matchingService.performMatchingCycle();
  }, 2000);
  
  server.on('error', (error) => {
    console.error('❌ Server error:', error);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    
    if (websocketServer) {
      websocketServer.broadcast({
        type: 'SERVER_SHUTDOWN',
        message: 'Server is shutting down'
      });
    }
    
    server.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
  });
}

module.exports = { app, services };
