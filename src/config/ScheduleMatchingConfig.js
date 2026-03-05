/**
 * 🎯 SCHEDULE MATCHING CONFIGURATION SYSTEM
 * Complete control over scheduled ride matching behavior
 * Can be modified at runtime via API or config file
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/Logger');

// ==================== DEFAULT CONFIGURATION ====================
const DEFAULT_CONFIG = {
  // ==================== SYSTEM MODES ====================
  SYSTEM_MODE: 'PROGRESSIVE_MATCHING', // Options: PROGRESSIVE_MATCHING, AGGRESSIVE, CONSERVATIVE
  ENABLED: true,
  DEBUG_MODE: false,
  
  // ==================== MATCHING PROFILES ====================
  PROFILES: {
    PROGRESSIVE_MATCHING: {
      description: 'Standard progressive matching with decreasing radius',
      matching_strategy: 'TIME_BASED_WINDOWS',
      window_behavior: 'DECREASING_RADIUS',
      notification_strategy: 'PROGRESSIVE'
    },
    AGGRESSIVE: {
      description: 'Match as early as possible, wider acceptance',
      matching_strategy: 'EARLY_MATCHING',
      window_behavior: 'CONSTANT_RADIUS',
      notification_strategy: 'IMMEDIATE'
    },
    CONSERVATIVE: {
      description: 'Only match when very close, high compatibility required',
      matching_strategy: 'LAST_MINUTE',
      window_behavior: 'STRICT_RADIUS',
      notification_strategy: 'MINIMAL'
    }
  },
  
  // ==================== TIME WINDOWS CONFIGURATION ====================
  TIME_WINDOWS: {
    // Window name: [hours_before_schedule, check_interval_minutes, radius_km]
    '24h': {
      name: 'Early Discovery',
      hours_before: 24,
      check_interval: 60, // minutes
      radius_km: 20,
      max_matches_per_window: 3,
      enabled: true,
      priority: 1
    },
    '12h': {
      name: 'Confirmation Phase',
      hours_before: 12,
      check_interval: 30,
      radius_km: 10,
      max_matches_per_window: 5,
      enabled: true,
      priority: 2
    },
    '6h': {
      name: 'Finalization',
      hours_before: 6,
      check_interval: 15,
      radius_km: 5,
      max_matches_per_window: 8,
      enabled: true,
      priority: 3
    },
    '3h': {
      name: 'Reminder & Updates',
      hours_before: 3,
      check_interval: 10,
      radius_km: 3,
      max_matches_per_window: 10,
      enabled: true,
      priority: 4
    },
    '1h': {
      name: 'Preparation',
      hours_before: 1,
      check_interval: 5,
      radius_km: 1,
      max_matches_per_window: 15,
      enabled: true,
      priority: 5
    },
    '30m': {
      name: 'Activation',
      hours_before: 0.5,
      check_interval: 2,
      radius_km: 0.5,
      max_matches_per_window: 20,
      enabled: true,
      priority: 6
    }
  },
  
  // ==================== MATCHING ALGORITHM CONFIGURATION ====================
  MATCHING_ALGORITHM: {
    // Scoring weights (must sum to 1.0)
    SCORING_WEIGHTS: {
      TIME_COMPATIBILITY: 0.40,    // How close scheduled times match
      DISTANCE_COMPATIBILITY: 0.30, // Pickup location proximity
      ROUTE_COMPATIBILITY: 0.20,    // Route alignment
      GROUP_SIZE_COMPATIBILITY: 0.10 // Passenger count vs driver capacity
    },
    
    // Compatibility thresholds
    THRESHOLDS: {
      MIN_TOTAL_SCORE: 60,          // 0-100, minimum to create match
      MAX_TIME_DIFFERENCE: 30,      // minutes, max schedule time difference
      DIRECTION_SIMILARITY_MIN: 0.3, // 0-1, min route direction alignment
      MAX_DETOUR_PERCENTAGE: 0.25   // 25% max detour for driver
    },
    
    // Route calculation
    ROUTE_CALCULATION: {
      USE_OSRM_API: false,          // Use external routing API
      FALLBACK_TO_HAVERSINE: true,  // Use simple distance if API fails
      CACHE_DURATION: 3600000,      // Cache routes for 1 hour
      MAX_WAYPOINTS: 10             // Max points for route calculation
    }
  },
  
  // ==================== CAPACITY & GROUP MANAGEMENT ====================
  CAPACITY_MANAGEMENT: {
    DEFAULT_DRIVER_CAPACITY: 4,
    ALLOW_OVERBOOKING: false,
    OVERBOOKING_LIMIT: 1,           // Max 1 extra passenger
    GROUP_PRIORITIZATION: {
      PRIORITIZE_SINGLE_PASSENGERS: true,
      PRIORITIZE_SMALL_GROUPS: true,
      MAX_GROUP_SPLIT: 2            // Split groups into max 2 parts
    },
    MIN_SEATS_FOR_MATCH: 1
  },
  
  // ==================== NOTIFICATION & USER EXPERIENCE ====================
  NOTIFICATIONS: {
    // When to notify users
    NOTIFY_ON_MATCH_PROPOSAL: true,
    NOTIFY_ON_MATCH_ACCEPTANCE: true,
    NOTIFY_ON_MATCH_DECLINE: true,
    NOTIFY_ON_SCHEDULE_REMINDER: true,
    NOTIFY_ON_ACTIVATION: true,
    
    // Notification timing
    REMINDER_SCHEDULE: {
      '24h': true,  // 24 hours before
      '12h': true,  // 12 hours before
      '6h': true,   // 6 hours before
      '3h': true,   // 3 hours before
      '1h': true    // 1 hour before
    },
    
    // Match proposal expiration
    PROPOSAL_EXPIRY: {
      '24h': 720,   // 12 hours for early matches
      '12h': 360,   // 6 hours
      '6h': 180,    // 3 hours
      '3h': 60,     // 1 hour
      '1h': 30,     // 30 minutes
      '30m': 15     // 15 minutes
    }
  },
  
  // ==================== LOCATION & GEOGRAPHIC SETTINGS ====================
  GEOGRAPHIC: {
    // Default city center (Adama, Ethiopia)
    DEFAULT_CITY_CENTER: {
      lat: 8.550023,
      lng: 39.266712,
      name: 'Adama City Center'
    },
    
    // Maximum search boundaries
    MAX_SEARCH_RADIUS_KM: 50,
    MIN_VALID_LOCATION_ACCURACY: 100, // meters
    
    // Route compatibility regions
    ROUTE_REGIONS: [
      {
        name: 'Adama Metropolitan',
        center: { lat: 8.550023, lng: 39.266712 },
        radius_km: 15
      },
      {
        name: 'Adama to Addis Ababa Corridor',
        center: { lat: 8.790022, lng: 39.050000 },
        radius_km: 25
      },
      {
        name: 'Adama to Dire Dawa Corridor',
        center: { lat: 9.000000, lng: 40.000000 },
        radius_km: 30
      }
    ]
  },
  
  // ==================== PERFORMANCE & SCALING ====================
  PERFORMANCE: {
    // Batch processing
    BATCH_SIZE: 50,
    MAX_CONCURRENT_WINDOWS: 2,
    PROCESSING_TIMEOUT: 30000, // 30 seconds per window
    
    // Caching
    CACHE_ENABLED: true,
    CACHE_DURATION: 300000, // 5 minutes
    MAX_CACHE_SIZE: 1000,
    
    // Database optimization
    USE_COMPOUND_INDEXES: true,
    QUERY_LIMIT: 100,
    BULK_WRITE_SIZE: 100
  },
  
  // ==================== FALLBACK & ERROR HANDLING ====================
  FALLBACK_MECHANISMS: {
    // When normal matching fails
    ENABLED: true,
    ACTIVATE_AFTER_FAILED_CYCLES: 3,
    
    // Fallback strategies
    STRATEGIES: {
      EXPAND_SEARCH_RADIUS: true,
      RADIUS_MULTIPLIER: 1.5,
      
      RELAX_TIME_CONSTRAINTS: true,
      MAX_TIME_DIFF_FALLBACK: 60, // 1 hour
      
      RELAX_ROUTE_REQUIREMENTS: true,
      MIN_DIRECTION_SIMILARITY: 0.1,
      
      ALLOW_CROSS_REGION: false,
      CROSS_REGION_PENALTY: 20 // Score penalty
    },
    
    // Automatic recovery
    AUTO_RECOVERY: {
      ENABLED: true,
      RESET_AFTER_SUCCESSFUL_MATCHES: 10,
      GRADUAL_TIGHTENING: true
    }
  },
  
  // ==================== MONITORING & ANALYTICS ====================
  MONITORING: {
    ENABLED: true,
    LOG_LEVEL: 'INFO', // DEBUG, INFO, WARN, ERROR
    METRICS_COLLECTION: {
      MATCH_SUCCESS_RATE: true,
      AVERAGE_MATCH_SCORE: true,
      WINDOW_PERFORMANCE: true,
      USER_SATISFACTION: true
    },
    
    ALERTS: {
      LOW_MATCH_RATE_THRESHOLD: 0.3, // 30%
      HIGH_FAILURE_RATE_THRESHOLD: 0.5, // 50%
      SEND_EMAIL_ALERTS: false,
      SEND_SLACK_ALERTS: false
    },
    
    STATS_INTERVAL: 300000 // 5 minutes
  },
  
  // ==================== ADMINISTRATIVE CONTROLS ====================
  ADMIN_CONTROLS: {
    // Emergency controls
    EMERGENCY_STOP: false,
    PAUSE_MATCHING: false,
    MAINTENANCE_MODE: false,
    
    // Rate limiting
    RATE_LIMITING: {
      ENABLED: true,
      REQUESTS_PER_MINUTE: 100,
      MATCHES_PER_USER_PER_DAY: 10
    },
    
    // Manual override
    MANUAL_OVERRIDE_ENABLED: true,
    FORCE_MATCH_ENABLED: false,
    MANUAL_MATCH_EXPIRY: 3600000 // 1 hour
  },
  
  // ==================== VERSION & DEPLOYMENT ====================
  VERSION: {
    CONFIG_VERSION: '1.0.0',
    SCHEMA_VERSION: 1,
    LAST_UPDATED: new Date().toISOString(),
    COMPATIBLE_SERVICES: ['ScheduleMatchingService-v2.0+']
  }
};

// ==================== CONFIGURATION MANAGER CLASS ====================
class ScheduleMatchingConfigManager {
  constructor(configPath = null) {
    this.config = { ...DEFAULT_CONFIG };
    this.configPath = configPath || path.join(__dirname, 'schedule-matching-config.json');
    this.configListeners = [];
    this.initialized = false;
    this.lastModified = null;
    
    // Validation schema
    this.validationSchema = this.createValidationSchema();
    
    logger.info('SCHEDULE_CONFIG', 'Schedule Matching Configuration Manager initialized');
  }
  
  // ==================== INITIALIZATION ====================
  async initialize() {
    try {
      // Try to load external config file
      await this.loadExternalConfig();
      
      // Validate loaded configuration
      const validationResult = this.validateConfig(this.config);
      if (!validationResult.valid) {
        logger.error('SCHEDULE_CONFIG', `Config validation failed: ${validationResult.errors.join(', ')}`);
        throw new Error(`Invalid configuration: ${validationResult.errors.join(', ')}`);
      }
      
      this.initialized = true;
      this.lastModified = new Date();
      
      // Start watching for config changes
      this.startConfigWatcher();
      
      logger.info('SCHEDULE_CONFIG', `Configuration loaded successfully. Mode: ${this.config.SYSTEM_MODE}`);
      this.logCurrentSettings();
      
      return true;
    } catch (error) {
      logger.warn('SCHEDULE_CONFIG', `Using default configuration: ${error.message}`);
      this.initialized = true;
      return true; // Continue with defaults
    }
  }
  
  // ==================== CONFIGURATION LOADING ====================
  async loadExternalConfig() {
    try {
      const configData = await fs.readFile(this.configPath, 'utf8');
      const externalConfig = JSON.parse(configData);
      
      // Deep merge with defaults
      this.config = this.deepMerge(this.config, externalConfig);
      
      // Update version timestamp
      this.config.VERSION.LAST_UPDATED = new Date().toISOString();
      
      logger.info('SCHEDULE_CONFIG', `Loaded external configuration from: ${this.configPath}`);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Config file doesn't exist, create it with defaults
        await this.saveConfigToFile();
        logger.info('SCHEDULE_CONFIG', `Created new config file at: ${this.configPath}`);
      } else {
        throw error;
      }
    }
  }
  
  async saveConfigToFile() {
    try {
      const configDir = path.dirname(this.configPath);
      await fs.mkdir(configDir, { recursive: true });
      
      const configJson = JSON.stringify(this.config, null, 2);
      await fs.writeFile(this.configPath, configJson, 'utf8');
      
      logger.info('SCHEDULE_CONFIG', `Configuration saved to: ${this.configPath}`);
      return true;
    } catch (error) {
      logger.error('SCHEDULE_CONFIG', `Failed to save config: ${error.message}`);
      return false;
    }
  }
  
  // ==================== CONFIGURATION ACCESS ====================
  getConfig() {
    return { ...this.config }; // Return copy to prevent mutation
  }
  
  getActiveProfile() {
    return this.config.SYSTEM_MODE;
  }
  
  getProfileConfig(profileName) {
    return this.config.PROFILES[profileName] || null;
  }
  
  getTimeWindows() {
    return { ...this.config.TIME_WINDOWS };
  }
  
  getEnabledWindows() {
    const windows = this.config.TIME_WINDOWS;
    return Object.entries(windows)
      .filter(([_, config]) => config.enabled)
      .sort((a, b) => a[1].priority - b[1].priority)
      .reduce((acc, [key, value]) => {
        acc[key] = value;
        return acc;
      }, {});
  }
  
  getMatchingAlgorithmConfig() {
    return { ...this.config.MATCHING_ALGORITHM };
  }
  
  getScoringWeights() {
    return { ...this.config.MATCHING_ALGORITHM.SCORING_WEIGHTS };
  }
  
  getThresholds() {
    return { ...this.config.MATCHING_ALGORITHM.THRESHOLDS };
  }
  
  getGeographicConfig() {
    return { ...this.config.GEOGRAPHIC };
  }
  
  getPerformanceConfig() {
    return { ...this.config.PERFORMANCE };
  }
  
  getFallbackConfig() {
    return { ...this.config.FALLBACK_MECHANISMS };
  }
  
  // ==================== CONFIGURATION MODIFICATION ====================
  async updateConfig(newConfig, partial = true) {
    try {
      const oldConfig = { ...this.config };
      
      if (partial) {
        // Merge partial update
        this.config = this.deepMerge(this.config, newConfig);
      } else {
        // Full replace (with defaults fallback)
        this.config = this.deepMerge(DEFAULT_CONFIG, newConfig);
      }
      
      // Validate updated configuration
      const validationResult = this.validateConfig(this.config);
      if (!validationResult.valid) {
        this.config = oldConfig; // Revert
        throw new Error(`Configuration validation failed: ${validationResult.errors.join(', ')}`);
      }
      
      // Update timestamp
      this.config.VERSION.LAST_UPDATED = new Date().toISOString();
      this.lastModified = new Date();
      
      // Save to file
      await this.saveConfigToFile();
      
      // Notify listeners
      this.notifyConfigChange(this.config);
      
      logger.info('SCHEDULE_CONFIG', 'Configuration updated successfully');
      return true;
    } catch (error) {
      logger.error('SCHEDULE_CONFIG', `Failed to update config: ${error.message}`);
      throw error;
    }
  }
  
  async switchProfile(profileName) {
    const profile = this.config.PROFILES[profileName];
    if (!profile) {
      throw new Error(`Profile "${profileName}" not found`);
    }
    
    const oldMode = this.config.SYSTEM_MODE;
    this.config.SYSTEM_MODE = profileName;
    
    try {
      await this.updateConfig({ SYSTEM_MODE: profileName }, true);
      logger.info('SCHEDULE_CONFIG', `Switched from ${oldMode} to ${profileName} profile`);
      return true;
    } catch (error) {
      this.config.SYSTEM_MODE = oldMode; // Revert
      throw error;
    }
  }
  
  async updateTimeWindow(windowName, windowConfig) {
    if (!this.config.TIME_WINDOWS[windowName]) {
      throw new Error(`Time window "${windowName}" not found`);
    }
    
    const updatedConfig = {
      TIME_WINDOWS: {
        [windowName]: windowConfig
      }
    };
    
    return this.updateConfig(updatedConfig, true);
  }
  
  async updateScoringWeights(weights) {
    // Validate weights sum to ~1.0
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1.0) > 0.01) {
      throw new Error(`Scoring weights must sum to 1.0 (current sum: ${sum})`);
    }
    
    const updatedConfig = {
      MATCHING_ALGORITHM: {
        SCORING_WEIGHTS: weights
      }
    };
    
    return this.updateConfig(updatedConfig, true);
  }
  
  // ==================== CALCULATION HELPERS ====================
  calculateWindowCheckInterval(windowName) {
    const window = this.config.TIME_WINDOWS[windowName];
    if (!window) return 60000; // Default 1 minute
    
    return window.check_interval * 60 * 1000; // Convert minutes to milliseconds
  }
  
  calculateWindowRadius(windowName) {
    const window = this.config.TIME_WINDOWS[windowName];
    if (!window) return 10000; // Default 10km in meters
    
    return window.radius_km * 1000; // Convert km to meters
  }
  
  calculateMaxMatchesForWindow(windowName) {
    const window = this.config.TIME_WINDOWS[windowName];
    return window?.max_matches_per_window || 10;
  }
  
  calculateMatchScore(timeScore, distanceScore, routeScore, groupScore) {
    const weights = this.config.MATCHING_ALGORITHM.SCORING_WEIGHTS;
    
    return (
      timeScore * weights.TIME_COMPATIBILITY +
      distanceScore * weights.DISTANCE_COMPATIBILITY +
      routeScore * weights.ROUTE_COMPATIBILITY +
      groupScore * weights.GROUP_SIZE_COMPATIBILITY
    );
  }
  
  isMatchAcceptable(matchData) {
    const thresholds = this.config.MATCHING_ALGORITHM.THRESHOLDS;
    
    return (
      matchData.totalScore >= thresholds.MIN_TOTAL_SCORE &&
      matchData.timeDifference <= thresholds.MAX_TIME_DIFFERENCE &&
      matchData.directionSimilarity >= thresholds.DIRECTION_SIMILARITY_MIN
    );
  }
  
  // ==================== EVENT LISTENERS ====================
  addConfigListener(callback) {
    this.configListeners.push(callback);
  }
  
  removeConfigListener(callback) {
    this.configListeners = this.configListeners.filter(cb => cb !== callback);
  }
  
  notifyConfigChange(newConfig) {
    this.configListeners.forEach(callback => {
      try {
        callback(newConfig);
      } catch (error) {
        logger.error('SCHEDULE_CONFIG', `Config listener error: ${error.message}`);
      }
    });
  }
  
  // ==================== FILE WATCHER ====================
  startConfigWatcher() {
    if (this.configWatcher) return;
    
    try {
      const chokidar = require('chokidar');
      this.configWatcher = chokidar.watch(this.configPath, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 2000,
          pollInterval: 100
        }
      });
      
      this.configWatcher.on('change', async (path) => {
        logger.info('SCHEDULE_CONFIG', `Config file changed: ${path}`);
        try {
          await this.loadExternalConfig();
          this.notifyConfigChange(this.config);
        } catch (error) {
          logger.error('SCHEDULE_CONFIG', `Failed to reload config: ${error.message}`);
        }
      });
      
      logger.info('SCHEDULE_CONFIG', `Watching config file: ${this.configPath}`);
    } catch (error) {
      logger.warn('SCHEDULE_CONFIG', `File watching not available: ${error.message}`);
    }
  }
  
  stopConfigWatcher() {
    if (this.configWatcher) {
      this.configWatcher.close();
      this.configWatcher = null;
    }
  }
  
  // ==================== VALIDATION ====================
  createValidationSchema() {
    return {
      SYSTEM_MODE: { type: 'string', required: true },
      TIME_WINDOWS: { type: 'object', required: true },
      MATCHING_ALGORITHM: { type: 'object', required: true },
      SCORING_WEIGHTS: { type: 'object', required: true }
    };
  }
  
  validateConfig(config) {
    const errors = [];
    
    // Check required fields
    if (!config.SYSTEM_MODE) errors.push('SYSTEM_MODE is required');
    if (!config.TIME_WINDOWS) errors.push('TIME_WINDOWS is required');
    if (!config.MATCHING_ALGORITHM) errors.push('MATCHING_ALGORITHM is required');
    
    // Validate scoring weights sum to 1
    if (config.MATCHING_ALGORITHM?.SCORING_WEIGHTS) {
      const weights = config.MATCHING_ALGORITHM.SCORING_WEIGHTS;
      const sum = Object.values(weights).reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 1.0) > 0.01) {
        errors.push(`Scoring weights must sum to 1.0 (current: ${sum})`);
      }
    }
    
    // Validate time windows
    if (config.TIME_WINDOWS) {
      Object.entries(config.TIME_WINDOWS).forEach(([key, window]) => {
        if (!window.name) errors.push(`Window ${key}: name is required`);
        if (window.radius_km <= 0) errors.push(`Window ${key}: radius_km must be positive`);
        if (window.check_interval <= 0) errors.push(`Window ${key}: check_interval must be positive`);
      });
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
  
  // ==================== UTILITY METHODS ====================
  deepMerge(target, source) {
    const output = { ...target };
    
    if (this.isObject(target) && this.isObject(source)) {
      Object.keys(source).forEach(key => {
        if (this.isObject(source[key])) {
          if (!(key in target)) {
            output[key] = source[key];
          } else {
            output[key] = this.deepMerge(target[key], source[key]);
          }
        } else {
          output[key] = source[key];
        }
      });
    }
    
    return output;
  }
  
  isObject(item) {
    return item && typeof item === 'object' && !Array.isArray(item);
  }
  
  // ==================== LOGGING & DIAGNOSTICS ====================
  logCurrentSettings() {
    const enabledWindows = Object.keys(this.getEnabledWindows()).length;
    const activeProfile = this.config.SYSTEM_MODE;
    
    logger.info('SCHEDULE_CONFIG', 'Current Configuration Summary:');
    logger.info('SCHEDULE_CONFIG', `  Active Profile: ${activeProfile}`);
    logger.info('SCHEDULE_CONFIG', `  Enabled Time Windows: ${enabledWindows}`);
    logger.info('SCHEDULE_CONFIG', `  Scoring Weights: ${JSON.stringify(this.config.MATCHING_ALGORITHM.SCORING_WEIGHTS)}`);
    logger.info('SCHEDULE_CONFIG', `  Min Match Score: ${this.config.MATCHING_ALGORITHM.THRESHOLDS.MIN_TOTAL_SCORE}`);
    logger.info('SCHEDULE_CONFIG', `  Max Time Difference: ${this.config.MATCHING_ALGORITHM.THRESHOLDS.MAX_TIME_DIFFERENCE} minutes`);
  }
  
  getDiagnostics() {
    return {
      initialized: this.initialized,
      configPath: this.configPath,
      activeProfile: this.config.SYSTEM_MODE,
      lastModified: this.lastModified,
      configVersion: this.config.VERSION.CONFIG_VERSION,
      enabledWindows: Object.keys(this.getEnabledWindows()),
      scoringWeights: this.config.MATCHING_ALGORITHM.SCORING_WEIGHTS
    };
  }
  
  // ==================== API FOR EXTERNAL ACCESS ====================
  getConfigAPI() {
    return {
      // Getters
      getConfig: () => this.getConfig(),
      getActiveProfile: () => this.getActiveProfile(),
      getTimeWindows: () => this.getTimeWindows(),
      getScoringWeights: () => this.getScoringWeights(),
      getThresholds: () => this.getThresholds(),
      getDiagnostics: () => this.getDiagnostics(),
      
      // Setters
      updateConfig: (newConfig, partial = true) => this.updateConfig(newConfig, partial),
      switchProfile: (profileName) => this.switchProfile(profileName),
      updateScoringWeights: (weights) => this.updateScoringWeights(weights),
      updateTimeWindow: (windowName, config) => this.updateTimeWindow(windowName, config),
      
      // Calculations
      calculateWindowCheckInterval: (windowName) => this.calculateWindowCheckInterval(windowName),
      calculateWindowRadius: (windowName) => this.calculateWindowRadius(windowName),
      calculateMatchScore: (time, distance, route, group) => 
        this.calculateMatchScore(time, distance, route, group),
      isMatchAcceptable: (matchData) => this.isMatchAcceptable(matchData),
      
      // Events
      addConfigListener: (callback) => this.addConfigListener(callback),
      removeConfigListener: (callback) => this.removeConfigListener(callback),
      
      // Management
      reloadConfig: () => this.loadExternalConfig(),
      saveConfig: () => this.saveConfigToFile(),
      resetToDefaults: async () => {
        this.config = { ...DEFAULT_CONFIG };
        await this.saveConfigToFile();
        this.notifyConfigChange(this.config);
      }
    };
  }
  
  // ==================== CLEANUP ====================
  async shutdown() {
    this.stopConfigWatcher();
    this.configListeners = [];
    logger.info('SCHEDULE_CONFIG', 'Configuration Manager shut down');
  }
}

// Create singleton instance
let configManagerInstance = null;

function getScheduleMatchingConfigManager(configPath = null) {
  if (!configManagerInstance) {
    configManagerInstance = new ScheduleMatchingConfigManager(configPath);
  }
  return configManagerInstance;
}

// ==================== EXPORTS ====================
module.exports = {
  ScheduleMatchingConfigManager,
  getScheduleMatchingConfigManager,
  DEFAULT_CONFIG
};
