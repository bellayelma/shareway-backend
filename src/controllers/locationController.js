const helpers = require('../utils/helpers');

class LocationController {
  constructor(matchingService, firestoreService, realtimeLocationService = null) {
    this.matchingService = matchingService;
    this.firestoreService = firestoreService;
    this.realtimeLocationService = realtimeLocationService;
    
    console.log('📍 LocationController initialized with:');
    console.log('   - matchingService:', !!matchingService);
    console.log('   - firestoreService:', !!firestoreService);
    console.log('   - realtimeLocationService:', !!realtimeLocationService);
  }
  
  // Update user's location
  async updateLocation(req, res) {
    try {
      const { userId, userType, latitude, longitude } = req.body;
      
      if (!userId || !userType || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ 
          success: false, 
          error: 'Missing required fields: userId, userType, latitude, longitude' 
        });
      }
      
      console.log(`📍 Location update from ${userType} ${userId}: lat=${latitude}, lng=${longitude}`);
      
      // TRY MULTIPLE APPROACHES to update location:
      
      // 1. First try realtimeLocationService if available
      if (this.realtimeLocationService && typeof this.realtimeLocationService.updateLocation === 'function') {
        console.log('   Using realtimeLocationService...');
        try {
          await this.realtimeLocationService.updateLocation(userId, req.body, userType);
          return res.json({ 
            success: true, 
            message: 'Location updated via realtimeLocationService',
            timestamp: Date.now(),
            method: 'realtimeLocationService'
          });
        } catch (error) {
          console.log('   ❌ realtimeLocationService failed:', error.message);
          // Continue to next method
        }
      }
      
      // 2. Try matchingService
      if (this.matchingService && typeof this.matchingService.updateUserLocation === 'function') {
        console.log('   Using matchingService...');
        try {
          const result = await this.matchingService.updateUserLocation(userId, req.body, userType);
          if (result && result.success) {
            return res.json({ 
              success: true, 
              message: 'Location updated via matchingService',
              timestamp: Date.now(),
              method: 'matchingService'
            });
          }
        } catch (error) {
          console.log('   ❌ matchingService failed:', error.message);
        }
      }
      
