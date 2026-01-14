#!/usr/bin/env node
const WebSocket = require('ws');
const http = require('http');

// ==================== CONFIGURATION ====================
const CONFIG = {
  hostname: 'localhost',
  port: 3000,
  totalPassengers: 1, // Start with just 1 for debugging
  locationUpdateInterval: 30000,
  testDurationMinutes: 5
};

const PASSENGERS = [
  {
    id: 1,
    name: "Adugna Belay",
    phone: "+251911233344",
    seats: 1,
    color: "🟢",
    driverId: "driver_123", // Need driverId field
    userId: "user_123"      // Need userId field
  }
];

// ==================== DEBUG WEBSOCKET ====================
async function debugWebSocket() {
  console.log('🔍 DEBUGGING WEBSOCKET CONNECTION\n');
  
  const ws = new WebSocket(`ws://${CONFIG.hostname}:${CONFIG.port}`);
  
  ws.on('open', () => {
    console.log('✅ WebSocket opened');
    
    // Try different authentication formats
    const authAttempts = [
      {
        name: 'Format 1 (from Flutter - user_connect)',
        message: {
          type: 'user_connect',
          driverId: PASSENGERS[0].phone,
          driverPhone: PASSENGERS[0].phone,
          searchId: `search_${Date.now()}`,
          userId: PASSENGERS[0].phone,
          isPassenger: true,
          timestamp: Date.now(),
          action: 'start_tracking'
        }
      },
      {
        name: 'Format 2 (simple auth)',
        message: {
          type: 'authenticate',
          userId: PASSENGERS[0].phone,
          userType: 'passenger'
        }
      },
      {
        name: 'Format 3 (just userId)',
        message: {
          userId: PASSENGERS[0].phone
        }
      }
    ];
    
    let attemptIndex = 0;
    
    function sendNextAttempt() {
      if (attemptIndex < authAttempts.length) {
        const attempt = authAttempts[attemptIndex];
        console.log(`\n📤 Attempt ${attemptIndex + 1}: ${attempt.name}`);
        console.log(`   Sending: ${JSON.stringify(attempt.message)}`);
        
        ws.send(JSON.stringify(attempt.message));
        attemptIndex++;
        
        setTimeout(sendNextAttempt, 2000);
      }
    }
    
    sendNextAttempt();
  });
  
  ws.on('message', (data) => {
    console.log(`\n📥 Received: ${data.toString()}`);
  });
  
  ws.on('error', (error) => {
    console.log(`\n❌ Error: ${error.message}`);
  });
  
  ws.on('close', (code, reason) => {
    console.log(`\n🔌 Closed: code=${code}, reason="${reason}"`);
    if (code === 1008) {
      console.log('💡 1008 = Policy Violation - Authentication required or invalid');
    }
  });
}

// ==================== CORRECT IMPLEMENTATION ====================
class PassengerTracker {
  constructor(passenger) {
    this.passenger = passenger;
    this.searchId = null;
    this.ws = null;
    this.connected = false;
    this.locationCount = 0;
    
    console.log(`\n${passenger.color} ${passenger.name}`);
    console.log('─'.repeat(40));
  }
  
  async start() {
    // 1. Send search request
    await this.sendSearch();
    
    // 2. Connect WebSocket with correct authentication
    await this.connectWebSocket();
    
    // 3. Start location updates
    this.startLocationUpdates();
  }
  
  async sendSearch() {
    const pickupLocation = {
      lat: 8.549995 + (this.passenger.id * 0.001),
      lng: 39.266714 + (this.passenger.id * 0.001)
    };
    
    const searchData = {
      userId: this.passenger.phone,
      userType: 'passenger',
      rideType: 'immediate',
      passengerName: this.passenger.name,
      passengerPhone: this.passenger.phone,
      pickup: {
        address: `Adama - ${this.passenger.name}`,
        location: pickupLocation
      },
      dropoff: {
        address: 'Dire Dawa',
        location: { lat: 9.589549, lng: 41.866169 }
      },
      numberOfPassengers: this.passenger.seats
    };
    
    console.log('📤 Sending search request...');
    
    try {
      const response = await this.makeHttpRequest({
        hostname: CONFIG.hostname,
        port: CONFIG.port,
        path: '/api/match/search',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      }, searchData);
      
      if (response.statusCode === 200) {
        console.log('✅ Search successful');
        console.log(`   Search ID: ${response.data.searchId}`);
        this.searchId = response.data.searchId;
        return true;
      } else {
        console.log(`❌ Search failed: ${response.statusCode}`);
        console.log(`   Response: ${JSON.stringify(response.data)}`);
        return false;
      }
    } catch (error) {
      console.log(`❌ Search error: ${error.message}`);
      return false;
    }
  }
  
