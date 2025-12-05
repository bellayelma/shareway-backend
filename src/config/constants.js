// All constants in one place
module.exports = {
  // Collection names
  COLLECTIONS: {
    ACTIVE_SEARCHES_DRIVER: 'active_searches_driver',
    ACTIVE_SEARCHES_PASSENGER: 'active_searches_passenger',
    DRIVER_SCHEDULES: 'driver_schedules',
    ACTIVE_MATCHES: 'active_matches',
    NOTIFICATIONS: 'notifications',
    ACTIVE_RIDES: 'active_rides',
    SCHEDULED_SEARCHES: 'scheduled_searches',
    SCHEDULED_MATCHES: 'scheduled_matches',
    LOCATION_HISTORY: 'location_history',
    POTENTIAL_MATCHES: 'potential_matches'
  },
  
  // Timeouts (in milliseconds)
  TIMEOUTS: {
    MATCH_PROPOSAL: process.env.TEST_MODE === 'true' ? 30000 : 120000,
    IMMEDIATE_SEARCH: 5 * 60 * 1000,
    SCHEDULED_ACTIVATION: process.env.TEST_MODE === 'true' ? 60000 : 30 * 60 * 1000,
    CACHE_TTL: 60000,
    MAX_MATCH_AGE: 300000,
    MATCHING_INTERVAL: process.env.TEST_MODE === 'true' ? 5000 : 30000,
    SCHEDULED_CHECK_INTERVAL: 60000
  },
  
  // Test mode configuration
  TEST_MODE: process.env.TEST_MODE === 'true',
  UNLIMITED_CAPACITY: process.env.UNLIMITED_CAPACITY === 'true',
  
  // Limits
  MAX_LOG_ENTRIES_PER_REQUEST: 3,
  MAX_MATCHES_PER_CYCLE: 10,
  MAX_SEARCHES_PER_USER: 1,
  BATCH_WRITE_LIMIT: 500,
  
  // Matching thresholds
  MATCHING_THRESHOLDS: {
    SIMILARITY: process.env.TEST_MODE === 'true' ? 0.001 : 0.01,
    MAX_DETOUR_DISTANCE: process.env.TEST_MODE === 'true' ? 100.0 : 50.0,
    MAX_PROXIMITY_DISTANCE: 2000, // meters
    MIN_SIMILARITY_TEST: 0.0001
  },
  
  // WebSocket settings
  WEBSOCKET: {
    HEARTBEAT_INTERVAL: 30000,
    CONNECTION_TIMEOUT: 5000
  }
};
