const { TIMEOUTS, TEST_MODE } = require('../config/constants');
const schedulerouteMatching = require('../utils/schedulerouteMatching');

class ScheduledService {
  constructor(firestoreService, websocketServer, admin) {
    this.firestoreService = firestoreService;
    this.websocketServer = websocketServer;
    this.admin = admin;
    this.db = firestoreService.db;
  }
  
  // Start scheduled service
  start() {
    console.log('📅 Starting Scheduled Service...');
    
    // Load scheduled searches on startup
    schedulerouteMatching.loadScheduledSearchesToMemory(this.db, this.admin);
    
    // Start scheduled matching
    setInterval(async () => {
      await schedulerouteMatching.performScheduledMatching(this.db, this.admin);
    }, TIMEOUTS.SCHEDULED_CHECK_INTERVAL);
    
    console.log('✅ Scheduled Service started');
  }
  
  // Initialize scheduled search
  async initializeScheduledSearch(searchData) {
    return schedulerouteMatching.initializeScheduledSearch(this.db, this.admin, searchData);
  }
  
  // Get scheduled search status
  async getScheduledSearchStatus(userId) {
    return schedulerouteMatching.getScheduledSearchStatus(this.db, this.admin, userId);
  }
  
  // Force activate all scheduled searches (for testing)
  async forceActivateAllScheduledSearches() {
    return schedulerouteMatching.forceActivateAllScheduledSearches(this.db, this.admin);
  }
  
  // Get statistics
  getScheduledMatchingStats() {
    return schedulerouteMatching.getScheduledMatchingStats();
  }
}

module.exports = ScheduledService;
