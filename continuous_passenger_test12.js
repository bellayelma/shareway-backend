// moving_passenger_simulation.js
const https = require('https');
const WebSocket = require('ws');

class MovingPassengerSimulation {
  constructor() {
    this.testCount = 0;
    this.successfulSearches = 0;
    this.matchesFound = 0;
    this.failedSearches = 0;
    this.locationUpdates = 0;
    this.isSearching = false;
    this.searchId = null;
    this.passengerId = null;
    this.currentRouteIndex = 0;
    this.ws = null;
    this.websocketConnected = false;

    // Configuration
    this.CONFIG = {
      baseUrl: 'shareway-backend-cbvn.onrender.com',
      port: 443,
      searchInterval: 10000,
      locationUpdateInterval: 10000, // Update every 10 seconds
      timeout: 15000,
      testDuration: 600000, // 10 minutes for testing
      enableWebSocket: true
    };

    // 🎯 ORIGINAL PICKUP LOCATION (never changes)
    this.ORIGINAL_PICKUP = {
      lat: 8.549995,
      lng: 39.266714,
      name: "Adama"
    };

    // 🎯 DESTINATION (never changes)
    this.DESTINATION = {
      lat: 9.589549,
      lng: 41.866169,
      name: "Dire Dawa"
    };

    // 🎯 COMPLETE ROUTE POINTS (movement path)
    this.ROUTE_POINTS = [
      // Starting point (pickup location)
      { lat: 8.549995, lng: 39.266714, accuracy: 10, speed: 0, address: "Adama, Oromia, Ethiopia" },
      
      // Moving towards highway
      { lat: 8.5505, lng: 39.2671, accuracy: 15, speed: 20, address: "Adama-Mieso Highway" },
      { lat: 8.5512, lng: 39.2683, accuracy: 15, speed: 40, address: "Adama-Mieso Highway" },
      { lat: 8.5520, lng: 39.2700, accuracy: 15, speed: 60, address: "Adama-Mieso Highway" },
      
      // On highway from Adama
      { lat: 8.5600, lng: 39.2800, accuracy: 20, speed: 80, address: "Adama-Mieso Highway" },
      { lat: 8.5800, lng: 39.3100, accuracy: 20, speed: 85, address: "Adama-Mieso Highway" },
      { lat: 8.6100, lng: 39.3500, accuracy: 20, speed: 90, address: "Adama-Mieso Highway" },
      { lat: 8.6500, lng: 39.4000, accuracy: 20, speed: 95, address: "Adama-Mieso Highway" },
      
      // Approaching first major waypoint
      { lat: 8.7200, lng: 39.5200, accuracy: 20, speed: 100, address: "Mieso, Oromia" },
      { lat: 8.7800, lng: 39.6300, accuracy: 20, speed: 100, address: "Mieso, Oromia" },
      
      // Exact match points from driver's route
      { lat: 8.913591, lng: 39.906468, accuracy: 25, speed: 110, address: "Mieso, Oromia" },
      
      // Continuing towards Dire Dawa
      { lat: 9.0500, lng: 40.1000, accuracy: 25, speed: 110, address: "Dire Dawa Highway" },
      { lat: 9.1500, lng: 40.3000, accuracy: 25, speed: 105, address: "Dire Dawa Highway" },
      { lat: 9.2500, lng: 40.5500, accuracy: 25, speed: 100, address: "Dire Dawa Highway" },
      
      // Exact match points from driver's route
      { lat: 9.28897, lng: 40.829771, accuracy: 20, speed: 95, address: "Dire Dawa Highway" },
      
      // Getting closer to Dire Dawa
      { lat: 9.3500, lng: 40.9500, accuracy: 20, speed: 90, address: "Dire Dawa Highway" },
      { lat: 9.4200, lng: 41.0800, accuracy: 20, speed: 85, address: "Dire Dawa Highway" },
      
      // Exact match points from driver's route
      { lat: 9.52893, lng: 41.213885, accuracy: 15, speed: 80, address: "Dire Dawa Highway" },
      
      // Entering Dire Dawa area
      { lat: 9.5400, lng: 41.3500, accuracy: 15, speed: 60, address: "Dire Dawa, Ethiopia" },
      
      // Exact match points from driver's route
      { lat: 9.547991, lng: 41.481037, accuracy: 10, speed: 40, address: "Dire Dawa, Ethiopia" },
      
      // Approaching destination
      { lat: 9.5700, lng: 41.6500, accuracy: 10, speed: 30, address: "Dire Dawa, Ethiopia" },
      { lat: 9.5800, lng: 41.7500, accuracy: 10, speed: 20, address: "Dire Dawa, Ethiopia" },
      
      // Arriving at destination (Dire Dawa)
      { lat: 9.589549, lng: 41.866169, accuracy: 5, speed: 0, address: "Dire Dawa, Ethiopia" }
    ];

    console.log('Moving Passenger Simulation Initialized');
    console.log('Route: Adama -> Dire Dawa');
    console.log('Original Pickup: (' + this.ORIGINAL_PICKUP.lat + ', ' + this.ORIGINAL_PICKUP.lng + ')');
    console.log('Destination: (' + this.DESTINATION.lat + ', ' + this.DESTINATION.lng + ')');
    console.log('Total route points: ' + this.ROUTE_POINTS.length);
    console.log('Location updates every: ' + (this.CONFIG.locationUpdateInterval / 1000) + ' seconds');
  }