  async connectWebSocket() {
    return new Promise((resolve) => {
      console.log('\n🔌 Connecting WebSocket...');
      
      this.ws = new WebSocket(`ws://${CONFIG.hostname}:${CONFIG.port}`);
      
      this.ws.on('open', () => {
        console.log('✅ WebSocket connected');
        
        // Send authentication EXACTLY as Flutter does
        // From BackgroundLocationService.dart line 368:
        const authMessage = {
          type: 'user_connect',
          driverId: this.passenger.phone,        // driverId is actually passenger phone
          driverPhone: this.passenger.phone,     // driverPhone is passenger phone
          searchId: this.searchId,               // searchId from search response
          userId: this.passenger.phone,          // userId is passenger phone
          isPassenger: true,                     // CRITICAL: Must be true for passenger
          timestamp: Date.now(),
          action: 'start_tracking'               // From line 369
        };
        
        console.log('\n🔐 Sending authentication:');
        console.log(JSON.stringify(authMessage, null, 2));
        
        this.ws.send(JSON.stringify(authMessage));
        
        // Also send passenger_connect as backup
        setTimeout(() => {
          const passengerConnect = {
            type: 'passenger_connect',
            passengerId: this.passenger.phone,
            passengerName: this.passenger.name,
            searchId: this.searchId,
            timestamp: Date.now()
          };
          
          console.log('\n👤 Sending passenger_connect:');
          console.log(JSON.stringify(passengerConnect, null, 2));
          
          this.ws.send(JSON.stringify(passengerConnect));
        }, 1000);
        
        this.connected = true;
        resolve(true);
      });
      
      this.ws.on('message', (data) => {
        this.handleMessage(data);
      });
      
      this.ws.on('error', (error) => {
        console.log(`❌ WebSocket error: ${error.message}`);
        resolve(false);
      });
      
      this.ws.on('close', (code, reason) => {
        console.log(`🔌 WebSocket closed: code=${code}, reason="${reason}"`);
        this.connected = false;
        
        if (code === 1008) {
          console.log('💡 Server requires different authentication format');
          console.log('💡 Check server logs for expected format');
        }
        
        // Try to reconnect
        setTimeout(() => {
          if (!this.connected) {
            console.log('🔄 Attempting reconnect...');
            this.connectWebSocket();
          }
        }, 5000);
      });
    });
  }
  
  handleMessage(data) {
    try {
      const message = JSON.parse(data);
      console.log(`\n📥 Received: ${message.type}`);
      
      switch (message.type) {
        case 'auth_success':
        case 'authentication_success':
          console.log('✅ Authentication successful!');
          break;
          
        case 'error':
          console.log(`❌ Error: ${message.message}`);
          break;
          
        case 'match_proposal':
          console.log(`🤝 Match proposal: ${JSON.stringify(message, null, 2)}`);
          this.handleMatchProposal(message);
          break;
          
        case 'driver_location':
          if (this.locationCount % 10 === 0) { // Don't spam
            console.log(`📍 Driver location update`);
          }
          break;
          
        default:
          console.log(`📨 Message type: ${message.type}`);
      }
    } catch (error) {
      console.log(`📥 Raw message: ${data.toString().substring(0, 100)}`);
    }
  }
  
  handleMatchProposal(proposal) {
    console.log(`\n🎉 MATCH FOUND!`);
    console.log(`   Match ID: ${proposal.matchId}`);
    console.log(`   Driver: ${proposal.driverName || 'Unknown'}`);
    
    // Auto-accept after 3 seconds
    setTimeout(() => {
      if (this.connected) {
        const acceptMessage = {
          type: 'match_accept',
          passengerId: this.passenger.phone,
          searchId: this.searchId,
          matchId: proposal.matchId,
          timestamp: Date.now()
        };
        
        console.log('\n✅ Accepting match...');
        this.ws.send(JSON.stringify(acceptMessage));
        
        // Switch to fast mode
        this.switchToFastMode();
      }
    }, 3000);
  }
  
  startLocationUpdates() {
    console.log(`\n📍 Starting location updates (30s interval)`);
    
    // Send first update
    this.sendLocationUpdate();
    
    // Set interval
    this.locationTimer = setInterval(() => {
      this.sendLocationUpdate();
    }, CONFIG.locationUpdateInterval);
  }
  
