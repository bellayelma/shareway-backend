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
    MATCH_PROPOSAL: process.env.TEST_MODE === 'true' ? 30000 : 300000, // 5 minutes in production, 30 seconds in test
    IMMEDIATE_SEARCH: 5 * 60 * 1000,
    SCHEDULED_ACTIVATION: process.env.TEST_MODE === 'true' ? 60000 : 30 * 60 * 1000,
    CACHE_TTL: 60000,
    MAX_MATCH_AGE: 300000,
    MATCHING_INTERVAL: process.env.TEST_MODE === 'true' ? 5000 : 10000, // 10 seconds in production
    SCHEDULED_CHECK_INTERVAL: 60000,
    
    // NEW: Location sharing constants
    LOCATION_SHARING_DURATION: 15 * 60 * 1000, // 15 minutes
    LOCATION_UPDATE_INTERVAL: 10000, // 10 seconds
    LOCATION_SESSION_CLEANUP: 5 * 60 * 1000 // 5 minutes
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
  },
  
  // Firebase/Firestore settings
  FIRESTORE: {
    MAX_TRANSACTION_RETRIES: 3,
    BATCH_SIZE: 500,
    MAX_CONCURRENT_OPERATIONS: 10
  },
  
  // Matching algorithm settings
  MATCHING: {
    MAX_CANDIDATES_PER_SEARCH: 50,
    MAX_DISTANCE_FOR_INITIAL_FILTER: 5000, // meters
    MAX_TIME_DIFFERENCE: 15 * 60 * 1000, // 15 minutes in milliseconds
    MAX_WAYPOINTS: 3,
    SCORE_WEIGHTS: {
      DISTANCE: 0.4,
      TIME: 0.3,
      RATING: 0.2,
      COMPATIBILITY: 0.1
    }
  },
  
  // Notification settings
  NOTIFICATIONS: {
    MATCH_PROPOSAL_TTL: 2 * 60 * 1000, // 2 minutes
    MAX_RETRIES: 3,
    PRIORITIES: {
      HIGH: 'high',
      NORMAL: 'normal',
      LOW: 'low'
    }
  },
  
  // Ride status constants
  RIDE_STATUS: {
    PENDING: 'pending',
    CONFIRMED: 'confirmed',
    IN_PROGRESS: 'in_progress',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled'
  },
  
  // Match status constants
  MATCH_STATUS: {
    PROPOSED: 'proposed',
    ACCEPTED: 'accepted',
    REJECTED: 'rejected',
    EXPIRED: 'expired',
    CANCELLED: 'cancelled'
  },
  
  // Search types
  SEARCH_TYPES: {
    IMMEDIATE: 'immediate',
    SCHEDULED: 'scheduled'
  },
  
  // User roles
  USER_ROLES: {
    DRIVER: 'driver',
    PASSENGER: 'passenger',
    BOTH: 'both'
  },
  
  // Cache keys
  CACHE_KEYS: {
    USER_LOCATION: (userId) => `user_location:${userId}`,
    ACTIVE_SEARCHES: (userId) => `active_searches:${userId}`,
    MATCH_CANDIDATES: (searchId) => `match_candidates:${searchId}`,
    ROUTE_CACHE: (origin, destination) => `route:${origin}:${destination}`
  },
  
  // Error codes
  ERROR_CODES: {
    SEARCH_LIMIT_EXCEEDED: 'SEARCH_LIMIT_EXCEEDED',
    MATCH_EXPIRED: 'MATCH_EXPIRED',
    RIDE_CANCELLED: 'RIDE_CANCELLED',
    INVALID_LOCATION: 'INVALID_LOCATION',
    NETWORK_ERROR: 'NETWORK_ERROR',
    DATABASE_ERROR: 'DATABASE_ERROR'
  },
  
  // Geospatial settings
  GEO: {
    EARTH_RADIUS_KM: 6371,
    MAX_SEARCH_RADIUS_KM: 10,
    MIN_ACCURACY_METERS: 50,
    LOCATION_UPDATE_INTERVAL: 30000 // 30 seconds
  },
  
  // API endpoints (for reference)
  API_ENDPOINTS: {
    START_SEARCH: '/api/search/start',
    STOP_SEARCH: '/api/search/stop',
    PROPOSE_MATCH: '/api/match/propose',
    RESPOND_TO_MATCH: '/api/match/respond',
    UPDATE_LOCATION: '/api/location/update',
    GET_ACTIVE_RIDES: '/api/rides/active'
  },
  
  // Security settings
  SECURITY: {
    MAX_REQUESTS_PER_MINUTE: 60,
    JWT_EXPIRY: '24h',
    API_KEY_HEADER: 'X-API-Key',
    SESSION_TIMEOUT: 30 * 60 * 1000 // 30 minutes
  }
};
