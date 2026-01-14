/**
 * 🎯 ULTIMATE MATCHING CONFIGURATION SYSTEM
 * Controls how drivers and passengers are matched with intelligent routing
 */

const MATCHING_CONFIG = {
  // ==================== SYSTEM MODES ====================
  SYSTEM_MODE: 'ULTRA_AGGRESSIVE_MATCHING', // Options: ULTRA_AGGRESSIVE_MATCHING, BALANCED, CONSERVATIVE
  FORCE_TEST_MODE: true, // Force all matches (for initial testing)
  AUTO_REPAIR_MATCHES: true, // Auto-fix broken matches
  
  // ==================== MATCHING STRATEGY ====================
  MATCHING_STRATEGY: {
    PRIORITIZE_PROXIMITY: false, // When true, picks closest passengers first
    PRIORITIZE_ROUTE_COMPATIBILITY: true, // When true, picks best route matches
    ALLOW_REVERSE_DIRECTION: false, // Allow matching with opposite direction
    ALLOW_CROSS_CITY: true, // Allow matching across city boundaries
    MAX_MATCHES_PER_CYCLE: 50, // Limit matches per cycle
  },
  
  // ==================== SCORING WEIGHTS (0-1) ====================
  SCORING_WEIGHTS: {
    ROUTE_COMPATIBILITY: 0.5, // How well routes align
    SEAT_FIT: 0.3, // Do passengers fit in available seats
    PROXIMITY_TO_DRIVER: 0.15, // Distance from driver
    WAITING_TIME: 0.05, // How long passenger has waited
  },
  
  // ==================== ROUTE COMPATIBILITY ====================
  ROUTE_THRESHOLDS: {
    MIN_COMPATIBILITY_SCORE: 10, // Minimum score to match (0-100)
    PICKUP_DISTANCE_FROM_ROUTE: 3.0, // Max km pickup can be from driver's route
    DESTINATION_DISTANCE_FROM_ROUTE: 5.0, // Max km destination can be from driver's route
    MAX_DETOUR_DISTANCE: 15.0, // Max km extra driver must travel
    DIRECTION_SIMILARITY_MIN: 0.3, // Minimum direction alignment (0-1)
  },
  
  // ==================== PROXIMITY SETTINGS ====================
  PROXIMITY: {
    MAX_PICKUP_DISTANCE: 25.0, // Max km from driver's current location
    PREFERRED_PICKUP_DISTANCE: 10.0, // Ideal pickup distance
    DISTANCE_DECAY_FACTOR: 0.9, // How quickly score decays with distance
  },
  
  // ==================== REAL-TIME DYNAMIC MATCHING ====================
  DYNAMIC_MATCHING: {
    ENABLED: true,
    UPDATE_INTERVAL: 10000, // Check for new matches every 10 seconds
    MOVEMENT_TRACKING: {
      ENABLED: true,
      MIN_MOVEMENT_SPEED: 5, // km/h minimum to be considered moving
      MOVEMENT_HISTORY_POINTS: 5, // Track last 5 locations
      PREDICT_FUTURE_POSITION: true, // Predict where driver will be in 2 minutes
    },
    ADAPTIVE_PICKUP: {
      ENABLED: true,
      UPDATE_RADIUS: 2000, // Update pickup location within 2km radius
      MIN_TIME_SAVING: 300, // Only update if saves >5 minutes
      CONSIDER_TRAFFIC: false, // Consider traffic conditions (future)
    },
  },
  
  // ==================== CAPACITY & SEATING ====================
  CAPACITY: {
    DEFAULT_CAPACITY: 4,
    ALLOW_OVERBOOKING: false,
    MIN_SEATS_REQUIRED: 1,
    PRIORITIZE_GROUP_SIZE: {
      SMALL_GROUPS: [1, 2], // Prioritize 1-2 passengers
      MEDIUM_GROUPS: [3, 4], // Then 3-4 passengers
      LARGE_GROUPS: [5, 6], // Finally 5-6 passengers
    },
  },
  
  // ==================== TIME-BASED SETTINGS ====================
  TIMING: {
    MAX_WAITING_TIME: 900000, // 15 minutes max wait
    MATCH_EXPIRY: 120000, // 2 minutes for match acceptance
    SEARCH_EXTENSION_TIME: 300000, // 5 minutes auto-extension
    REALTIME_UPDATE_FREQUENCY: 30000, // Update locations every 30 seconds
  },
  
  // ==================== DRIVER BEHAVIOR ====================
  DRIVER_CONTROL: {
    AUTO_STOP_ENABLED: true,
    AUTO_STOP_CONDITIONS: {
      ARRIVED_AT_DESTINATION: true, // Stop when within 1km of destination
      SEATS_FULL: true, // Stop when all seats filled
      MAX_SEARCH_TIME: 3600000, // Stop after 1 hour of searching
      NO_POTENTIAL_MATCHES: 300000, // Stop after 5 minutes with no matches
    },
    BLACKLIST_DURATION: 60000, // 60 seconds blacklist after cancellation
    MIN_DISTANCE_BETWEEN_MATCHES: 1000, // 1km minimum between consecutive pickups
  },
  
  // ==================== PASSENGER PREFERENCES ====================
  PASSENGER_PREFERENCES: {
    PRIORITIZE_RATING: true,
    MIN_DRIVER_RATING: 3.5,
    ALLOW_NEW_DRIVERS: true,
    PREFER_VEHICLE_TYPE: false,
    MAX_ESTIMATED_WAIT_TIME: 900000, // 15 minutes
  },
  
  // ==================== ALGORITHM SETTINGS ====================
  ALGORITHM: {
    USE_BATCH_MATCHING: true,
    BATCH_SIZE: 50,
    USE_OPTIMIZATION_HEURISTICS: true,
    CACHE_DURATION: 30000, // Cache results for 30 seconds
    ENABLE_LEARNING: false, // Machine learning adjustments (future)
  },
  
  // ==================== DEBUG & MONITORING ====================
  DEBUG: {
    LOG_MATCH_SCORES: true,
    LOG_ROUTE_COMPATIBILITY: true,
    LOG_REALTIME_UPDATES: false,
    SEND_DIAGNOSTICS: true,
    PERFORMANCE_MONITORING: true,
  },
  
  // ==================== REGIONAL SETTINGS ====================
  REGIONAL: {
    CITY_CENTER: { lat: 8.550023, lng: 39.266712 }, // Adama, Ethiopia
    CITY_RADIUS_KM: 50,
    MAIN_ROUTES: [
      {
        name: 'Adama to Dire Dawa',
        start: { lat: 8.550023, lng: 39.266712 },
        end: { lat: 9.589549, lng: 41.866169 },
        highway: true,
        distance: 350, // km
      },
      {
        name: 'Adama to Addis Ababa',
        start: { lat: 8.550023, lng: 39.266712 },
        end: { lat: 9.032220, lng: 38.746033 },
        highway: true,
        distance: 100, // km
      },
    ],
  },
  
  // ==================== NOTIFICATION SETTINGS ====================
  NOTIFICATIONS: {
    SEND_MATCH_PROPOSAL: true,
    SEND_LOCATION_UPDATES: true,
    SEND_ETA_UPDATES: true,
    NOTIFY_DRIVER_ON_PASSENGER_ACCEPT: true,
    NOTIFY_PASSENGER_ON_DRIVER_ACCEPT: true,
  },
  
  // ==================== FALLBACK SETTINGS ====================
  FALLBACK: {
    ENABLED: true,
    AFTER_NO_MATCHES_SECONDS: 300, // After 5 minutes with no matches
    EXPAND_SEARCH_RADIUS: true,
    EXPANDED_RADIUS_MULTIPLIER: 2,
    RELAX_ROUTE_REQUIREMENTS: true,
    ACCEPT_LOWER_RATINGS: true,
  },
};