  // Make HTTPS request
  makeRequest(options, data = null) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let responseData = '';
        
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        
        res.on('end', () => {
          try {
            const jsonResponse = JSON.parse(responseData);
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              data: jsonResponse
            });
          } catch (error) {
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              data: responseData
            });
          }
        });
      });
      
      req.on('error', (error) => {
        reject(error);
      });
      
      req.setTimeout(this.CONFIG.timeout, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      
      if (data) {
        req.write(JSON.stringify(data));
      }
      
      req.end();
    });
  }

  // Get current location from route
  getCurrentLocation() {
    // If we've reached the end, loop back to start
    if (this.currentRouteIndex >= this.ROUTE_POINTS.length) {
      this.currentRouteIndex = 0;
      console.log('Reached destination, looping back to start...');
    }
    
    const point = this.ROUTE_POINTS[this.currentRouteIndex];
    
    // Add some random variation to simulate real GPS
    const vary = (value, range) => {
      return value + (Math.random() * range * 2 - range);
    };
    
    return {
      latitude: vary(point.lat, 0.0001),
      longitude: vary(point.lng, 0.0001),
      accuracy: point.accuracy || 15,
      heading: Math.floor(Math.random() * 360),
      speed: point.speed || 0,
      timestamp: Date.now(),
      address: point.address || 'Unknown location'
    };
  }

  // Move to next point on route
  moveToNextPoint() {
    this.currentRouteIndex++;
    
    // Calculate progress percentage
    const progress = (this.currentRouteIndex / this.ROUTE_POINTS.length) * 100;
    
    if (this.currentRouteIndex >= this.ROUTE_POINTS.length) {
      return {
        moved: false,
        progress: 100,
        message: 'Reached final destination'
      };
    }
    
    return {
      moved: true,
      progress: Math.round(progress),
      currentPoint: this.ROUTE_POINTS[this.currentRouteIndex],
      message: 'Moved to next route point'
    };
  }

  // Connect to WebSocket
  connectWebSocket(userId) {
    if (!this.CONFIG.enableWebSocket) return;
    
    return new Promise((resolve, reject) => {
      try {
        const wsUrl = 'wss://' + this.CONFIG.baseUrl + '/?userId=' + userId;
        this.ws = new WebSocket(wsUrl);
        
        this.ws.on('open', () => {
          console.log('WebSocket connected');
          this.websocketConnected = true;
          
          this.ws.send(JSON.stringify({
            type: 'CLIENT_CONNECTED',
            userId: userId,
            timestamp: Date.now()
          }));
          
          resolve();
        });
        
        this.ws.on('message', (data) => {
          try {
            const message = JSON.parse(data);
            this.handleWebSocketMessage(message);
          } catch (error) {
            console.log('Raw WebSocket message:', data.toString());
          }
        });
        
        this.ws.on('close', () => {
          console.log('WebSocket disconnected');
          this.websocketConnected = false;
        });
        
        this.ws.on('error', (error) => {
          console.error('WebSocket error:', error.message);
          reject(error);
        });
        
        setTimeout(() => {
          if (!this.websocketConnected) {
            reject(new Error('WebSocket connection timeout'));
          }
        }, 5000);
        
      } catch (error) {
        reject(error);
      }
    });
  }

  // Handle WebSocket messages
  handleWebSocketMessage(message) {
    console.log('WebSocket: ' + message.type);
    
    switch (message.type) {
      case 'CONNECTED':
        console.log('Server confirmed WebSocket connection');
        break;
        
      case 'SEARCH_STARTED':
        console.log('Search started on server');
        console.log('   Search ID: ' + (message.data?.searchId || 'N/A'));
        break;
        
      case 'DRIVER_FOUND':
        console.log('DRIVER FOUND!');
        console.log('   Match ID: ' + (message.data?.matchId || 'N/A'));
        console.log('   Driver: ' + (message.data?.driver?.name || 'N/A'));
        console.log('   Vehicle: ' + (message.data?.driver?.vehicleInfo?.model || 'Unknown'));
        console.log('   Similarity Score: ' + (message.data?.driver?.similarityScore || 'N/A'));
        
        this.matchesFound++;
        
        // Auto-accept the match
        if (this.ws && this.websocketConnected) {
          this.ws.send(JSON.stringify({
            type: 'ACCEPT_REALTIME_MATCH',
            matchId: message.data?.matchId,
            location: this.getCurrentLocation(),
            timestamp: Date.now()
          }));
          console.log('Auto-accepted the match');
        }
        break;
        
      case 'DRIVER_LOCATION_UPDATE':
        const location = message.data?.location;
        if (location) {
          console.log('Driver location: ' + location.latitude.toFixed(6) + ', ' + location.longitude.toFixed(6));
        }
        break;
        
      case 'REALTIME_MATCH_FOUND':
        console.log('REALTIME MATCH via location update!');
        console.log('   Driver: ' + (message.data?.driverName || 'N/A'));
        console.log('   Distance: ' + (message.data?.distanceToPickup || 'N/A') + ' km');
        this.matchesFound++;
        break;
        
      default:
        console.log('WebSocket message type: ' + message.type);
    }
  }

  // Start passenger search with ORIGINAL pickup location
  async startPassengerSearch() {
    try {
      const timestamp = Date.now();
      const randomId = Math.floor(Math.random() * 10000);
      this.passengerId = "moving_passenger_" + timestamp + '_' + randomId;
      
      console.log('\n=== STARTING MOVING PASSENGER SEARCH ===');
      console.log('Passenger ID: ' + this.passengerId);
      console.log('Original Pickup: ' + this.ORIGINAL_PICKUP.name);
      console.log('Destination: ' + this.DESTINATION.name);
      console.log('Will move along route every 10 seconds');
      
      // Connect WebSocket
      if (this.CONFIG.enableWebSocket) {
        try {
          await this.connectWebSocket(this.passengerId);
          console.log('WebSocket connected successfully');
        } catch (error) {
          console.log('WebSocket connection failed: ' + error.message);
        }
      }
      
      // Prepare search data with ORIGINAL pickup location
      const searchData = {
        userId: this.passengerId,
        userType: 'passenger',
        passengerName: "Moving Passenger - Adama to Dire Dawa",
        passengerPhone: "+251911223344",
        passengerPhotoUrl: "https://example.com/passenger.jpg",
        passengerRating: 4.8,
        totalRides: 15,
        isVerified: true,
        
        // 🎯 ORIGINAL PICKUP LOCATION (never changes)
        pickupLocation: {
          lat: this.ORIGINAL_PICKUP.lat,
          lng: this.ORIGINAL_PICKUP.lng
        },
        
        // 🎯 DESTINATION (never changes)
        destinationLocation: {
          lat: this.DESTINATION.lat,
          lng: this.DESTINATION.lng
        },
        
        pickupName: this.ORIGINAL_PICKUP.name,
        destinationName: this.DESTINATION.name,
        
        // Complete route points for matching
        routePoints: this.ROUTE_POINTS.map(p => ({ lat: p.lat, lng: p.lng })),
        
        // Additional data
        passengerCount: 1,
        maxWaitTime: 30,
        preferredVehicleType: "car",
        specialRequests: "Moving passenger test",
        maxWalkDistance: 0.5,
        distance: 320,
        duration: 360,
        estimatedFare: 800,
        
        rideType: "immediate",
        searchId: "moving_search_" + timestamp
      };
      
      const options = {
        hostname: this.CONFIG.baseUrl,
        port: this.CONFIG.port,
        path: '/api/match/search',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      };
      
      console.log('Sending search request to backend...');
      console.log('Original pickup sent to server: (' + 
        this.ORIGINAL_PICKUP.lat + ', ' + this.ORIGINAL_PICKUP.lng + ')');
      
      const response = await this.makeRequest(options, searchData);
      
      if (response.statusCode === 200 && response.data.success) {
        console.log('Search started successfully!');
        console.log('   Search ID: ' + response.data.searchId);
        console.log('   WebSocket: ' + (response.data.websocketConnected ? 'Connected' : 'Not connected'));
        
        this.searchId = response.data.searchId;
        this.isSearching = true;
        this.successfulSearches++;
        
        // Start continuous movement updates
        this.startMovementUpdates();
        
        return response.data;
      } else {
        console.error('Search failed: ' + (response.data?.error || 'Unknown error'));
        this.failedSearches++;
        throw new Error(response.data?.error || 'Search failed');
      }
      
    } catch (error) {
      console.error('Error starting passenger search: ' + error.message);
      this.failedSearches++;
      throw error;
    }
  }

  // Start continuous movement updates
  startMovementUpdates() {
    console.log('\n=== STARTING MOVEMENT UPDATES ===');
    console.log('   Update interval: ' + (this.CONFIG.locationUpdateInterval / 1000) + ' seconds');
    console.log('   Total route points: ' + this.ROUTE_POINTS.length);
    console.log('   Starting at point 0: (' + 
      this.ROUTE_POINTS[0].lat + ', ' + this.ROUTE_POINTS[0].lng + ')\n');
    
    // Start first update immediately
    setTimeout(() => this.sendLocationUpdate(), 1000);
    
    // Set up interval for continuous movement
    this.movementInterval = setInterval(() => {
      if (this.isSearching) {
        // Move to next point first
        const moveResult = this.moveToNextPoint();
        
        if (moveResult.moved) {
          console.log('Moving to next route point...');
          console.log('   Progress: ' + moveResult.progress + '%');
          console.log('   New position: (' + 
            moveResult.currentPoint.lat + ', ' + moveResult.currentPoint.lng + ')');
          
          // Send location update with new position
          this.sendLocationUpdate();
        } else {
          console.log(moveResult.message);
          // If reached destination, stop or loop
          if (this.currentRouteIndex >= this.ROUTE_POINTS.length) {
            console.log('Journey complete! Starting new journey...');
            this.currentRouteIndex = 0;
          }
        }
      } else {
        clearInterval(this.movementInterval);
        console.log('Stopping movement updates (search stopped)');
      }
    }, this.CONFIG.locationUpdateInterval);
  }

  // Send location update with CURRENT position
  async sendLocationUpdate() {
    try {
      const currentLocation = this.getCurrentLocation();
      
      console.log('\n--- Location Update #' + (this.locationUpdates + 1) + ' ---');
      console.log('   Current Position: ' + 
        currentLocation.latitude.toFixed(6) + ', ' + 
        currentLocation.longitude.toFixed(6));
      console.log('   Address: ' + currentLocation.address);
      console.log('   Speed: ' + currentLocation.speed + ' km/h');
      console.log('   Accuracy: ' + currentLocation.accuracy + ' meters');
      console.log('   Route Progress: ' + 
        Math.round((this.currentRouteIndex / this.ROUTE_POINTS.length) * 100) + '%');
      
      // Send update to backend
      const locationData = {
        userId: this.passengerId,
        passengerId: this.passengerId,
        location: {
          latitude: currentLocation.latitude,
          longitude: currentLocation.longitude,
          accuracy: currentLocation.accuracy,
          heading: currentLocation.heading,
          speed: currentLocation.speed
        },
        address: currentLocation.address,
        
        // 🎯 CRITICAL: Also send current route progress for matching
        // This tells the backend "I'm now at this position on my route"
        currentRouteIndex: this.currentRouteIndex,
        totalRoutePoints: this.ROUTE_POINTS.length,
        progressPercentage: Math.round((this.currentRouteIndex / this.ROUTE_POINTS.length) * 100)
      };
      
      const options = {
        hostname: this.CONFIG.baseUrl,
        port: this.CONFIG.port,
        path: '/api/passenger/update-location',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      };
      
      console.log('Sending location update to backend...');
      
      const response = await this.makeRequest(options, locationData);
      
      if (response.statusCode === 200 && response.data.success) {
        console.log('Location update successful!');
        console.log('   Match found: ' + (response.data.matchFound ? 'YES!' : 'Not yet'));
        
        if (response.data.matchFound) {
          console.log('   Match ID: ' + response.data.matchId);
          console.log('   Similarity: ' + response.data.similarityScore);
        }
        
        this.locationUpdates++;
      } else {
        console.log('Location update response:', response.data);
      }
      
    } catch (error) {
      console.error('Error sending location update: ' + error.message);
    }
  }

  // Health check
  async healthCheck() {
    try {
      const options = {
        hostname: this.CONFIG.baseUrl,
        port: this.CONFIG.port,
        path: '/api/health',
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      };
      
      const response = await this.makeRequest(options);
      
      if (response.statusCode === 200 && response.data.success) {
        console.log('=== HEALTH CHECK ===');
        console.log('   Server: ' + response.data.message);
        console.log('   Real-time Matching: ' + 
          (response.data.features?.realTimeLocationUpdates ? 'Enabled' : 'Disabled'));
        return true;
      }
      return false;
    } catch (error) {
      console.error('Health check failed: ' + error.message);
      return false;
    }
  }

  // Run the simulation
  async runSimulation() {
    console.log('=== MOVING PASSENGER SIMULATION START ===');
    console.log('Simulating passenger moving along route');
    console.log('Updates every ' + (this.CONFIG.locationUpdateInterval / 1000) + ' seconds');
    console.log('Duration: ' + (this.CONFIG.testDuration / 60000) + ' minutes\n');
    
    // Health check
    const healthy = await this.healthCheck();
    if (!healthy) {
      console.log('Server not healthy. Exiting.');
      return;
    }
    
    // Start the search
    await this.startPassengerSearch();
    
    // Auto-stop after test duration
    setTimeout(async () => {
      console.log('\n=== TEST DURATION COMPLETE ===');
      await this.stopPassengerSearch();
      await this.printStatistics();
      process.exit(0);
    }, this.CONFIG.testDuration);
    
    // Handle Ctrl+C
    process.on('SIGINT', async () => {
      console.log('\n\nStopping simulation...');
      await this.stopPassengerSearch();
      await this.printStatistics();
      process.exit(0);
    });
  }

  // Stop passenger search
  async stopPassengerSearch() {
    try {
      if (!this.isSearching || !this.passengerId) return;
      
      console.log('\n=== STOPPING PASSENGER SEARCH ===');
      
      const stopData = {
        userId: this.passengerId,
        userType: 'passenger',
        rideType: 'immediate'
      };
      
      const options = {
        hostname: this.CONFIG.baseUrl,
        port: this.CONFIG.port,
        path: '/api/match/stop-search',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      };
      
      const response = await this.makeRequest(options, stopData);
      
      if (response.statusCode === 200 && response.data.success) {
        console.log('Search stopped successfully');
        this.isSearching = false;
        
        // Clear intervals
        if (this.movementInterval) {
          clearInterval(this.movementInterval);
        }
        
        // Close WebSocket
        if (this.ws && this.websocketConnected) {
          this.ws.close();
        }
      }
      
    } catch (error) {
      console.error('Error stopping search: ' + error.message);
    }
  }

  // Print statistics
  async printStatistics() {
    console.log('\n=== SIMULATION STATISTICS ===');
    console.log('   Successful Searches: ' + this.successfulSearches);
    console.log('   Location Updates Sent: ' + this.locationUpdates);
    console.log('   Matches Found: ' + this.matchesFound);
    console.log('   Final Route Progress: ' + 
      Math.round((this.currentRouteIndex / this.ROUTE_POINTS.length) * 100) + '%');
    console.log('   WebSocket Connected: ' + (this.websocketConnected ? 'Yes' : 'No'));
  }
}

// Run the simulation
const simulation = new MovingPassengerSimulation();
simulation.runSimulation().catch(console.error);
