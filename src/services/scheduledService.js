// services/scheduledService.js
const { TIMEOUTS } = require('../config/constants');

class ScheduledService {
  constructor(firestoreService, websocketServer, admin) {
    this.firestoreService = firestoreService;
    this.websocketServer = websocketServer;
    this.admin = admin;
    this.db = firestoreService.db;
    
    // Progressive Matching Windows Configuration
    this.MATCHING_WINDOWS = {
      '24h': { // 24 hours before schedule
        radius: 20000,     // 20km radius
        checkInterval: 60 * 60 * 1000,    // Check every hour
        priority: 1,
        name: 'Early Match (24h)'
      },
      '12h': { // 12 hours before schedule
        radius: 10000,     // 10km radius
        checkInterval: 30 * 60 * 1000,    // Check every 30 min
        priority: 2,
        name: 'Confirmation (12h)'
      },
      '6h': { // 6 hours before schedule
        radius: 5000,      // 5km radius
        checkInterval: 15 * 60 * 1000,    // Check every 15 min
        priority: 3,
        name: 'Finalize (6h)'
      },
      '3h': { // 3 hours before schedule
        radius: 3000,      // 3km radius
        checkInterval: 10 * 60 * 1000,    // Check every 10 min
        priority: 4,
        name: 'Reminder (3h)'
      },
      '1h': { // 1 hour before schedule
        radius: 1000,      // 1km radius
        checkInterval: 5 * 60 * 1000,     // Check every 5 min
        priority: 5,
        name: 'Prepare (1h)'
      },
      '30m': { // 30 minutes before schedule
        radius: 500,       // 500m radius
        checkInterval: 2 * 60 * 1000,     // Check every 2 min
        priority: 6,
        name: 'Activate (30m)'
      }
    };
    
    this.windowIntervals = new Map();
    this.activeSearches = new Map();
  }
  
  // ==================== START & INITIALIZATION ====================
  
  async start() {
    console.log('🚀 Starting Optimized Scheduled Service...');
    
    // Start each window at its own interval
    Object.entries(this.MATCHING_WINDOWS).forEach(([windowName, config]) => {
      const intervalId = setInterval(async () => {
        await this.processScheduledWindow(windowName);
      }, config.checkInterval);
      
      this.windowIntervals.set(windowName, intervalId);
      console.log(`⏰ ${config.name} window: ${config.checkInterval/1000}s interval`);
    });
    
    // Initial load of scheduled searches
    await this.initializeAllWindows();
    
    // Check every 5 minutes for scheduled searches that need to be activated
    this.activationInterval = setInterval(async () => {
      await this.activateUpcomingSearches();
    }, 5 * 60 * 1000); // 5 minutes
    
    console.log('✅ Scheduled Service started with progressive windows');
  }
  
  async initializeAllWindows() {
    console.log('🔍 Initializing all scheduled search windows...');
    
    const windows = Object.keys(this.MATCHING_WINDOWS);
    for (const windowName of windows) {
      await this.processScheduledWindow(windowName);
    }
  }
  
  // ==================== WINDOW PROCESSING ====================
  
  async processScheduledWindow(windowName) {
    try {
      const windowConfig = this.MATCHING_WINDOWS[windowName];
      console.log(`⏰ Processing ${windowConfig.name} window...`);
      
      // Process both drivers and passengers
      await Promise.all([
        this.processScheduledDrivers(windowName, windowConfig),
        this.processScheduledPassengers(windowName, windowConfig)
      ]);
      
    } catch (error) {
      console.error(`❌ Error processing ${windowName} window:`, error.message);
    }
  }
  
  async processScheduledDrivers(windowName, windowConfig) {
    try {
      const { startTime, endTime } = this.calculateWindowTimeRange(windowName);
      
      const driversRef = this.db.collection('scheduled_searches_driver')
        .where('status', '==', 'scheduled')
        .where('scheduledTime', '>=', startTime.toISOString())
        .where('scheduledTime', '<=', endTime.toISOString())
        .where('nextCheckTime', '<=', new Date().toISOString())
        .orderBy('scheduledTime', 'asc')
        .limit(25); // Limit per collection
      
      const snapshot = await driversRef.get();
      
      if (!snapshot.empty) {
        console.log(`   🚗 Found ${snapshot.size} scheduled drivers in ${windowName} window`);
        
        const batchPromises = [];
        snapshot.forEach(doc => {
          batchPromises.push(this.processScheduledDriver(doc.id, doc.data(), windowName, windowConfig));
        });
        
        await Promise.all(batchPromises);
        console.log(`   ✅ Processed ${snapshot.size} scheduled drivers`);
      }
      
    } catch (error) {
      if (error.code === 9 || error.message.includes('index')) {
        console.log(`   ⚠️ Index missing for drivers in ${windowName} window, using fallback`);
        await this.fallbackScheduledQuery('driver', windowName, windowConfig);
      } else {
        console.error(`❌ Error processing scheduled drivers:`, error);
      }
    }
  }
  