// ==================== MATCHING STRATEGY PROFILES ====================
const MATCHING_PROFILES = {
  ULTRA_AGGRESSIVE_MATCHING: {
    description: 'Match everyone possible for initial testing',
    config: {
      SCORING_WEIGHTS: {
        ROUTE_COMPATIBILITY: 0.1,
        SEAT_FIT: 0.3,
        PROXIMITY_TO_DRIVER: 0.3,
        WAITING_TIME: 0.3,
      },
      ROUTE_THRESHOLDS: {
        MIN_COMPATIBILITY_SCORE: 0,
        PICKUP_DISTANCE_FROM_ROUTE: 50.0,
        DESTINATION_DISTANCE_FROM_ROUTE: 50.0,
        MAX_DETOUR_DISTANCE: 50.0,
        DIRECTION_SIMILARITY_MIN: 0.0,
      },
      PROXIMITY: {
        MAX_PICKUP_DISTANCE: 50.0,
        PREFERRED_PICKUP_DISTANCE: 25.0,
      },
      FORCE_TEST_MODE: true,
    },
  },
  
  BALANCED: {
    description: 'Balanced approach for normal operation',
    config: {
      SCORING_WEIGHTS: {
        ROUTE_COMPATIBILITY: 0.5,
        SEAT_FIT: 0.3,
        PROXIMITY_TO_DRIVER: 0.15,
        WAITING_TIME: 0.05,
      },
      ROUTE_THRESHOLDS: {
        MIN_COMPATIBILITY_SCORE: 30,
        PICKUP_DISTANCE_FROM_ROUTE: 3.0,
        DESTINATION_DISTANCE_FROM_ROUTE: 5.0,
        MAX_DETOUR_DISTANCE: 15.0,
        DIRECTION_SIMILARITY_MIN: 0.5,
      },
      FORCE_TEST_MODE: false,
    },
  },
  
  CONSERVATIVE: {
    description: 'Only match perfect routes',
    config: {
      SCORING_WEIGHTS: {
        ROUTE_COMPATIBILITY: 0.8,
        SEAT_FIT: 0.2,
        PROXIMITY_TO_DRIVER: 0.0,
        WAITING_TIME: 0.0,
      },
      ROUTE_THRESHOLDS: {
        MIN_COMPATIBILITY_SCORE: 70,
        PICKUP_DISTANCE_FROM_ROUTE: 1.0,
        DESTINATION_DISTANCE_FROM_ROUTE: 2.0,
        MAX_DETOUR_DISTANCE: 5.0,
        DIRECTION_SIMILARITY_MIN: 0.8,
      },
      FORCE_TEST_MODE: false,
    },
  },
};

