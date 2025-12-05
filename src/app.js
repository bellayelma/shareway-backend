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
      cache: cache.stats()
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
  
  // Initialize other services with WebSocket
  searchService = new SearchService(firestoreService, websocketServer);
  rideService = new RideService(firestoreService, websocketServer);
  matchingService = new MatchingService(firestoreService, searchService, websocketServer);
  scheduledService = new ScheduledService(firestoreService, websocketServer, admin); // PASS ADMIN HERE
  
  // Update services container
  services.websocketServer = websocketServer;
  services.searchService = searchService;
  services.rideService = rideService;
  services.matchingService = matchingService;
  services.scheduledService = scheduledService;
  
  // Re-initialize controllers with complete services
  matchController.init(services);
  searchController.init(services);
  driverController.init(services);
  passengerController.init(services);
  rideController.init(services);
  
  // Register all routes
  app.use('/api/search', searchController.router);
  app.use('/api/driver', driverController.router);
  app.use('/api/passenger', passengerController.router);
  app.use('/api/ride', rideController.router);
  
  // Start services
  matchingService.start();
  scheduledService.start();
  
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