  async processScheduledPassengers(windowName, windowConfig) {
    try {
      const { startTime, endTime } = this.calculateWindowTimeRange(windowName);
      
      const passengersRef = this.db.collection('scheduled_searches_passenger')
        .where('status', '==', 'scheduled')
        .where('scheduledTime', '>=', startTime.toISOString())
        .where('scheduledTime', '<=', endTime.toISOString())
        .where('nextCheckTime', '<=', new Date().toISOString())
        .orderBy('scheduledTime', 'asc')
        .limit(25); // Limit per collection
      
      const snapshot = await passengersRef.get();
      
      if (!snapshot.empty) {
        console.log(`   👤 Found ${snapshot.size} scheduled passengers in ${windowName} window`);
        
        const batchPromises = [];
        snapshot.forEach(doc => {
          batchPromises.push(this.processScheduledPassenger(doc.id, doc.data(), windowName, windowConfig));
        });
        
        await Promise.all(batchPromises);
        console.log(`   ✅ Processed ${snapshot.size} scheduled passengers`);
      }
      
    } catch (error) {
      if (error.code === 9 || error.message.includes('index')) {
        console.log(`   ⚠️ Index missing for passengers in ${windowName} window, using fallback`);
        await this.fallbackScheduledQuery('passenger', windowName, windowConfig);
      } else {
        console.error(`❌ Error processing scheduled passengers:`, error);
      }
    }
  }
  
  async fallbackScheduledQuery(userType, windowName, windowConfig) {
    try {
      const collection = userType === 'driver' 
        ? 'scheduled_searches_driver' 
        : 'scheduled_searches_passenger';
      
      const snapshot = await this.db.collection(collection)
        .where('status', '==', 'scheduled')
        .limit(15) // Smaller limit for fallback
        .get();
      
      if (snapshot.empty) return;
      
      const filtered = [];
      snapshot.forEach(doc => {
        if (this.isInWindow(doc.data(), windowName)) {
          filtered.push({ id: doc.id, data: doc.data() });
        }
      });
      
      console.log(`   🔍 Found ${filtered.length} ${userType}s in ${windowName} window (fallback)`);
      
      const batchPromises = filtered.map(item => {
        return userType === 'driver'
          ? this.processScheduledDriver(item.id, item.data, windowName, windowConfig)
          : this.processScheduledPassenger(item.id, item.data, windowName, windowConfig);
      });
      
      await Promise.all(batchPromises);
      
    } catch (error) {
      console.error(`❌ Error in fallback query for ${userType}s:`, error);
    }
  }
  
  async processScheduledDriver(driverId, driverData, windowName, windowConfig) {
    try {
      const now = new Date();
      const scheduledTime = new Date(driverData.scheduledTime);
      
      // Check if we should activate now
      if (this.shouldActivateNow(scheduledTime, windowName)) {
        console.log(`   🚀 Activating scheduled driver: ${driverId}`);
        await this.activateScheduledDriver(driverId, driverData);
        return;
      }
      
      // Update next check time
      const nextCheckTime = this.calculateNextCheckTime(scheduledTime, windowName);
      
      // Find potential passenger matches
      const potentialMatches = await this.findPotentialPassengerMatches(driverData, windowConfig.radius);
      
      // Update driver with current window info
      await this.db.collection('scheduled_searches_driver').doc(driverId).update({
        currentWindow: windowName,
        nextCheckTime: nextCheckTime.toISOString(),
        lastChecked: now.toISOString(),
        currentMatchRadius: windowConfig.radius,
        potentialMatchesCount: potentialMatches.length,
        updatedAt: now.toISOString()
      });
      
      // Notify driver about potential matches
      if (potentialMatches.length > 0) {
        await this.notifyPotentialMatches(driverData, potentialMatches, windowName, 'driver');
      }
      
      console.log(`   📝 Updated scheduled driver ${driverId}: window=${windowName}`);
      
    } catch (error) {
      console.error(`❌ Error processing scheduled driver ${driverId}:`, error);
    }
  }
  