// ==================== HELPER FUNCTIONS ====================
class MatchingConfigManager {
  constructor() {
    this.currentProfile = MATCHING_CONFIG.SYSTEM_MODE;
    this.activeConfig = this.getActiveConfig();
  }
  
  // Get current active configuration
  getActiveConfig() {
    const profile = MATCHING_PROFILES[this.currentProfile]?.config || {};
    return {
      ...MATCHING_CONFIG,
      ...profile,
    };
  }
  
  // Switch to a different matching profile
  switchProfile(profileName) {
    if (MATCHING_PROFILES[profileName]) {
      this.currentProfile = profileName;
      this.activeConfig = this.getActiveConfig();
      console.log(`🔄 Switched to ${profileName} matching profile`);
      return true;
    }
    return false;
  }
  
  // Get configuration for scoring
  getScoringConfig() {
    return {
      weights: this.activeConfig.SCORING_WEIGHTS,
      thresholds: this.activeConfig.ROUTE_THRESHOLDS,
      proximity: this.activeConfig.PROXIMITY,
    };
  }
  
  // Check if a match should be forced (test mode)
  shouldForceMatch() {
    return this.activeConfig.FORCE_TEST_MODE;
  }
  
  // Calculate dynamic proximity score based on distance
  calculateProximityScore(distanceInKm) {
    const { MAX_PICKUP_DISTANCE, PREFERRED_PICKUP_DISTANCE, DISTANCE_DECAY_FACTOR } = 
      this.activeConfig.PROXIMITY;
    
    if (distanceInKm > MAX_PICKUP_DISTANCE) return 0;
    
    if (distanceInKm <= PREFERRED_PICKUP_DISTANCE) {
      return 100;
    }
    
    // Exponential decay after preferred distance
    const decay = Math.pow(DISTANCE_DECAY_FACTOR, 
      (distanceInKm - PREFERRED_PICKUP_DISTANCE));
    return Math.max(0, Math.round(100 * decay));
  }
  
  // Calculate waiting time score
  calculateWaitingTimeScore(waitingTimeMs) {
    const maxWait = this.activeConfig.TIMING.MAX_WAITING_TIME;
    if (waitingTimeMs >= maxWait) return 100;
    
    return Math.round((waitingTimeMs / maxWait) * 100);
  }
  
  // Check if route is compatible based on thresholds
  isRouteCompatible(compatibilityData) {
    const thresholds = this.activeConfig.ROUTE_THRESHOLDS;
    
    return (
      compatibilityData.score >= thresholds.MIN_COMPATIBILITY_SCORE &&
      compatibilityData.pickupDistance <= thresholds.PICKUP_DISTANCE_FROM_ROUTE &&
      compatibilityData.destDistance <= thresholds.DESTINATION_DISTANCE_FROM_ROUTE &&
      compatibilityData.detourDistance <= thresholds.MAX_DETOUR_DISTANCE &&
      compatibilityData.directionSimilarity >= thresholds.DIRECTION_SIMILARITY_MIN
    );
  }
  