  sendLocationUpdate() {
    if (!this.connected || !this.ws) return;
    
    this.locationCount++;
    
    // Generate moving location
    const location = {
      lat: 8.549995 + (this.passenger.id * 0.001) + (this.locationCount * 0.0001),
      lng: 39.266714 + (this.passenger.id * 0.001) + (this.locationCount * 0.0001),
      accuracy: 10 + Math.random() * 15
    };
    
    // From Flutter: location_update message format
    const locationMessage = {
      type: 'location_update',
      passengerId: this.passenger.phone,
      passengerName: this.passenger.name,
      searchId: this.searchId,
      latitude: location.lat,
      longitude: location.lng,
      accuracy: location.accuracy,
      speed: 20 + Math.random() * 30,
      heading: Math.random() * 360,
      timestamp: Date.now()
    };
    
    try {
      this.ws.send(JSON.stringify(locationMessage));
      
      if (this.locationCount % 5 === 0) {
        console.log(`📍 Update #${this.locationCount}: ${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}`);
      }
      
      // Also send HTTP update
      this.sendHttpLocationUpdate(location);
      
    } catch (error) {
      console.log(`❌ Failed to send location: ${error.message}`);
    }
  }
  
  async sendHttpLocationUpdate(location) {
    try {
      const locationData = {
        userId: this.passenger.phone,
        userType: 'passenger',
        latitude: location.lat,
        longitude: location.lng,
        accuracy: location.accuracy,
        timestamp: Date.now(),
        searchId: this.searchId
      };
      
      // Try different endpoints
      const endpoints = [
        `/api/passenger/location/update`,
        `/api/location/update`,
        `/api/passenger/${this.passenger.phone}/location`
      ];
      
      for (const endpoint of endpoints) {
        try {
          const response = await this.makeHttpRequest({
            hostname: CONFIG.hostname,
            port: CONFIG.port,
            path: endpoint,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          }, locationData);
          
          if (response.statusCode === 200) {
            console.log(`📡 HTTP location sent to ${endpoint}`);
            break;
          }
        } catch (error) {
          // Try next endpoint
        }
      }
    } catch (error) {
      // Silent fail for HTTP updates
    }
  }
  
  switchToFastMode() {
    console.log('\n⚡ Switching to FAST mode (10s updates)');
    
    if (this.locationTimer) {
      clearInterval(this.locationTimer);
    }
    
    this.locationTimer = setInterval(() => {
      this.sendLocationUpdate();
    }, 10000); // 10 seconds
    
    // Send mode change notification
    if (this.connected) {
      const modeMessage = {
        type: 'tracking_mode_changed',
        userId: this.passenger.phone,
        mode: 'fast',
        reason: 'match_accepted',
        timestamp: Date.now()
      };
      
      this.ws.send(JSON.stringify(modeMessage));
    }
  }
  
  makeHttpRequest(options, data = null) {
    return new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        let responseData = '';
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
          try {
            resolve({
              statusCode: res.statusCode,
              data: responseData ? JSON.parse(responseData) : {}
            });
          } catch {
            resolve({
              statusCode: res.statusCode,
              data: responseData
            });
          }
        });
      });
      
      req.on('error', reject);
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Timeout'));
      });
      
      if (data) {
        req.write(JSON.stringify(data));
      }
      req.end();
    });
  }
  
  cleanup() {
    console.log(`\n🧹 Cleaning up ${this.passenger.name}...`);
    
    if (this.locationTimer) {
      clearInterval(this.locationTimer);
    }
    
    if (this.ws) {
      this.ws.close();
    }
  }
}

// ==================== MAIN ====================
async function main() {
  console.log('='.repeat(60));
  console.log('🔍 DEBUG WEBSOCKET AUTHENTICATION');
  console.log('='.repeat(60));
  
  // First, let's debug the WebSocket connection
  await debugWebSocket();
  
  // Wait for debug to complete
  await new Promise(resolve => setTimeout(resolve, 10000));
  
  console.log('\n' + '='.repeat(60));
  console.log('🚀 STARTING PROPER TEST');
  console.log('='.repeat(60));
  
  // Create and start passenger
  const passenger = PASSENGERS[0];
  const tracker = new PassengerTracker(passenger);
  
  await tracker.start();
  
  // Run for specified duration
  if (CONFIG.testDurationMinutes > 0) {
    setTimeout(() => {
      console.log(`\n⏰ Test complete (${CONFIG.testDurationMinutes} minutes)`);
      tracker.cleanup();
      process.exit(0);
    }, CONFIG.testDurationMinutes * 60000);
  }
  
  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log('\n🛑 Stopping test...');
    tracker.cleanup();
    process.exit(0);
  });
  
  console.log('\n✅ Test running. Waiting for WebSocket messages...');
  console.log('   Check server logs for authentication requirements');
}

// Run
if (require.main === module) {
  main().catch(error => {
    console.error('💥 Error:', error);
    process.exit(1);
  });
}