  async processScheduledPassenger(passengerId, passengerData, windowName, windowConfig) {
    try {
      const now = new Date();
      const scheduledTime = new Date(passengerData.scheduledTime);
      
      // Check if we should activate now
      if (this.shouldActivateNow(scheduledTime, windowName)) {
        console.log(`   🚀 Activating scheduled passenger: ${passengerId}`);
        await this.activateScheduledPassenger(passengerId, passengerData);
        return;
      }
      
      // Update next check time
      const nextCheckTime = this.calculateNextCheckTime(scheduledTime, windowName);
      
      // Find potential driver matches
      const potentialMatches = await this.findPotentialDriverMatches(passengerData, windowConfig.radius);
      
      // Update passenger with current window info
      await this.db.collection('scheduled_searches_passenger').doc(passengerId).update({
        currentWindow: windowName,
        nextCheckTime: nextCheckTime.toISOString(),
        lastChecked: now.toISOString(),
        currentMatchRadius: windowConfig.radius,
        potentialMatchesCount: potentialMatches.length,
        updatedAt: now.toISOString()
      });
      
      // Notify passenger about potential matches
      if (potentialMatches.length > 0) {
        await this.notifyPotentialMatches(passengerData, potentialMatches, windowName, 'passenger');
      }
      
      console.log(`   📝 Updated scheduled passenger ${passengerId}: window=${windowName}`);
      
    } catch (error) {
      console.error(`❌ Error processing scheduled passenger ${passengerId}:`, error);
    }
  }
  
  // ==================== MATCH FINDING ====================
  
  async findPotentialDriverMatches(passengerData, radiusMeters) {
    try {
      const { pickupLocation, scheduledTime } = passengerData;
      
      if (!pickupLocation || !pickupLocation.lat || !pickupLocation.lng) {
        return [];
      }
      
      // Time window: +/- 30 minutes from scheduled time
      const timeWindowStart = new Date(scheduledTime);
      timeWindowStart.setMinutes(timeWindowStart.getMinutes() - 30);
      
      const timeWindowEnd = new Date(scheduledTime);
      timeWindowEnd.setMinutes(timeWindowEnd.getMinutes() + 30);
      
      // Query for potential driver matches
      const driversRef = this.db.collection('scheduled_searches_driver')
        .where('status', '==', 'scheduled')
        .where('scheduledTime', '>=', timeWindowStart.toISOString())
        .where('scheduledTime', '<=', timeWindowEnd.toISOString())
        .limit(15);
      
      const snapshot = await driversRef.get();
      
      // Filter by distance
      const matches = [];
      snapshot.forEach(doc => {
        const driverData = doc.data();
        
        if (!driverData.pickupLocation) return;
        
        const distance = this.calculateDistance(
          pickupLocation.lat, pickupLocation.lng,
          driverData.pickupLocation.lat, driverData.pickupLocation.lng
        );
        
        // Convert km to meters for comparison
        if (distance * 1000 <= radiusMeters) {
          matches.push({
            id: doc.id,
            ...driverData,
            distanceKm: distance,
            compatibilityScore: this.calculateCompatibilityScore(passengerData, driverData)
          });
        }
      });
      
      // Sort by compatibility score
      matches.sort((a, b) => b.compatibilityScore - a.compatibilityScore);
      
      return matches.slice(0, 3); // Return top 3 matches
      
    } catch (error) {
      console.error('❌ Error finding potential driver matches:', error);
      return [];
    }
  }
  
  async findPotentialPassengerMatches(driverData, radiusMeters) {
    try {
      const { pickupLocation, scheduledTime } = driverData;
      
      if (!pickupLocation || !pickupLocation.lat || !pickupLocation.lng) {
        return [];
      }
      
      // Time window: +/- 30 minutes from scheduled time
      const timeWindowStart = new Date(scheduledTime);
      timeWindowStart.setMinutes(timeWindowStart.getMinutes() - 30);
      
      const timeWindowEnd = new Date(scheduledTime);
      timeWindowEnd.setMinutes(timeWindowEnd.getMinutes() + 30);
      
      // Query for potential passenger matches
      const passengersRef = this.db.collection('scheduled_searches_passenger')
        .where('status', '==', 'scheduled')
        .where('scheduledTime', '>=', timeWindowStart.toISOString())
        .where('scheduledTime', '<=', timeWindowEnd.toISOString())
        .limit(15);
      
      const snapshot = await passengersRef.get();
      
      // Filter by distance
      const matches = [];
      snapshot.forEach(doc => {
        const passengerData = doc.data();
        
        if (!passengerData.pickupLocation) return;
        
        const distance = this.calculateDistance(
          pickupLocation.lat, pickupLocation.lng,
          passengerData.pickupLocation.lat, passengerData.pickupLocation.lng
        );
        
        // Convert km to meters for comparison
        if (distance * 1000 <= radiusMeters) {
          matches.push({
            id: doc.id,
            ...passengerData,
            distanceKm: distance,
            compatibilityScore: this.calculateCompatibilityScore(driverData, passengerData)
          });
        }
      });
      
      // Sort by compatibility score
      matches.sort((a, b) => b.compatibilityScore - a.compatibilityScore);
      
      return matches.slice(0, 5); // Return top 5 matches
      
    } catch (error) {
      console.error('❌ Error finding potential passenger matches:', error);
      return [];
    }
  }
  