  // Get batch matching configuration
  getBatchConfig() {
    return {
      enabled: this.activeConfig.ALGORITHM.USE_BATCH_MATCHING,
      batchSize: this.activeConfig.ALGORITHM.BATCH_SIZE,
      useHeuristics: this.activeConfig.ALGORITHM.USE_OPTIMIZATION_HEURISTICS,
    };
  }
  
  // Get real-time matching configuration
  getRealtimeConfig() {
    return {
      enabled: this.activeConfig.DYNAMIC_MATCHING.ENABLED,
      updateInterval: this.activeConfig.DYNAMIC_MATCHING.UPDATE_INTERVAL,
      movementTracking: this.activeConfig.DYNAMIC_MATCHING.MOVEMENT_TRACKING,
      adaptivePickup: this.activeConfig.DYNAMIC_MATCHING.ADAPTIVE_PICKUP,
    };
  }
  
  // Get driver auto-stop conditions
  getAutoStopConditions() {
    return this.activeConfig.DRIVER_CONTROL.AUTO_STOP_CONDITIONS;
  }
  
  // Check if fallback should be activated
  shouldActivateFallback(searchStartTime) {
    if (!this.activeConfig.FALLBACK.ENABLED) return false;
    
    const timeWaiting = Date.now() - searchStartTime;
    return timeWaiting > (this.activeConfig.FALLBACK.AFTER_NO_MATCHES_SECONDS * 1000);
  }
  
  // Get fallback configuration
  getFallbackConfig() {
    return {
      expandRadius: this.activeConfig.FALLBACK.EXPAND_SEARCH_RADIUS,
      radiusMultiplier: this.activeConfig.FALLBACK.EXPANDED_RADIUS_MULTIPLIER,
      relaxRoute: this.activeConfig.FALLBACK.RELAX_ROUTE_REQUIREMENTS,
      acceptLowerRatings: this.activeConfig.FALLBACK.ACCEPT_LOWER_RATINGS,
    };
  }
  
  // Log current configuration
  logConfiguration() {
    console.log('\n🎯 ACTIVE MATCHING CONFIGURATION:');
    console.log(`   Profile: ${this.currentProfile}`);
    console.log(`   Description: ${MATCHING_PROFILES[this.currentProfile]?.description}`);
    console.log(`   Force Test Mode: ${this.activeConfig.FORCE_TEST_MODE ? '✅ ON' : '❌ OFF'}`);
    console.log(`   Dynamic Matching: ${this.activeConfig.DYNAMIC_MATCHING.ENABLED ? '✅ ON' : '❌ OFF'}`);
    console.log(`   Auto-Stop: ${this.activeConfig.DRIVER_CONTROL.AUTO_STOP_ENABLED ? '✅ ON' : '❌ OFF'}`);
    console.log(`   Batch Matching: ${this.activeConfig.ALGORITHM.USE_BATCH_MATCHING ? '✅ ON' : '❌ OFF'}`);
    console.log('\n   Scoring Weights:');
    console.log(`     Route: ${this.activeConfig.SCORING_WEIGHTS.ROUTE_COMPATIBILITY}`);
    console.log(`     Seats: ${this.activeConfig.SCORING_WEIGHTS.SEAT_FIT}`);
    console.log(`     Proximity: ${this.activeConfig.SCORING_WEIGHTS.PROXIMITY_TO_DRIVER}`);
    console.log(`     Waiting: ${this.activeConfig.SCORING_WEIGHTS.WAITING_TIME}`);
    console.log('\n   Route Thresholds:');
    console.log(`     Min Score: ${this.activeConfig.ROUTE_THRESHOLDS.MIN_COMPATIBILITY_SCORE}`);
    console.log(`     Max Pickup Distance: ${this.activeConfig.ROUTE_THRESHOLDS.PICKUP_DISTANCE_FROM_ROUTE}km`);
    console.log(`     Max Detour: ${this.activeConfig.ROUTE_THRESHOLDS.MAX_DETOUR_DISTANCE}km`);
  }
}

// Create singleton instance
const matchingConfigManager = new MatchingConfigManager();

module.exports = {
  MATCHING_CONFIG,
  MATCHING_PROFILES,
  matchingConfigManager,
};