      // 3. Fallback: Store directly in firestore
      console.log('   Using direct Firestore storage...');
      try {
        const collectionName = userType === 'driver' ? 
          'active_searches_driver' : 'active_searches_passenger';
        
        const locationData = {
          latitude,
          longitude,
          accuracy: req.body.accuracy || 0,
          heading: req.body.heading || 0,
          speed: req.body.speed || 0,
          timestamp: req.body.timestamp || Date.now(),
          serverReceivedAt: Date.now()
        };
        
        // Store in user document
        await this.firestoreService.db
          .collection(collectionName)
          .doc(userId)
          .set({
            lastLocation: locationData,
            lastLocationUpdate: Date.now(),
            locationSharingActive: true
          }, { merge: true });
        
        console.log(`   ✅ Location stored in ${collectionName}/${userId}`);
        
        // Also store in memory locations collection
        const memoryLocation = {
          userId,
          userType,
          location: { lat: latitude, lng: longitude },
          ...req.body,
          serverReceivedAt: Date.now()
        };
        
        // Try to store in memory locations
        if (this.matchingService && this.matchingService.memoryLocations) {
          this.matchingService.memoryLocations.set(userId, memoryLocation);
          console.log('   ✅ Location stored in memory');
        }
        
        return res.json({ 
          success: true, 
          message: 'Location stored in Firestore',
          timestamp: Date.now(),
          method: 'firestore_direct'
        });
        
      } catch (error) {
        console.log('   ❌ Firestore storage failed:', error.message);
        throw error;
      }
      
    } catch (error) {
      console.error('❌ Location update error:', error);
      return res.status(500).json({ 
        success: false, 
        error: error.message || 'Failed to update location using any method'
      });
    }
  }
  
  // Get other user's location
  async getOtherUserLocation(req, res) {
    try {
      const { userId, userType } = req.params;
      
      console.log(`📍 Getting location for ${userType} ${userId}`);
      
      // FIRST: Check memory locations
      if (this.matchingService && this.matchingService.memoryLocations) {
        const memoryLocation = this.matchingService.memoryLocations.get(userId);
        if (memoryLocation) {
          const timeSinceUpdate = Date.now() - (memoryLocation.serverReceivedAt || memoryLocation.timestamp || 0);
          
          // If location is fresh (less than 5 minutes old)
          if (timeSinceUpdate < 5 * 60 * 1000) {
            return res.json({
              success: true,
              locationSharingActive: true,
              location: memoryLocation.location || { lat: memoryLocation.latitude, lng: memoryLocation.longitude },
              lastUpdate: memoryLocation.timestamp || memoryLocation.serverReceivedAt,
              accuracy: memoryLocation.accuracy || 0,
              source: 'memory',
              freshness: `${Math.round(timeSinceUpdate / 1000)} seconds ago`
            });
          }
        }
      }
      
      // SECOND: Check Firestore
      const collectionName = userType === 'driver' ? 
        'active_searches_driver' : 'active_searches_passenger';
      
      try {
        const userDoc = await this.firestoreService.db
          .collection(collectionName)
          .doc(userId)
          .get();
        
        if (userDoc.exists) {
          const userData = userDoc.data();
          const lastLocation = userData.lastLocation;
          
          if (lastLocation && lastLocation.timestamp) {
            const timeSinceUpdate = Date.now() - lastLocation.timestamp;
            
            // If location is fresh (less than 10 minutes old)
            if (timeSinceUpdate < 10 * 60 * 1000) {
              return res.json({
                success: true,
                locationSharingActive: true,
                location: { lat: lastLocation.latitude, lng: lastLocation.longitude },
                lastUpdate: lastLocation.timestamp,
                accuracy: lastLocation.accuracy || 0,
                source: 'firestore',
                freshness: `${Math.round(timeSinceUpdate / 1000)} seconds ago`
              });
            }
          }
        }
      } catch (firestoreError) {
        console.log('   Firestore check failed:', firestoreError.message);
      }
      
      // THIRD: Try realtimeLocationService
      if (this.realtimeLocationService && typeof this.realtimeLocationService.getUserLocation === 'function') {
        try {
          const location = await this.realtimeLocationService.getUserLocation(userId, userType);
          if (location) {
            return res.json({
              success: true,
              locationSharingActive: true,
              location: location,
              source: 'realtimeService',
              lastUpdate: Date.now()
            });
          }
        } catch (serviceError) {
          console.log('   Realtime service check failed:', serviceError.message);
        }
      }
      
      // No location found
      return res.json({
        success: true,
        locationSharingActive: false,
        message: 'No active location sharing found',
        requiresMatchAcceptance: true
      });
      
    } catch (error) {
      console.error('❌ Error getting location:', error);
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to get location'
      });
    }
  }
  
  // Get location sharing status
  async getLocationSharingStatus(req, res) {
    try {
      const { userId, userType } = req.params;
      
      console.log(`📍 Getting location status for ${userType} ${userId}`);
      
      // Check if user is connected via WebSocket
      let isWebSocketConnected = false;
      let webSocketActivity = null;
      
      // This would require access to websocket server
      // For now, we'll check memory locations as proxy for activity
      if (this.matchingService && this.matchingService.memoryLocations) {
        const memoryLocation = this.matchingService.memoryLocations.get(userId);
        if (memoryLocation) {
          isWebSocketConnected = true;
          webSocketActivity = memoryLocation.serverReceivedAt || memoryLocation.timestamp;
        }
      }
      
      // Check Firestore for match status
      const collectionName = userType === 'driver' ? 
        'active_searches_driver' : 'active_searches_passenger';
      
      let firestoreData = null;
      try {
        const userDoc = await this.firestoreService.db
          .collection(collectionName)
          .doc(userId)
          .get();
        
        if (userDoc.exists) {
          firestoreData = userDoc.data();
        }
      } catch (error) {
        console.log('   Firestore read error:', error.message);
      }
      
      res.json({
        success: true,
        user: { id: userId, type: userType },
        webSocket: {
          connected: isWebSocketConnected,
          lastActivity: webSocketActivity ? new Date(webSocketActivity).toISOString() : null,
          activeFor: webSocketActivity ? `${Math.round((Date.now() - webSocketActivity) / 1000)}s` : null
        },
        locationSharing: {
          active: isWebSocketConnected,
          source: isWebSocketConnected ? 'memory_websocket' : 'none',
          supportsBidirectional: true,
          memoryLocationCount: this.matchingService?.memoryLocations?.size || 0
        },
        matchStatus: firestoreData?.status || 'searching',
        serverTime: new Date().toISOString(),
        availableServices: {
          matchingService: !!this.matchingService,
          firestoreService: !!this.firestoreService,
          realtimeLocationService: !!this.realtimeLocationService
        }
      });
      
    } catch (error) {
      console.error('❌ Error getting location status:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
  
  // Stop location sharing (emergency/early stop)
  async stopLocationSharing(req, res) {
    try {
      const { userId, userType } = req.params;
      
      console.log(`🛑 Stopping location sharing for ${userType} ${userId}`);
      
      // 1. Clear from memory
      if (this.matchingService && this.matchingService.memoryLocations) {
        this.matchingService.memoryLocations.delete(userId);
      }
      
      // 2. Clear from Firestore
      const collectionName = userType === 'driver' ? 
        'active_searches_driver' : 'active_searches_passenger';
      
      try {
        await this.firestoreService.db
          .collection(collectionName)
          .doc(userId)
          .update({
            'realtimeLocation.enabled': false,
            lastLocationUpdate: null
          });
      } catch (error) {
        console.log('   Firestore update failed:', error.message);
      }
      
      // 3. Stop via realtimeLocationService if available
      if (this.realtimeLocationService && typeof this.realtimeLocationService.stopSharing === 'function') {
        try {
          await this.realtimeLocationService.stopSharing(userId, userType);
        } catch (error) {
          console.log('   Realtime service stop failed:', error.message);
        }
      }
      
      res.json({
        success: true,
        message: 'Location sharing stopped',
        userId,
        userType,
        timestamp: Date.now()
      });
      
    } catch (error) {
      console.error('❌ Error stopping location sharing:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
  
  // Simple init method for app.js
  static init(services) {
    if (!services) {
      console.error('❌ LocationController: No services provided for init');
      return null;
    }
    
    const { matchingService, firestoreService, realtimeLocationService } = services;
    
    if (!matchingService || !firestoreService) {
      console.error('❌ LocationController: Missing required services');
      console.error('   matchingService:', !!matchingService);
      console.error('   firestoreService:', !!firestoreService);
      return null;
    }
    
    const controller = new LocationController(
      matchingService,
      firestoreService,
      realtimeLocationService
    );
    
    console.log('✅ LocationController initialized successfully');
    return controller;
  }
}

module.exports = LocationController;