  calculateCompatibilityScore(search1, search2) {
    let score = 100;
    
    // 1. Time compatibility (closer times get higher score)
    const time1 = new Date(search1.scheduledTime).getTime();
    const time2 = new Date(search2.scheduledTime).getTime();
    const timeDiff = Math.abs(time1 - time2) / (1000 * 60); // Difference in minutes
    
    if (timeDiff > 30) score -= 30;
    else if (timeDiff > 15) score -= 15;
    else score -= timeDiff;
    
    // 2. Route compatibility
    const distance1 = this.calculateDistance(
      search1.pickupLocation.lat, search1.pickupLocation.lng,
      search2.pickupLocation.lat, search2.pickupLocation.lng
    );
    
    const distance2 = this.calculateDistance(
      search1.destinationLocation.lat, search1.destinationLocation.lng,
      search2.destinationLocation.lat, search2.destinationLocation.lng
    );
    
    score -= (distance1 + distance2) * 10; // Penalize based on distance
    
    // 3. Capacity check (for drivers)
    if (search1.capacity && search2.passengerCount) {
      if (search2.passengerCount > search1.capacity) score -= 40;
    }
    
    return Math.max(0, score);
  }
  
  // ==================== ACTIVATION LOGIC ====================
  
  async activateUpcomingSearches() {
    try {
      console.log('🔍 Checking for scheduled searches to activate...');
      
      const now = new Date();
      const activationThreshold = new Date(now.getTime() + 30 * 60 * 1000); // 30 minutes from now
      
      await Promise.all([
        this.activateScheduledDrivers(activationThreshold, now),
        this.activateScheduledPassengers(activationThreshold, now)
      ]);
      
    } catch (error) {
      console.error('❌ Error activating scheduled searches:', error);
    }
  }
  
  async activateScheduledDrivers(activationThreshold, now) {
    try {
      const driversRef = this.db.collection('scheduled_searches_driver')
        .where('status', '==', 'scheduled')
        .where('scheduledTime', '<=', activationThreshold.toISOString())
        .orderBy('scheduledTime', 'asc')
        .limit(15);
      
      const snapshot = await driversRef.get();
      
      if (!snapshot.empty) {
        console.log(`   🚗 Found ${snapshot.size} drivers to activate`);
        
        const batch = this.db.batch();
        const driversToActivate = [];
        
        snapshot.forEach(doc => {
          const driverData = doc.data();
          
          batch.set(doc.ref, {
            ...driverData,
            status: 'ready_to_activate',
            activationPending: true,
            scheduledActivationTime: driverData.scheduledTime,
            updatedAt: now.toISOString()
          });
          
          driversToActivate.push({
            ref: doc.ref,
            data: driverData
          });
        });
        
        await batch.commit();
        
        // Activate each driver
        for (const driver of driversToActivate) {
          await this.activateScheduledDriver(driver.ref.id, driver.data);
        }
      }
      
    } catch (error) {
      console.error('❌ Error activating scheduled drivers:', error);
    }
  }
  
  async activateScheduledPassengers(activationThreshold, now) {
    try {
      const passengersRef = this.db.collection('scheduled_searches_passenger')
        .where('status', '==', 'scheduled')
        .where('scheduledTime', '<=', activationThreshold.toISOString())
        .orderBy('scheduledTime', 'asc')
        .limit(15);
      
      const snapshot = await passengersRef.get();
      
      if (!snapshot.empty) {
        console.log(`   👤 Found ${snapshot.size} passengers to activate`);
        
        const batch = this.db.batch();
        const passengersToActivate = [];
        
        snapshot.forEach(doc => {
          const passengerData = doc.data();
          
          batch.set(doc.ref, {
            ...passengerData,
            status: 'ready_to_activate',
            activationPending: true,
            scheduledActivationTime: passengerData.scheduledTime,
            updatedAt: now.toISOString()
          });
          
          passengersToActivate.push({
            ref: doc.ref,
            data: passengerData
          });
        });
        
        await batch.commit();
        
        // Activate each passenger
        for (const passenger of passengersToActivate) {
          await this.activateScheduledPassenger(passenger.ref.id, passenger.data);
        }
      }
      
    } catch (error) {
      console.error('❌ Error activating scheduled passengers:', error);
    }
  }
  
  async activateScheduledDriver(driverId, driverData) {
    try {
      const now = new Date();
      
      console.log(`🚀 Converting scheduled driver to active: ${driverId}`);
      console.log(`   Driver: ${driverData.driverName || 'Unknown'}`);
      console.log(`   Phone: ${driverData.driverPhone || driverData.phoneNumber}`);
      console.log(`   Scheduled Time: ${driverData.scheduledTime}`);
      
      // Remove from scheduled drivers
      await this.db.collection('scheduled_searches_driver').doc(driverId).delete();
      
      // Prepare driver data for active collection (similar to MatchingService)
      const activeDriverData = {
        // Basic identification
        driverId: driverId,
        userId: driverId,
        phoneNumber: driverData.driverPhone || driverData.phoneNumber || driverId,
        
        // Driver details
        driverName: driverData.driverName || driverData.name || 'Driver',
        driverPhone: driverData.driverPhone || driverData.phoneNumber || driverId,
        driverPhotoUrl: driverData.driverPhotoUrl || driverData.photoUrl || '',
        driverRating: driverData.driverRating || 5.0,
        
        // Route information
        pickupLocation: driverData.pickupLocation,
        pickupName: driverData.pickupName || 'Pickup Location',
        destinationLocation: driverData.destinationLocation,
        destinationName: driverData.destinationName || 'Destination',
        currentLocation: driverData.pickupLocation || driverData.currentLocation,
        
        // Vehicle info
        vehicleInfo: driverData.vehicleInfo || {},
        capacity: driverData.capacity || 4,
        availableSeats: driverData.capacity || 4,
        
        // Status and timing
        status: 'searching',
        matchStatus: null,
        searchStartTime: now.getTime(),
        scheduledActivation: true,
        originalScheduledTime: driverData.scheduledTime,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        
        // Pricing
        price: driverData.price || 0,
        
        // Additional info
        totalRides: driverData.totalRides || 0,
        isVerified: driverData.isVerified || false,
        
        // Passenger slots (like MatchingService)
        passenger1: null,
        passenger2: null,
        passenger3: null,
        passenger4: null,
        currentPassengers: 0
      };
      
      // Store in active drivers collection (using phone number as document ID)
      const docId = driverData.driverPhone || driverData.phoneNumber || driverId;
      await this.db.collection('active_searches_driver').doc(docId).set(activeDriverData, { merge: true });
      
      console.log(`✅ Scheduled driver activated: ${docId}`);
      
      // Send WebSocket notification
      if (this.websocketServer && this.websocketServer.sendToUser) {
        await this.websocketServer.sendToUser(docId, {
          type: 'SCHEDULED_SEARCH_ACTIVATED',
          data: {
            userId: docId,
            userType: 'driver',
            scheduledTime: driverData.scheduledTime,
            activatedAt: now.toISOString(),
            message: 'Your scheduled driver search is now active!',
            driverData: activeDriverData
          }
        });
      }
      
      return activeDriverData;
      
    } catch (error) {
      console.error(`❌ Error activating scheduled driver ${driverId}:`, error);
      throw error;
    }
  }
  
  async activateScheduledPassenger(passengerId, passengerData) {
    try {
      const now = new Date();
      
      console.log(`🚀 Converting scheduled passenger to active: ${passengerId}`);
      console.log(`   Passenger: ${passengerData.passengerName || 'Unknown'}`);
      console.log(`   Phone: ${passengerData.passengerPhone || passengerData.phoneNumber}`);
      console.log(`   Scheduled Time: ${passengerData.scheduledTime}`);
      
      // Remove from scheduled passengers
      await this.db.collection('scheduled_searches_passenger').doc(passengerId).delete();
      
      // Prepare passenger data for active collection (similar to MatchingService)
      const activePassengerData = {
        // Basic identification
        passengerId: passengerId,
        userId: passengerId,
        phoneNumber: passengerData.passengerPhone || passengerData.phoneNumber || passengerId,
        
        // Passenger details
        passengerName: passengerData.passengerName || passengerData.name || 'Passenger',
        passengerPhone: passengerData.passengerPhone || passengerData.phoneNumber || passengerId,
        passengerPhotoUrl: passengerData.passengerPhotoUrl || passengerData.photoUrl || '',
        
        // Route information
        pickupLocation: passengerData.pickupLocation,
        pickupName: passengerData.pickupName || 'Pickup Location',
        destinationLocation: passengerData.destinationLocation,
        destinationName: passengerData.destinationName || 'Destination',
        currentLocation: passengerData.pickupLocation || passengerData.currentLocation,
        
        // Ride info
        passengerCount: passengerData.passengerCount || 1,
        numberOfPassengers: passengerData.passengerCount || 1,
        
        // Status and timing
        status: 'searching',
        matchStatus: null,
        searchStartTime: now.getTime(),
        scheduledActivation: true,
        originalScheduledTime: passengerData.scheduledTime,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        
        // Preferences
        ridePreferences: passengerData.ridePreferences || {},
        specialRequests: passengerData.specialRequests || '',
        estimatedFare: passengerData.estimatedFare || 0,
        
        // Match info
        matchId: null,
        matchedWith: null,
        driver: null
      };
      
      // Store in active passengers collection (using phone number as document ID)
      const docId = passengerData.passengerPhone || passengerData.phoneNumber || passengerId;
      await this.db.collection('active_searches_passenger').doc(docId).set(activePassengerData, { merge: true });
      
      console.log(`✅ Scheduled passenger activated: ${docId}`);
      
      // Send WebSocket notification
      if (this.websocketServer && this.websocketServer.sendToUser) {
        await this.websocketServer.sendToUser(docId, {
          type: 'SCHEDULED_SEARCH_ACTIVATED',
          data: {
            userId: docId,
            userType: 'passenger',
            scheduledTime: passengerData.scheduledTime,
            activatedAt: now.toISOString(),
            message: 'Your scheduled ride search is now active!',
            passengerData: activePassengerData
          }
        });
      }
      
      return activePassengerData;
      
    } catch (error) {
      console.error(`❌ Error activating scheduled passenger ${passengerId}:`, error);
      throw error;
    }
  }
  
  // ==================== SCHEDULED SEARCH CREATION ====================
  
  async createScheduledSearch(userData) {
    try {
      const { userType, phoneNumber, scheduledTime, ...searchData } = userData;
      
      // Validate scheduled time (must be in the future)
      const scheduleTime = new Date(scheduledTime);
      const now = new Date();
      
      if (scheduleTime <= now) {
        throw new Error('Scheduled time must be in the future');
      }
      
      // Use phone number as document ID (like MatchingService)
      const searchId = phoneNumber;
      
      // Determine first window to check
      const hoursUntilSchedule = (scheduleTime - now) / (1000 * 60 * 60);
      const firstWindow = this.determineFirstWindow(hoursUntilSchedule);
      
      // Calculate first check time
      const nextCheckTime = this.calculateFirstCheckTime(scheduleTime, firstWindow);
      
      // Determine collection based on user type
      const collection = userType === 'driver' 
        ? 'scheduled_searches_driver' 
        : 'scheduled_searches_passenger';
      
      // Create scheduled search document
      const scheduledSearchData = {
        searchId,
        userId: phoneNumber,
        userType,
        phoneNumber,
        status: 'scheduled',
        scheduledTime: scheduleTime.toISOString(),
        createdAt: now.toISOString(),
        nextCheckTime: nextCheckTime.toISOString(),
        currentWindow: firstWindow,
        matchingWindows: Object.keys(this.MATCHING_WINDOWS),
        currentMatchRadius: this.MATCHING_WINDOWS[firstWindow].radius,
        updatedAt: now.toISOString(),
        
        // Store all search data
        ...searchData
      };
      
      // Save to appropriate collection using phone number as document ID
      await this.db.collection(collection).doc(searchId).set(scheduledSearchData);
      
      console.log(`📅 Created scheduled ${userType} search: ${searchId}`);
      console.log(`   Window: ${firstWindow}, Next check: ${nextCheckTime.toLocaleString()}`);
      
      // Send confirmation to user
      if (this.websocketServer && this.websocketServer.sendToUser) {
        await this.websocketServer.sendToUser(phoneNumber, {
          type: 'SCHEDULED_SEARCH_CREATED',
          data: {
            searchId,
            userType,
            scheduledTime: scheduleTime.toISOString(),
            firstWindow,
            nextCheckTime: nextCheckTime.toISOString(),
            message: `Your ${userType} search is scheduled for ${scheduleTime.toLocaleString()}`
          }
        });
      }
      
      return {
        success: true,
        searchId,
        userType,
        scheduledTime: scheduleTime.toISOString(),
        nextCheckTime: nextCheckTime.toISOString(),
        message: `${userType.charAt(0).toUpperCase() + userType.slice(1)} search scheduled successfully`
      };
      
    } catch (error) {
      console.error('❌ Error creating scheduled search:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  // ==================== UTILITY METHODS ====================
  
  calculateWindowTimeRange(windowName) {
    const now = new Date();
    const hours = parseInt(windowName);
    
    // Calculate start and end times for this window
    const startTime = new Date(now.getTime() + (hours - 1) * 60 * 60 * 1000);
    const endTime = new Date(now.getTime() + hours * 60 * 60 * 1000);
    
    return { startTime, endTime };
  }
  
  isInWindow(searchData, windowName) {
    try {
      const scheduledTime = new Date(searchData.scheduledTime);
      const now = new Date();
      const hoursBefore = parseInt(windowName);
      
      // Check if scheduled time is within this window
      const windowStart = new Date(scheduledTime.getTime() - hoursBefore * 60 * 60 * 1000);
      const windowEnd = new Date(scheduledTime.getTime() - (hoursBefore - 1) * 60 * 60 * 1000);
      
      return now >= windowStart && now <= windowEnd;
    } catch (error) {
      return false;
    }
  }
  
  calculateNextCheckTime(scheduledTime, currentWindow) {
    const scheduled = new Date(scheduledTime);
    const windows = Object.keys(this.MATCHING_WINDOWS);
    const currentIndex = windows.indexOf(currentWindow);
    
    if (currentIndex < windows.length - 1) {
      // Move to next window
      const nextWindow = windows[currentIndex + 1];
      const hoursBefore = parseInt(nextWindow);
      
      // Check at the beginning of the next window
      const checkTime = new Date(scheduled.getTime() - hoursBefore * 60 * 60 * 1000);
      return checkTime;
    } else {
      // In the final window, check every 5 minutes
      return new Date(new Date().getTime() + 5 * 60 * 1000);
    }
  }
  
  calculateFirstCheckTime(scheduledTime, firstWindow) {
    const scheduled = new Date(scheduledTime);
    const hoursBefore = parseInt(firstWindow);
    
    // First check happens at the beginning of the first window
    return new Date(scheduled.getTime() - hoursBefore * 60 * 60 * 1000);
  }
  
  determineFirstWindow(hoursUntilSchedule) {
    const windows = [24, 12, 6, 3, 1, 0.5]; // Hours before schedule
    
    for (const window of windows) {
      if (hoursUntilSchedule >= window) {
        return `${window}${window === 0.5 ? 'm' : 'h'}`;
      }
    }
    
    // If less than 30 minutes, use the 30m window
    return '30m';
  }
  
  shouldActivateNow(scheduledTime, currentWindow) {
    const now = new Date();
    const schedule = new Date(scheduledTime);
    
    // If we're in the 30m window and schedule time is within 30 minutes
    if (currentWindow === '30m') {
      const timeDiff = (schedule - now) / (1000 * 60); // Difference in minutes
      return timeDiff <= 30;
    }
    
    return false;
  }
  
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in km
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) * 
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }
  
  toRad(degrees) {
    return degrees * (Math.PI/180);
  }
  
  async notifyPotentialMatches(searchData, potentialMatches, windowName, userType) {
    try {
      if (!this.websocketServer || !this.websocketServer.sendToUser) return;
      
      const windowConfig = this.MATCHING_WINDOWS[windowName];
      const oppositeType = userType === 'driver' ? 'passengers' : 'drivers';
      
      await this.websocketServer.sendToUser(searchData.phoneNumber || searchData.userId, {
        type: 'POTENTIAL_SCHEDULED_MATCHES',
        data: {
          userId: searchData.phoneNumber || searchData.userId,
          userType,
          scheduledTime: searchData.scheduledTime,
          currentWindow: windowConfig.name,
          potentialMatches: potentialMatches.length,
          bestMatch: potentialMatches[0] ? {
            distanceKm: potentialMatches[0].distanceKm?.toFixed(1) || '0.0',
            scheduledTime: potentialMatches[0].scheduledTime,
            compatibilityScore: potentialMatches[0].compatibilityScore
          } : null,
          message: `Found ${potentialMatches.length} potential ${oppositeType} for your scheduled ${userType === 'driver' ? 'drive' : 'ride'}`
        }
      });
      
    } catch (error) {
      console.error('❌ Error notifying potential matches:', error);
    }
  }
  
  // ==================== API METHODS ====================
  
  async getScheduledSearchStatus(phoneNumber) {
    try {
      const [driversSnapshot, passengersSnapshot] = await Promise.all([
        this.db.collection('scheduled_searches_driver')
          .doc(phoneNumber).get(),
        this.db.collection('scheduled_searches_passenger')
          .doc(phoneNumber).get()
      ]);
      
      const results = {};
      
      if (driversSnapshot.exists) {
        results.driver = {
          id: driversSnapshot.id,
          ...driversSnapshot.data()
        };
      }
      
      if (passengersSnapshot.exists) {
        results.passenger = {
          id: passengersSnapshot.id,
          ...passengersSnapshot.data()
        };
      }
      
      return {
        success: true,
        hasDriverScheduled: driversSnapshot.exists,
        hasPassengerScheduled: passengersSnapshot.exists,
        searches: results
      };
      
    } catch (error) {
      console.error('❌ Error getting scheduled search status:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  async cancelScheduledSearch(phoneNumber, userType, reason = 'user_cancelled') {
    try {
      const collection = userType === 'driver' 
        ? 'scheduled_searches_driver' 
        : 'scheduled_searches_passenger';
      
      const searchRef = this.db.collection(collection).doc(phoneNumber);
      const searchDoc = await searchRef.get();
      
      if (!searchDoc.exists) {
        return { success: false, error: 'Scheduled search not found' };
      }
      
      await searchRef.update({
        status: 'cancelled',
        cancelledAt: new Date().toISOString(),
        cancellationReason: reason,
        updatedAt: new Date().toISOString()
      });
      
      // Notify user
      if (this.websocketServer && this.websocketServer.sendToUser) {
        await this.websocketServer.sendToUser(phoneNumber, {
          type: 'SCHEDULED_SEARCH_CANCELLED',
          data: {
            phoneNumber,
            userType,
            reason,
            message: `Your scheduled ${userType} search has been cancelled`
          }
        });
      }
      
      return {
        success: true,
        phoneNumber,
        userType,
        message: 'Scheduled search cancelled successfully'
      };
      
    } catch (error) {
      console.error('❌ Error cancelling scheduled search:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  // ==================== STATISTICS ====================
  
  async getStats() {
    try {
      const [driversSnapshot, passengersSnapshot] = await Promise.all([
        this.db.collection('scheduled_searches_driver').get(),
        this.db.collection('scheduled_searches_passenger').get()
      ]);
      
      const stats = {
        drivers: {
          total: driversSnapshot.size,
          byStatus: {},
          byWindow: {}
        },
        passengers: {
          total: passengersSnapshot.size,
          byStatus: {},
          byWindow: {}
        }
      };
      
      // Process drivers
      driversSnapshot.forEach(doc => {
        const data = doc.data();
        stats.drivers.byStatus[data.status] = (stats.drivers.byStatus[data.status] || 0) + 1;
        if (data.currentWindow) {
          stats.drivers.byWindow[data.currentWindow] = (stats.drivers.byWindow[data.currentWindow] || 0) + 1;
        }
      });
      
      // Process passengers
      passengersSnapshot.forEach(doc => {
        const data = doc.data();
        stats.passengers.byStatus[data.status] = (stats.passengers.byStatus[data.status] || 0) + 1;
        if (data.currentWindow) {
          stats.passengers.byWindow[data.currentWindow] = (stats.passengers.byWindow[data.currentWindow] || 0) + 1;
        }
      });
      
      return {
        success: true,
        timestamp: new Date().toISOString(),
        total: driversSnapshot.size + passengersSnapshot.size,
        ...stats
      };
      
    } catch (error) {
      console.error('❌ Error getting stats:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  // ==================== STOP ====================
  
  stop() {
    console.log('🛑 Stopping Scheduled Service...');
    
    // Clear all intervals
    this.windowIntervals.forEach(intervalId => {
      clearInterval(intervalId);
    });
    
    if (this.activationInterval) {
      clearInterval(this.activationInterval);
    }
    
    this.windowIntervals.clear();
    console.log('✅ Scheduled Service stopped');
  }
}

module.exports = ScheduledService;
